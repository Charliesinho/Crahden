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

app.use(express.static(path.join(__dirname, 'public')));

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
};

const MONSTER_MIN_MS = 60 * 1000;
const MONSTER_MAX_MS = 5 * 60 * 1000;
const MONSTER_DISPLAY_MS = 20 * 1000;   // visible time
const MONSTER_GRACE_MS = 5 * 1000;      // 5s grace before any death checks begin
const FAKE_JUMP_GRACE_MS = 2 * 1000;    // fakeflodder: die if you haven't jumped in this long
const FIRE_RESCUE_WINDOW_MS = 4 * 1000; // flodder + fire off: time to relight it before everyone dies
const RESPAWN_MS = 5 * 1000;            // respawn delay after death

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

const SHOP_CATALOG = {
  fire: { id: 'fire', name: 'Fire', price: 10, currency: 'logs', x: 200, spriteOn: 'assets/fireOn.gif', spriteOff: 'assets/fireOff.gif', bought: false, contributions: {} },
  house: { id: 'house', name: 'House', price: 10, currency: 'logs', x: 320, sprite: 'assets/house.gif', next: { id: 'house2', priceMultiplier: 2, sprite: 'assets/house2.gif' }, bought: false, contributions: {} },
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
    minigame: null,
  };
}

// Trees
function trySpawnTree(code) {
  const room = rooms[code];
  if (!room || room.trees.length >= CONFIG.MAX_TREES) return;
  const maxX = CONFIG.MAP_SIZE - CONFIG.TREE_SIZE - CONFIG.TREE_MARGIN;
  const x = Math.floor(CONFIG.TREE_MARGIN + Math.random() * (maxX - CONFIG.TREE_MARGIN));
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

function spawnMonster(code) {
  const room = rooms[code];
  if (!room) return;
  const type = Math.random() < 0.6 ? 'flodder' : 'fakeflodder';
  const now = Date.now();
  room.monsterActive = {
    type,
    startedAt: now,
    graceEndsAt: now + MONSTER_GRACE_MS,
    movementKillsActive: false,  // flodder only: becomes true once grace passes, if the fire is on
    fireRescueWindowOpen: false, // flodder only: true while waiting to see if someone relights the fire
  };

  io.to(code).emit('monsterSpawn', { type, duration: MONSTER_DISPLAY_MS, grace: MONSTER_GRACE_MS });
  sysMsg(code, type === 'flodder'
    ? 'A flodder appears! Stay by the fire, and don\'t move once it settles in...'
    : 'A strange shadow appears... keep jumping, or it will get you!');

  if (type === 'flodder') {
    room.monsterActive.graceTimer = setTimeout(() => resolveFlodderFireCheck(code), MONSTER_GRACE_MS);
  } else {
    room.monsterActive.jumpCheckInterval = setInterval(() => checkFakeflodderDeaths(code), 400);
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

function endMonsterEvent(code) {
  const room = rooms[code];
  if (!room || !room.monsterActive) return;
  const ma = room.monsterActive;
  if (ma.jumpCheckInterval) clearInterval(ma.jumpCheckInterval);
  if (ma.graceTimer) clearTimeout(ma.graceTimer);
  if (ma.rescueTimer) clearTimeout(ma.rescueTimer);
  if (ma.endTimer) clearTimeout(ma.endTimer);
  room.monsterActive = null;
  scheduleMonsterForRoom(code);
}

function killPlayerInRoom(code, pid, cause) {
  const room = rooms[code];
  if (!room || !room.players[pid]) return;
  const p = room.players[pid];
  if (p.dead) return;
  p.dead = true;

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
      if (itemId === 'house' && item.next) {
        const next = {
          id: item.next.id,
          name: item.next.id,
          price: item.price * item.next.priceMultiplier,
          currency: item.currency,
          sprite: item.next.sprite,
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

  socket.on('startMinigame', ({ type } = {}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    if (room.minigame) return;

    const mg = { type, startedAt: Date.now(), players: {}, state: {} };
    let publicState = {};
    if (type === 'guessWord') {
      const words = ['apple', 'river', 'cabin', 'flame', 'stone', 'ghost', 'music'];
      mg.state.word = words[Math.floor(Math.random() * words.length)]; // kept server-side only
      publicState = { masked: mg.state.word.replace(/./g, '_ ').trim(), length: mg.state.word.length };
    } else if (type === 'rhythm') {
      const seq = Array.from({ length: 6 }, () => (Math.random() < 0.5 ? 0 : 1));
      mg.state.sequence = seq;
      publicState = { sequence: seq }; // the sequence itself IS the clue (played back client-side), safe to send
    } else return;

    room.minigame = mg;
    io.to(code).emit('minigameStarted', { type, state: publicState });
  });

  socket.on('minigameSubmit', ({ attempt } = {}) => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room || !room.minigame) return;
    const mg = room.minigame;
    const player = room.players[socket.id];
    if (!player) return;

    let success = false;
    if (mg.type === 'guessWord') {
      if (String(attempt || '').toLowerCase() === mg.state.word) success = true;
    } else if (mg.type === 'rhythm') {
      if (Array.isArray(attempt) && attempt.length === mg.state.sequence.length) {
        success = attempt.every((v, i) => Number(v) === Number(mg.state.sequence[i]));
      }
    }

    if (success) {
      io.to(code).emit('minigameEnded', { winnerId: socket.id, type: mg.type });
      io.to(code).emit('grantResearchXp', { id: socket.id, xp: 10 });
      room.minigame = null;
    } else {
      socket.emit('minigameFail', { reason: 'incorrect' });
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.room;
    const room = rooms[code];
    if (!room) return;
    delete room.players[socket.id];
    io.to(code).emit('playerLeft', socket.id);
    if (Object.keys(room.players).length === 0) {
      if (room.monsterTimer) clearTimeout(room.monsterTimer);
      delete rooms[code];
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});