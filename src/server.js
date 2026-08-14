// ============================================================
// SERVER — Express + Socket.IO
// Updated: fakeflodder waits grace period before checking stationary players.
// Players are marked dead server-side and respawn after RESPAWN_MS.
// ============================================================
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Config (keep in sync with client) ----
const CONFIG = {
  MAP_SIZE: 500,
  CHAR_WIDTH: 90,
  TREE_SIZE: 90,
  TREE_MARGIN: 20,
  MAX_TREES: 1,
  TREE_SPAWN_INTERVAL: 60000,
  TREE_HITS_TO_DEPLETE: 20,
  ROOM_CODE_LENGTH: 5,
  CHAT_MAX_LENGTH: 140,
  LAKE: { x: 25, width: 120 }, // static, must match CONFIG.LAKE in public/index.js — trees avoid this range
};

const MONSTER_MIN_MS = 60 * 1000;
const MONSTER_MAX_MS = 5 * 60 * 1000;
const MONSTER_DISPLAY_MS = 20 * 1000;   // visible time
const MONSTER_GRACE_MS = 5 * 1000;      // 5s grace before any death checks begin
const FAKE_JUMP_GRACE_MS = 2 * 1000;    // fakeflodder: die if you haven't jumped in this long
const FIRE_RESCUE_WINDOW_MS = 4 * 1000; // flodder + fire off: time to relight it before everyone dies
const RESPAWN_MS = 30 * 1000;           // respawn delay after death
const WORREN_ZONE_LO = 0.25;            // worren: danger zone is the middle 2/4 of the map (25%-75%)
const WORREN_ZONE_HI = 0.75;

const HOUSE_HIDE_MS = 5 * 60 * 1000;    // /house: how long you stay hidden/safe if you let it run out
const HOUSE_COOLDOWN_MS = 20 * 60 * 1000; // /house: minimum time between starting a hide

const LAVA_MIN_MS = 5 * 60 * 1000;      // lava floor: random every 5-20 minutes
const LAVA_MAX_MS = 20 * 60 * 1000;
const LAVA_DISPLAY_MS = 15 * 1000;      // how long the lava stays
const LAVA_GRACE_MS = 3 * 1000;         // warning time before it actually starts killing

const rooms = {};
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms[code]);
  return code;
}

function makePlayer(username) {
  return {
    x: Math.floor(Math.random() * (CONFIG.MAP_SIZE - CONFIG.CHAR_WIDTH)),
    y: 0,
    facing: 'right',
    state: 'idle',
    outfit: null,
    username: String(username || 'Player').slice(0, 14),
  };
}

// ------------------------------------------------------------
// Room decorations available in the shop's "contribute" tab.
// To add a new one: copy an entry, give it a unique id, and set:
//   price / currency  — currency can be ANY inventory item id the
//                        client tracks (logs, fish, fish2, fish3, ...)
//   x, y, width, height — its exact placement/size on the map, in
//                        the same logical units as CONFIG.MAP_SIZE
//                        (y is how far ABOVE the ground it sits; 0 = on the ground)
//   sprite             — for a static decoration, OR
//   spriteOn/spriteOff — for a toggleable one (see "fire" below)
//   next               — optional: unlocks a follow-up item once this
//                        one is bought (see "house" below). Any of
//                        price/x/y/width/height can be overridden for
//                        the next tier; anything omitted is inherited.
// ------------------------------------------------------------
const SHOP_CATALOG = {
  fire: {
    id: 'fire', name: 'Fire', price: 10, currency: 'logs',
    x: 195, y: 0.2, width: 110, height: 110,
    spriteOn: 'assets/fireOn.gif', spriteOff: 'assets/fireOff.gif',
    bought: false, contributions: {},
  },
  house: {
    id: 'house', name: 'House', price: 10, currency: 'logs',
    x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
    sprite: 'assets/house.gif',
    next: { id: 'house2', priceMultiplier: 2, sprite: 'assets/house2.gif' },
    bought: false, contributions: {},
  },
  lamp: {
    id: 'lamp', name: 'Lamp', price: 10, currency: 'logs',
    x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
    sprite: 'assets/lamp.gif',
    bought: false, contributions: {},
  },
  wall: {
    id: 'wall', name: 'Wall', price: 10, currency: 'logs',
    x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
    sprite: 'assets/wall.gif',
    bought: false, contributions: {},
  },
  farm: {
    id: 'farm', name: 'Farm', price: 10, currency: 'logs',
    x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
    sprite: 'assets/farm.gif',
    bought: false, contributions: {},
  },
  platform: {
    id: 'platform', name: 'Platform', price: 10, currency: 'logs',
    x: 150, y: 7.2, width: 75, height: 75, // matches: left 30%, bottom 18.8%, width/height 15% of the map
    surfaceOffset: -15, // nudge the walkable top surface up(+)/down(-) if it doesn't line up with the sprite's art
    sprite: 'assets/platform.gif',
    isPlatform: true, // marks this (and any future item like it) as safe ground during a lava event AND solid-on-top for landing
    bought: false, contributions: {},
  },
};

function createRoomState() {
  const purchasableItems = {};
  Object.entries(SHOP_CATALOG).forEach(([k, v]) => {
    purchasableItems[k] = JSON.parse(JSON.stringify(v));
    purchasableItems[k].contributions = {};
    purchasableItems[k].bought = false;
  });

  return {
    players: {},
    trees: [],
    nextTreeId: 1,
    purchasableItems,
    fireOn: false,
    monsterTimer: null,
    monsterActive: null, // { type, startedAt, endsAt }
    lavaTimer: null,
    lavaActive: null,    // { startedAt, graceEndsAt }
  };
}

// Trees — picks a spot that doesn't overlap the (static) lake, retrying a
// few times before falling back to whatever the last attempt landed on.
function pickTreeX() {
  const maxX = CONFIG.MAP_SIZE - CONFIG.TREE_SIZE - CONFIG.TREE_MARGIN;
  const lakeLeft = CONFIG.LAKE.x - CONFIG.TREE_MARGIN;
  const lakeRight = CONFIG.LAKE.x + CONFIG.LAKE.width + CONFIG.TREE_MARGIN;

  let x;
  for (let attempt = 0; attempt < 20; attempt++) {
    x = Math.floor(CONFIG.TREE_MARGIN + Math.random() * (maxX - CONFIG.TREE_MARGIN));
    const overlapsLake = x + CONFIG.TREE_SIZE > lakeLeft && x < lakeRight;
    if (!overlapsLake) return x;
  }
  return x; // extremely unlikely to be reached, but avoids ever hanging
}

function trySpawnTree(code) {
  const room = rooms[code];
  if (!room || room.trees.length >= CONFIG.MAX_TREES) return;
  const x = pickTreeX();
  room.trees.push({ id: room.nextTreeId++, x, hits: 0 });
  io.to(code).emit('treesUpdate', room.trees);
}
setInterval(() => Object.keys(rooms).forEach(trySpawnTree), CONFIG.TREE_SPAWN_INTERVAL);

// Monster scheduling
function scheduleMonsterForRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.monsterTimer) clearTimeout(room.monsterTimer);
  const delay = MONSTER_MIN_MS + Math.floor(Math.random() * (MONSTER_MAX_MS - MONSTER_MIN_MS));
  room.monsterTimer = setTimeout(() => spawnMonster(code), delay);
}

function sysMsg(code, text) {
  io.to(code).emit('playerChat', { id: 'system', username: 'System', text });
}

const MONSTER_TYPES = ['flodder', 'fakeflodder', 'worren']; // add more ids here later
const MONSTER_SPAWN_MESSAGES = {
  flodder: 'A flodder appears! Stay by the fire, and don\'t move once it settles in...',
  fakeflodder: 'A strange shadow appears... keep jumping, or it will get you!',
  worren: 'A worren appears! Get to the sides of the map — the middle isn\'t safe!',
};

function spawnMonster(code) {
  const room = rooms[code];
  if (!room) return;
  const type = MONSTER_TYPES[Math.floor(Math.random() * MONSTER_TYPES.length)];
  const now = Date.now();
  room.monsterActive = {
    type,
    startedAt: now,
    graceEndsAt: now + MONSTER_GRACE_MS,
    movementKillsActive: false,  // flodder only: becomes true once grace passes, if the fire is on
    fireRescueWindowOpen: false, // flodder only: true while waiting to see if someone relights the fire
  };

  io.to(code).emit('monsterSpawn', { type, duration: MONSTER_DISPLAY_MS, grace: MONSTER_GRACE_MS });
  sysMsg(code, MONSTER_SPAWN_MESSAGES[type] || 'Something appears...');

  if (type === 'flodder') {
    room.monsterActive.graceTimer = setTimeout(() => resolveFlodderFireCheck(code), MONSTER_GRACE_MS);
  } else if (type === 'fakeflodder') {
    room.monsterActive.jumpCheckInterval = setInterval(() => checkFakeflodderDeaths(code), 400);
  } else if (type === 'worren') {
    room.monsterActive.zoneCheckInterval = setInterval(() => checkWorrenDeaths(code), 400);
  }

  room.monsterActive.endTimer = setTimeout(() => endMonsterEvent(code), MONSTER_DISPLAY_MS);
}

// Called once, exactly when the grace period for a real flodder ends.
function resolveFlodderFireCheck(code) {
  const room = rooms[code];
  const ma = room && room.monsterActive;
  if (!ma || ma.type !== 'flodder') return;

  if (room.fireOn) {
    // Fire protects everyone from the flodder itself — but moving now gives you away.
    ma.movementKillsActive = true;
    sysMsg(code, 'The fire holds it back... but don\'t move!');
  } else {
    // No fire = no protection. Give the room a few seconds to relight it.
    ma.fireRescueWindowOpen = true;
    sysMsg(code, 'The fire is out! Someone light it now, or everyone dies!');
    ma.rescueTimer = setTimeout(() => {
      if (!ma.fireRescueWindowOpen) return; // already saved (or event already ended)
      ma.fireRescueWindowOpen = false;
      sysMsg(code, 'Nobody lit the fire in time...');
      Object.keys(room.players).forEach((pid) => killPlayerInRoom(code, pid, 'the flodder'));
    }, FIRE_RESCUE_WINDOW_MS);
  }
}

// Polled while a fakeflodder is active (after its own grace period).
function checkFakeflodderDeaths(code) {
  const room = rooms[code];
  const ma = room && room.monsterActive;
  if (!ma || ma.type !== 'fakeflodder') return;
  const now = Date.now();
  if (now < ma.graceEndsAt) return;

  Object.entries(room.players).forEach(([pid, p]) => {
    if (p.dead) return;
    const lastJump = p.lastJumpAt || ma.startedAt;
    if (now - lastJump > FAKE_JUMP_GRACE_MS) {
      killPlayerInRoom(code, pid, 'the flodder');
    }
  });
}

// Polled while a worren is active (after its own grace period). Anyone
// standing in the middle 2 of the map's 4 quarters (25%-75% from center) dies.
function checkWorrenDeaths(code) {
  const room = rooms[code];
  const ma = room && room.monsterActive;
  if (!ma || ma.type !== 'worren') return;
  const now = Date.now();
  if (now < ma.graceEndsAt) return;

  const loX = CONFIG.MAP_SIZE * WORREN_ZONE_LO;
  const hiX = CONFIG.MAP_SIZE * WORREN_ZONE_HI;
  Object.entries(room.players).forEach(([pid, p]) => {
    if (p.dead || p.hiding) return;
    const center = (p.x || 0) + CONFIG.CHAR_WIDTH / 2;
    if (center > loX && center < hiX) {
      killPlayerInRoom(code, pid, 'the worren');
    }
  });
}

function endMonsterEvent(code) {
  const room = rooms[code];
  if (!room || !room.monsterActive) return;
  const ma = room.monsterActive;
  if (ma.jumpCheckInterval) clearInterval(ma.jumpCheckInterval);
  if (ma.zoneCheckInterval) clearInterval(ma.zoneCheckInterval);
  if (ma.graceTimer) clearTimeout(ma.graceTimer);
  if (ma.rescueTimer) clearTimeout(ma.rescueTimer);
  if (ma.endTimer) clearTimeout(ma.endTimer);
  room.monsterActive = null;
  scheduleMonsterForRoom(code);
}

// ------------------------------------------------------------
// Lava floor — separate from the monster rotation, on its own 5-20 minute
// timer. Anyone not standing on a purchased "isPlatform" item (see
// SHOP_CATALOG) dies once the grace period ends; no platform bought at all
// means nobody has anywhere safe to stand.
// ------------------------------------------------------------
function scheduleLavaForRoom(code) {
  const room = rooms[code];
  if (!room) return;
  if (room.lavaTimer) clearTimeout(room.lavaTimer);
  const delay = LAVA_MIN_MS + Math.floor(Math.random() * (LAVA_MAX_MS - LAVA_MIN_MS));
  room.lavaTimer = setTimeout(() => spawnLava(code), delay);
}

function spawnLava(code) {
  const room = rooms[code];
  if (!room || room.lavaActive) return;
  const now = Date.now();
  room.lavaActive = { startedAt: now, graceEndsAt: now + LAVA_GRACE_MS };

  io.to(code).emit('lavaSpawn', { duration: LAVA_DISPLAY_MS, grace: LAVA_GRACE_MS });
  sysMsg(code, 'The floor is turning to lava! Get on a platform!');

  room.lavaActive.checkInterval = setInterval(() => checkLavaDeaths(code), 400);
  room.lavaActive.endTimer = setTimeout(() => endLavaEvent(code), LAVA_DISPLAY_MS);
}

function checkLavaDeaths(code) {
  const room = rooms[code];
  const la = room && room.lavaActive;
  if (!la) return;
  const now = Date.now();
  if (now < la.graceEndsAt) return;

  const platforms = Object.values(room.purchasableItems).filter((it) => it.isPlatform && it.bought);
  Object.entries(room.players).forEach(([pid, p]) => {
    if (p.dead || p.hiding) return;
    const center = (p.x || 0) + CONFIG.CHAR_WIDTH / 2;
    const safe = platforms.some((pl) => center >= pl.x && center <= pl.x + pl.width);
    if (!safe) killPlayerInRoom(code, pid, 'the lava');
  });
}

function endLavaEvent(code) {
  const room = rooms[code];
  if (!room || !room.lavaActive) return;
  const la = room.lavaActive;
  if (la.checkInterval) clearInterval(la.checkInterval);
  if (la.endTimer) clearTimeout(la.endTimer);
  room.lavaActive = null;
  scheduleLavaForRoom(code);
}

function killPlayerInRoom(code, pid, cause) {
  const room = rooms[code];
  if (!room || !room.players[pid]) return;
  const p = room.players[pid];
  if (p.dead || p.hiding) return; // hiding via /house makes you immune to every monster
  p.dead = true; // <-- this line was missing, which let every poll tick re-kill + re-message + re-teleport the same player

  // Notify clients
  io.to(code).emit('playerDied', { id: pid, cause });

  io.to(code).emit('playerChat', { id: 'system', username: 'System', text: `${p.username} died from ${cause}` });

  // Respawn after RESPAWN_MS
  setTimeout(() => {
    if (!room.players[pid]) return;
    room.players[pid].dead = false;
    room.players[pid].x = Math.floor(Math.random() * (CONFIG.MAP_SIZE - CONFIG.CHAR_WIDTH));
    room.players[pid].y = 0;
    io.to(code).emit('playerRespawn', { id: pid, player: room.players[pid] });
  }, RESPAWN_MS);
}

function houseIsPresent(room) {
  return !!(room.purchasableItems.house?.bought || room.purchasableItems.house2?.bought);
}

// /house — hide (and become immune to every monster) for up to 5 minutes,
// or type it again to come back out early. Starting a hide has a 20-minute
// cooldown; ending one early does not.
function startHiding(code, socketId) {
  const room = rooms[code];
  const p = room && room.players[socketId];
  if (!p) return;

  if (!houseIsPresent(room)) {
    socket_privateMsg(socketId, 'There\'s no house in this room yet — someone needs to fund one in the shop.');
    return;
  }
  const now = Date.now();
  const remaining = HOUSE_COOLDOWN_MS - (now - (p.lastHouseUseAt || 0));
  if (remaining > 0) {
    const mins = Math.ceil(remaining / 60000);
    socket_privateMsg(socketId, `You can't hide again yet — try again in about ${mins} minute${mins === 1 ? '' : 's'}.`);
    return;
  }

  p.hiding = true;
  p.lastHouseUseAt = now;
  io.to(code).emit('playerHiding', { id: socketId, hiding: true });
  sysMsg(code, `${p.username} ducks into the house.`);

  p.hideTimer = setTimeout(() => stopHiding(code, socketId, true), HOUSE_HIDE_MS);
}

function stopHiding(code, socketId, viaTimeout) {
  const room = rooms[code];
  const p = room && room.players[socketId];
  if (!p || !p.hiding) return;

  p.hiding = false;
  if (p.hideTimer) { clearTimeout(p.hideTimer); p.hideTimer = null; }
  p.x = Math.floor(Math.random() * (CONFIG.MAP_SIZE - CONFIG.CHAR_WIDTH));
  p.y = 0;

  io.to(code).emit('playerHiding', { id: socketId, hiding: false, player: p });
  sysMsg(code, viaTimeout ? `${p.username} comes back out.` : `${p.username} steps out of the house.`);
}

// A chat line visible only to the sender (used for /house feedback).
function socket_privateMsg(socketId, text) {
  io.to(socketId).emit('playerChat', { id: 'system', username: 'System', text });
}

// Socket handlers
io.on('connection', (socket) => {
  function enterRoom(code, username) {
    socket.data.room = code;
    socket.join(code);

    const room = rooms[code];
    room.players[socket.id] = makePlayer(username);

    // per-player flags used by the monster-event logic
    room.players[socket.id].dead = false;
    room.players[socket.id].lastJumpAt = Date.now();
    room.players[socket.id].hiding = false;
    room.players[socket.id].hideTimer = null;
    room.players[socket.id].lastHouseUseAt = 0;

    socket.emit('roomJoined', {
      code,
      id: socket.id,
      players: room.players,
      trees: room.trees,
      purchasableItems: room.purchasableItems,
      fireOn: room.fireOn,
    });

    socket.to(code).emit('playerJoined', { id: socket.id, player: room.players[socket.id] });

    if (!room.monsterTimer) scheduleMonsterForRoom(code);
    if (!room.lavaTimer) scheduleLavaForRoom(code);
  }

  socket.on('createRoom', ({ username } = {}) => {
    const code = generateRoomCode();
    rooms[code] = createRoomState();
    enterRoom(code, username);
  });

  socket.on('joinRoom', ({ code, username } = {}) => {
    const roomCode = String(code || '').toUpperCase().trim();
    if (!rooms[roomCode]) {
      socket.emit('roomError', 'Room not found. Check the code and try again.');
      return;
    }
    enterRoom(roomCode, username);
  });

  socket.on('spawnMonsterNow', () => {
    const code = socket.data.room;
    if (!code) return;
    spawnMonster(code);
  });

  // update: accepts movedDuringMonster, isJumping, isMoving
  socket.on('update', (data) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;

    room.players[socket.id] = { ...room.players[socket.id], ...data };
    const p = room.players[socket.id];

    if (data.isJumping) p.lastJumpAt = Date.now(); // used by the fakeflodder check above

    // Real flodder: once movementKillsActive is true (fire held it back, grace passed),
    // moving even a little is instant death.
    const ma = room.monsterActive;
    if (ma && ma.type === 'flodder' && ma.movementKillsActive && !p.dead && data.isMoving) {
      killPlayerInRoom(code, socket.id, 'the flodder');
    }

    socket.to(code).emit('playerUpdated', { id: socket.id, player: room.players[socket.id] });
  });

  socket.on('emoji', (emoji) => {
    const code = socket.data.room;
    if (!code) return;
    socket.to(code).emit('playerEmoji', { id: socket.id, emoji });
  });

  socket.on('chopTree', ({ treeId } = {}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const tree = room.trees.find((t) => t.id === treeId);
    if (!tree) return;
    tree.hits += 1;
    if (tree.hits >= CONFIG.TREE_HITS_TO_DEPLETE) room.trees = room.trees.filter((t) => t.id !== treeId);
    io.to(code).emit('treesUpdate', room.trees);
  });

  socket.on('chatMessage', (text) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const trimmed = String(text || '').slice(0, CONFIG.CHAT_MAX_LENGTH).trim();
    if (!trimmed) return;

    if (trimmed.toLowerCase() === '/house') {
      const p = room.players[socket.id];
      if (p.hiding) stopHiding(code, socket.id, false);
      else startHiding(code, socket.id);
      return; // commands never go out as a normal chat line
    }

    io.to(code).emit('playerChat', { id: socket.id, username: room.players[socket.id].username, text: trimmed });
  });

  socket.on('contribute', ({ itemId, amount } = {}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const item = room.purchasableItems[itemId];
    if (!item) return;
    const player = room.players[socket.id];
    if (!player) return;

    item.contributions[socket.id] = (item.contributions[socket.id] || 0) + (amount || 0);
    const total = Object.values(item.contributions).reduce((a, b) => a + (b || 0), 0);
    io.to(code).emit('contributionUpdate', { itemId, total, needed: item.price });

    if (total >= item.price && !item.bought) {
      item.bought = true;
      if (itemId === 'fire') room.fireOn = true;
      if (item.next && item.next.id && item.next.id !== itemId) {
        const n = item.next;
        const next = {
          id: n.id,
          name: n.name || n.id,
          price: n.price != null ? n.price : item.price * (n.priceMultiplier || 1),
          currency: n.currency || item.currency,
          x: n.x != null ? n.x : item.x,
          y: n.y != null ? n.y : item.y,
          width: n.width != null ? n.width : item.width,
          height: n.height != null ? n.height : item.height,
          sprite: n.sprite,
          next: n.next || null, // supports chaining a 3rd tier, etc.
          contributions: {},
          bought: false,
        };
        room.purchasableItems[next.id] = next;
      }
      io.to(code).emit('itemBought', { itemId, item: room.purchasableItems[itemId] });
    }
  });

  socket.on('toggleFire', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;

    const turningOn = !room.fireOn;
    room.fireOn = turningOn;
    io.to(code).emit('fireToggled', { fireOn: room.fireOn });

    // Only dangerous in one specific situation: a real flodder is out, the fire
    // was off, and we're in the short rescue window after the grace period.
    // Relighting it there saves everyone else — at the cost of whoever did it.
    const ma = room.monsterActive;
    if (turningOn && ma && ma.type === 'flodder' && ma.fireRescueWindowOpen) {
      ma.fireRescueWindowOpen = false;
      if (ma.rescueTimer) clearTimeout(ma.rescueTimer);
      const name = room.players[socket.id]?.username || 'Someone';
      sysMsg(code, `${name} relit the fire and saved everyone else... at a cost.`);
      killPlayerInRoom(code, socket.id, 'the flodder (relit the fire)');
    }
  });

  socket.on('spawnLavaNow', () => {
    const code = socket.data.room;
    if (!code) return;
    spawnLava(code);
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    const p = room.players[socket.id];
    if (p?.hideTimer) clearTimeout(p.hideTimer);
    delete room.players[socket.id];
    io.to(code).emit('playerLeft', socket.id);
    if (Object.keys(room.players).length === 0) {
      if (room.monsterTimer) clearTimeout(room.monsterTimer);
      if (room.lavaTimer) clearTimeout(room.lavaTimer);
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});