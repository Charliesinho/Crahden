// ============================================================
// CLIENT — index.js
// Updated: fakeflodder waits 5s before checking; dead sprite + movement lock while dead.
// Ensure public/assets/dead.gif exists.
// ============================================================
const CONFIG = {
  MAP_SIZE: 500,
  GROUND_HEIGHT: 86.8,
  CHAR_WIDTH: 90,
  CHAR_HEIGHT: 90,
  MOVE_SPEED: 3,
  JUMP_FORCE: 15,
  GRAVITY: 0.8,
  SEND_RATE: 50,

  TREE_SIZE: 90,
  LAKE: { x: 25, width: 120, height: 80 },

  INTERACT_RANGE: 60,
  INTERACT_COOLDOWN: 350,

  XP_PER_ACTION: 5,
  XP_PER_LEVEL: 20,
  INVENTORY_SLOTS: 8,

  CHAT_BUBBLE_DURATION: 3500,

  SPRITES: {
    background: 'assets/background.gif',
    idle: 'assets/idle.gif',
    walk: 'assets/walk.gif',
    jump: 'assets/jump.gif',
    tree: 'assets/tree.png',
    lake: 'assets/lake.gif',
    fish: 'assets/fish.png',
    fish2: 'assets/fish2.png',
    fish3: 'assets/fish3.png',
    logs: 'assets/logs.png',
    fireOn: 'assets/fireOn.gif',
    fireOff: 'assets/fireOff.gif',
    house: 'assets/house.gif',
    house2: 'assets/house2.gif',
    dead: 'assets/dead.gif',
  },

  OUTFITS: {
    knight: { name: 'Knight', price: 50, currency: 'logs' },
    goblin: { name: 'Goblin', price: 500, currency: 'fish' },
    demon: { name: 'Demon', price: 500, currency: 'logs' },
  },

  SHOP_CATALOG: {
    fire: { id: 'fire', name: 'Fire', price: 1000, currency: 'logs', spriteOn: 'assets/fireOn.gif', spriteOff: 'assets/fireOff.gif', x: 200 },
    house: { id: 'house', name: 'House', price: 1000, currency: 'logs', sprite: 'assets/house.gif', x: 320 },
  },

  MONSTER_SPRITES: { flodder: 'assets/flodder.gif', fakeflodder: 'assets/fakeflodder.gif' },
  MONSTER_SLIDE_DURATION: 1000,
  MONSTER_STAY_MS: 20000,

  MINIGAME_REWARD_XP: 10,
};

function pct(value) { return `${(value / CONFIG.MAP_SIZE) * 100}%`; }
function outfitSprite(state, outfitId) { return `assets/${state}${outfitId}.gif`; }

const socket = io("https://crahden.up.railway.app/", {
  transports: ["websocket"],
  withCredentials: true   // <--- important
});
const mapEl = document.getElementById('map');
const groundEl = document.getElementById('ground');

mapEl.style.backgroundImage = `url(${CONFIG.SPRITES.background})`;
groundEl.style.height = pct(CONFIG.GROUND_HEIGHT);

let myId = null;
let roomCode = null;
let localEl = null;
const remoteEls = {};

let clientShop = {};
let clientFireOn = false;
const mapItemsEls = {};

const localPlayer = { x: 0, y: 0, vy: 0, onGround: true, facing: 'right', state: 'idle', username: '', outfit: null };

let trees = [];
const treeEls = {};

let clientShopTotals = {};

const lobbyEl = document.getElementById('lobby');
const appEl = document.getElementById('app');
const usernameInput = document.getElementById('username-input');
const roomCodeInput = document.getElementById('room-code-input');
const lobbyError = document.getElementById('lobby-error');
const chatInput = document.getElementById('chat-input');
const chatLog = document.getElementById('chat-log');

document.getElementById('create-room-btn').addEventListener('click', () => {
  const username = usernameInput.value.trim() || 'Player';
  socket.emit('createRoom', { username });
});
document.getElementById('join-room-btn').addEventListener('click', () => {
  const username = usernameInput.value.trim() || 'Player';
  const code = roomCodeInput.value.trim();
  if (!code) { lobbyError.textContent = 'Enter a room code'; return; }
  socket.emit('joinRoom', { code, username });
});

socket.on('roomError', (message) => { lobbyError.textContent = message; });

socket.on('roomJoined', ({ code, id, players, trees: initialTrees, purchasableItems, fireOn }) => {
  roomCode = code; myId = id;
  lobbyEl.classList.add('hidden'); appEl.classList.remove('hidden');
  document.getElementById('room-code-badge').textContent = `Room: ${code}`;

  const me = players[id];
  localPlayer.x = me.x; localPlayer.username = me.username;
  localEl = createPlayerEl(me.username);

  for (const pid in players) {
    if (pid === id) continue;
    remoteEls[pid] = createPlayerEl(players[pid].username);
    updatePlayerEl(remoteEls[pid], players[pid]);
  }

  trees = initialTrees || [];
  renderTrees();

  clientShop = purchasableItems || JSON.parse(JSON.stringify(CONFIG.SHOP_CATALOG));
  clientFireOn = !!fireOn;
  Object.entries(clientShop).forEach(([k, v]) => {
    clientShopTotals[k] = Object.values(v.contributions || {}).reduce((a,b)=>a+(b||0),0);
  });

  renderShop();
  renderMapItems();
});

document.getElementById('room-code-badge').addEventListener('click', () => {
  if (roomCode) navigator.clipboard?.writeText(roomCode);
});

const keys = { ArrowLeft: false, ArrowRight: false, ArrowUp: false };
let isDead = false;

window.addEventListener('keydown', (e) => {
  if (document.activeElement === chatInput) return;
  if (isDead) return; // block controls while dead
  if (e.key in keys) { keys[e.key] = true; e.preventDefault(); }
  if ((e.key === 'e' || e.key === 'E') && !e.repeat) tryInteract();
});
window.addEventListener('keyup', (e) => {
  if (e.key in keys) { keys[e.key] = false; e.preventDefault(); }
});

function bindTouchButton(id, key) {
  const btn = document.getElementById(id);
  const press = (e) => { e.preventDefault(); if (!isDead) keys[key] = true; };
  const release = (e) => { e.preventDefault(); keys[key] = false; };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
}
bindTouchButton('btn-left', 'ArrowLeft');
bindTouchButton('btn-right', 'ArrowRight');
bindTouchButton('btn-jump', 'ArrowUp');
document.getElementById('btn-interact').addEventListener('pointerdown', (e) => { e.preventDefault(); if (!isDead) tryInteract(); });

document.querySelectorAll('.tab-icon-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-icon-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-pane').forEach((pane) => {
      pane.classList.toggle('active', pane.dataset.pane === target);
    });
  });
});

function createPlayerEl(username) {
  const el = document.createElement('div');
  el.className = 'player';
  el.style.width = pct(CONFIG.CHAR_WIDTH);
  el.style.height = pct(CONFIG.CHAR_HEIGHT);
  el.style.backgroundImage = `url(${CONFIG.SPRITES.idle})`;
  const tag = document.createElement('div');
  tag.className = 'nametag';
  tag.textContent = username;
  el.appendChild(tag);
  mapEl.appendChild(el);
  return el;
}

function spriteFor(player, deadFlag) {
  if (deadFlag) return CONFIG.SPRITES.dead;
  return player.outfit ? outfitSprite(player.state, player.outfit) : CONFIG.SPRITES[player.state];
}

function updatePlayerEl(el, player) {
  const deadFlag = !!player.dead;
  el.style.left = pct(player.x);
  el.style.bottom = pct(CONFIG.GROUND_HEIGHT + player.y);
  el.style.backgroundImage = `url(${spriteFor(player, deadFlag)})`;
  el.classList.toggle('facing-left', player.facing === 'left');
  el.classList.toggle('dead', deadFlag);
}

socket.on('playerJoined', ({ id, player }) => {
  remoteEls[id] = createPlayerEl(player.username);
  updatePlayerEl(remoteEls[id], player);
});

socket.on('playerUpdated', ({ id, player }) => {
  if (remoteEls[id]) updatePlayerEl(remoteEls[id], player);
});

socket.on('playerLeft', (id) => {
  if (remoteEls[id]) { remoteEls[id].remove(); delete remoteEls[id]; }
});

socket.on('playerEmoji', ({ id, emoji }) => {
  const el = remoteEls[id];
  if (el) showFloatingEmoji(el, emoji);
});

chatInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chatMessage', text);
  chatInput.value = '';
});

socket.on('playerChat', ({ id, username, text }) => {
  appendChatLog(username, text);
  const el = id === myId ? localEl : remoteEls[id];
  if (el) showChatBubble(el, text);
});

function appendChatLog(username, text) {
  const line = document.createElement('div');
  line.className = 'chat-line';
  line.innerHTML = `<span class="chat-username">${username}:</span>${text}`;
  chatLog.appendChild(line);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function showChatBubble(playerEl, text) {
  if (!playerEl) return;
  const existing = playerEl.querySelector('.chat-bubble');
  if (existing) existing.remove();
  const bubble = document.createElement('div');
  bubble.className = 'chat-bubble';
  bubble.textContent = text;
  playerEl.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add('show'));
  setTimeout(() => { bubble.classList.remove('show'); setTimeout(() => bubble.remove(), 250); }, CONFIG.CHAT_BUBBLE_DURATION);
}

function renderTrees() {
  for (const id in treeEls) {
    if (!trees.find((t) => String(t.id) === id)) {
      treeEls[id].remove();
      delete treeEls[id];
    }
  }
  trees.forEach((t) => {
    if (!treeEls[t.id]) {
      const el = document.createElement('div');
      el.className = 'tree';
      el.style.left = pct(t.x);
      el.style.bottom = pct(CONFIG.GROUND_HEIGHT);
      el.style.width = pct(CONFIG.TREE_SIZE);
      el.style.height = pct(CONFIG.TREE_SIZE);
      el.style.backgroundImage = `url(${CONFIG.SPRITES.tree})`;
      mapEl.appendChild(el);
      treeEls[t.id] = el;
    }
  });
}

socket.on('treesUpdate', (updatedTrees) => { trees = updatedTrees; renderTrees(); });

function createLake() {
  const el = document.createElement('div');
  el.className = 'lake';
  el.style.left = pct(CONFIG.LAKE.x);
  el.style.bottom = pct(CONFIG.GROUND_HEIGHT);
  el.style.width = pct(CONFIG.LAKE.width);
  el.style.height = pct(CONFIG.LAKE.height);
  el.style.backgroundImage = `url(${CONFIG.SPRITES.lake})`;
  mapEl.appendChild(el);
}
createLake();

let lastInteract = 0;

function tryInteract() {
  const now = Date.now();
  if (now - lastInteract < CONFIG.INTERACT_COOLDOWN) return;
  if (!localEl || isDead) return;

  const px = localPlayer.x + CONFIG.CHAR_WIDTH / 2;
  const lakeCenterX = CONFIG.LAKE.x + CONFIG.LAKE.width / 2;
  if (Math.abs(px - lakeCenterX) < CONFIG.INTERACT_RANGE) {
    lastInteract = now;
    const lvl = skills.fishing.level || 1;
    const tiers = [
      { level: 1, id: 'fish', weight: 1.0 },
      { level: 10, id: 'fish2', weight: 0.25 },
      { level: 20, id: 'fish3', weight: 0.15 },
    ];
    const available = tiers.filter(t => lvl >= t.level);
    const weights = available.map(t => t.weight);
    const sum = weights.reduce((a,b)=>a+b,0);
    const r = Math.random() * sum;
    let acc = 0;
    let chosen = available[0].id;
    for (let i=0;i<available.length;i++) {
      acc += weights[i];
      if (r <= acc) { chosen = available[i].id; break; }
    }
    addItem(chosen, 1);
    addXp('fishing', CONFIG.XP_PER_ACTION);
    showFloatingIcon(localEl, CONFIG.SPRITES[chosen] || CONFIG.SPRITES.fish, '');
    return;
  }

  for (const t of trees) {
    const treeCenterX = t.x + CONFIG.TREE_SIZE / 2;
    if (Math.abs(px - treeCenterX) < CONFIG.INTERACT_RANGE) {
      lastInteract = now;
      addItem('logs', 1);
      addXp('woodcutting', CONFIG.XP_PER_ACTION);
      showFloatingIcon(localEl, CONFIG.SPRITES.logs, '');
      socket.emit('chopTree', { treeId: t.id });
      return;
    }
  }
}

function showFloatingBubble(playerEl, innerHTML) {
  if (!playerEl) return;
  const bubble = document.createElement('div');
  bubble.className = 'floating-bubble';
  bubble.innerHTML = innerHTML;
  playerEl.appendChild(bubble);
  requestAnimationFrame(() => bubble.classList.add('animate'));
  setTimeout(() => bubble.remove(), 1500);
}

function showFloatingEmoji(playerEl, emoji) { showFloatingBubble(playerEl, `<span class="emoji">${emoji}</span>`); }
function showFloatingIcon(playerEl, iconSrc, text) { showFloatingBubble(playerEl, `<img src="${iconSrc}" class="floating-icon"><span class="floating-text">${text}</span>`); }

document.querySelectorAll('.emoji-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const emoji = btn.dataset.emoji;
    showFloatingEmoji(localEl, emoji);
    socket.emit('emoji', emoji);
  });
});

const inventory = {};
const ITEM_ICONS = { logs: CONFIG.SPRITES.logs, fish: CONFIG.SPRITES.fish, fish2: CONFIG.SPRITES.fish2, fish3: CONFIG.SPRITES.fish3 };

function addItem(itemId, amount = 1) {
  inventory[itemId] = (inventory[itemId] || 0) + amount;
  renderInventory();
  renderShop();
}

function renderInventory() {
  const grid = document.getElementById('inventory-grid');
  grid.innerHTML = '';
  const entries = Object.entries(inventory).filter(([, count]) => count > 0);
  for (let i = 0; i < CONFIG.INVENTORY_SLOTS; i++) {
    const slot = document.createElement('div');
    slot.className = 'inv-slot';
    const entry = entries[i];
    if (entry) {
      const [itemId, count] = entry;
      slot.innerHTML = `<img src="${ITEM_ICONS[itemId] || CONFIG.SPRITES[itemId] || CONFIG.SPRITES.logs}" class="inv-icon"><span class="inv-count">${count}</span>`;
    }
    grid.appendChild(slot);
  }
}
renderInventory();

const skills = { woodcutting: { xp: 0, level: 1 }, fishing: { xp: 0, level: 1 }, research: { xp: 0, level: 1 } };

function addXp(skillId, amount) {
  const s = skills[skillId];
  if (!s) return;
  s.xp += amount;
  s.level = Math.floor(s.xp / CONFIG.XP_PER_LEVEL) + 1;
  renderSkill(skillId);
}

function renderSkill(skillId) {
  const s = skills[skillId];
  const row = document.querySelector(`.skill-row[data-skill="${skillId}"]`);
  if (!row || !s) return;
  row.querySelector('.skill-level').textContent = `Lv ${s.level}`;
  const progress = s.xp % CONFIG.XP_PER_LEVEL;
  row.querySelector('.skill-bar-fill').style.width = `${(progress / CONFIG.XP_PER_LEVEL) * 100}%`;
}
Object.keys(skills).forEach(renderSkill);

const wardrobe = new Set();
let equippedOutfit = null;

function buyOutfit(id) {
  const item = CONFIG.OUTFITS[id];
  if (!item || wardrobe.has(id)) return;
  const have = inventory[item.currency] || 0;
  if (have < item.price) return;
  inventory[item.currency] -= item.price;
  wardrobe.add(id);
  renderInventory();
  renderShop();
}

function toggleEquip(id) {
  equippedOutfit = equippedOutfit === id ? null : id;
  localPlayer.outfit = equippedOutfit;
  updatePlayerEl(localEl, localPlayer);
  renderWardrobe();
}

function renderShop() {
  const shopItems = document.getElementById('shop-items');
  if (!shopItems) return;
  shopItems.innerHTML = '';

  Object.entries(CONFIG.OUTFITS).forEach(([id, item]) => {
    const owned = wardrobe.has(id);
    const have = inventory[item.currency] || 0;
    const canAfford = have >= item.price;
    const currencyIcon = item.currency === 'fish' ? '🐟' : '🪵';
    const card = document.createElement('div');
    card.className = 'shop-item';
    card.innerHTML = `
      <img src="${outfitSprite('idle', id)}" class="shop-item-img" alt="${item.name}">
      <div class="shop-item-name">${item.name}</div>
      <div class="shop-item-price">${item.price} ${currencyIcon}</div>
      <button class="btn btn-sm ${owned || !canAfford ? 'btn-disabled' : 'btn-blue'}" ${owned || !canAfford ? 'disabled' : ''}>
        ${owned ? 'Owned' : 'Buy'}
      </button>
    `;
    if (!owned && canAfford) {
      card.querySelector('button').addEventListener('click', () => buyOutfit(id));
    }
    shopItems.appendChild(card);
  });

  const sep = document.createElement('div');
  sep.style.width = '100%';
  sep.style.height = '8px';
  shopItems.appendChild(sep);

  Object.entries(clientShop).forEach(([id, item]) => {
    const owned = item.bought;
    const total = clientShopTotals[id] || Object.values(item.contributions || {}).reduce((a,b)=>a+(b||0),0);
    const currencyIcon = item.currency === 'fish' ? '🐟' : '🪵';
    const card = document.createElement('div');
    card.className = 'shop-item';
    card.innerHTML = `
      <img src="${item.sprite || item.spriteOn || CONFIG.SPRITES[id] || CONFIG.SPRITES.house}" class="shop-item-img" alt="${item.name}">
      <div class="shop-item-name">${item.name}</div>
      <div class="shop-item-price">${item.price} ${currencyIcon}</div>
      <div class="shop-progress">Contributed: ${total}/${item.price}</div>
      <div style="display:flex;gap:6px;margin-top:6px;"></div>
    `;
    const btnContainer = card.querySelector('div[style*="display:flex"]');
    if (!owned) {
      const btn10 = document.createElement('button');
      btn10.className = 'btn btn-sm btn-blue';
      btn10.textContent = 'Contribute 10';
      btn10.addEventListener('click', () => tryContribute(id, 10));
      const btn100 = document.createElement('button');
      btn100.className = 'btn btn-sm btn-blue';
      btn100.textContent = 'Contribute 100';
      btn100.addEventListener('click', () => tryContribute(id, 100));
      btnContainer.appendChild(btn10);
      btnContainer.appendChild(btn100);
    } else {
      if (id === 'fire') {
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn btn-sm btn-blue';
        toggleBtn.textContent = clientFireOn ? 'Turn Off' : 'Turn On';
        toggleBtn.addEventListener('click', () => socket.emit('toggleFire'));
        btnContainer.appendChild(toggleBtn);
      } else {
        btnContainer.innerHTML = '<div style="font-size:12px;color:#9a9a9a">Purchased</div>';
      }
    }
    shopItems.appendChild(card);
  });

  renderWardrobe();
  renderMapItems();
}

function tryContribute(itemId, amount) {
  const item = clientShop[itemId];
  if (!item) return;
  const currency = item.currency;
  if ((inventory[currency] || 0) < amount) {
    appendChatLog('System', `Not enough ${currency} to contribute.`);
    return;
  }
  inventory[currency] -= amount;
  renderInventory();
  socket.emit('contribute', { itemId, amount });
}

function renderWardrobe() {
  const wardrobeItems = document.getElementById('wardrobe-items');
  if (!wardrobeItems) return;
  wardrobeItems.innerHTML = '';
  if (wardrobe.size === 0) {
    wardrobeItems.innerHTML = '<p class="empty-msg">No outfits yet — check the Shop tab!</p>';
    return;
  }
  wardrobe.forEach((id) => {
    const item = CONFIG.OUTFITS[id];
    const isEquipped = equippedOutfit === id;
    const card = document.createElement('div');
    card.className = 'shop-item';
    card.innerHTML = `
      <img src="${outfitSprite('idle', id)}" class="shop-item-img" alt="${item.name}">
      <div class="shop-item-name">${item.name}</div>
      <button class="btn btn-sm ${isEquipped ? 'btn-red' : 'btn-blue'}">
        ${isEquipped ? 'Unequip' : 'Equip'}
      </button>
    `;
    card.querySelector('button').addEventListener('click', () => toggleEquip(id));
    wardrobeItems.appendChild(card);
  });
}
renderShop();

function renderMapItems() {
  Object.keys(mapItemsEls).forEach((id) => {
    if (!clientShop[id] || !clientShop[id].bought) {
      mapItemsEls[id].remove();
      delete mapItemsEls[id];
    }
  });

  Object.entries(clientShop).forEach(([id, item]) => {
    if (!item.bought) return;
    let el = mapItemsEls[id];
    if (!el) {
      el = document.createElement('div');
      el.className = 'map-item';
      el.style.position = 'absolute';
      el.style.width = pct(120);
      el.style.height = pct(120);
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.left = pct(item.x || 50);
      el.style.bottom = pct(CONFIG.GROUND_HEIGHT);
      el.style.zIndex = 1;
      el.style.pointerEvents = 'auto';
      el.dataset.itemId = id;
      el.addEventListener('click', () => {
        document.querySelector('.tab-icon-btn[data-tab="shop"]').click();
      });
      mapEl.appendChild(el);
      mapItemsEls[id] = el;
    }
    if (id === 'fire') {
      el.style.backgroundImage = `url(${clientFireOn ? (item.spriteOn || CONFIG.SPRITES.fireOn) : (item.spriteOff || CONFIG.SPRITES.fireOff)})`;
    } else {
      el.style.backgroundImage = `url(${item.sprite || item.spriteOn || CONFIG.SPRITES[id] || CONFIG.SPRITES.house})`;
    }
  });
}

let activeMinigame = null;

socket.on('minigameStarted', ({ type, state }) => { activeMinigame = { type, state }; showMinigameUI(type, state); });
socket.on('minigameEnded', ({ winnerId, type }) => { hideMinigameUI(); appendChatLog('System', winnerId === myId ? `You won the ${type} minigame and earned research XP!` : `Player ${winnerId} won the ${type} minigame.`); activeMinigame = null; });
socket.on('grantResearchXp', ({ id, xp }) => { if (id === myId) addXp('research', xp || CONFIG.MINIGAME_REWARD_XP); });

function showMinigameUI(type, state) {
  const overlay = document.createElement('div');
  overlay.id = 'minigame-overlay';
  overlay.style.position = 'absolute';
  overlay.style.left = '0';
  overlay.style.top = '0';
  overlay.style.width = '100%';
  overlay.style.height = '100%';
  overlay.style.zIndex = 60;
  overlay.style.display = 'flex';
  overlay.style.alignItems = 'center';
  overlay.style.justifyContent = 'center';
  overlay.style.background = 'rgba(0,0,0,0.6)';
  overlay.style.color = '#fff';
  overlay.style.flexDirection = 'column';
  overlay.style.gap = '12px';
  overlay.style.fontFamily = 'VT323, monospace';
  overlay.style.fontSize = '20px';

  if (type === 'guessWord') {
    const prompt = document.createElement('div'); prompt.textContent = 'Guess the word!';
    const input = document.createElement('input'); input.className = 'text-input'; input.placeholder = 'Type your guess and press Enter'; input.style.width = '300px';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const attempt = input.value.trim(); if (!attempt) return; socket.emit('minigameSubmit', { attempt }); } });
    overlay.appendChild(prompt); overlay.appendChild(input);
  } else if (type === 'rhythm') {
    const prompt = document.createElement('div'); prompt.textContent = 'Rhythm: repeat the sequence (tap 0/1)';
    const seq = state.sequence || [];
    const seqEl = document.createElement('div'); seqEl.textContent = `Sequence length: ${seq.length}`;
    const input = document.createElement('input'); input.className = 'text-input'; input.placeholder = 'Enter sequence like 010101'; input.style.width = '300px';
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const raw = input.value.trim(); const attempt = raw.split('').map(c => Number(c)); socket.emit('minigameSubmit', { attempt }); } });
    overlay.appendChild(prompt); overlay.appendChild(seqEl); overlay.appendChild(input);
  }

  const cancel = document.createElement('button'); cancel.className = 'btn btn-sm btn-red'; cancel.textContent = 'Close'; cancel.addEventListener('click', hideMinigameUI);
  overlay.appendChild(cancel);
  document.body.appendChild(overlay);
}

function hideMinigameUI() { const el = document.getElementById('minigame-overlay'); if (el) el.remove(); }

let movedThisFrame = false;
let isJumping = false;

function loop() {
  if (!isDead) {
    let moving = false;
    if (keys.ArrowLeft) { localPlayer.x -= CONFIG.MOVE_SPEED; localPlayer.facing = 'left'; moving = true; movedThisFrame = true; }
    if (keys.ArrowRight) { localPlayer.x += CONFIG.MOVE_SPEED; localPlayer.facing = 'right'; moving = true; movedThisFrame = true; }
    localPlayer.x = Math.max(0, Math.min(CONFIG.MAP_SIZE - CONFIG.CHAR_WIDTH, localPlayer.x));
    if (keys.ArrowUp && localPlayer.onGround) { localPlayer.vy = CONFIG.JUMP_FORCE; localPlayer.onGround = false; }
    localPlayer.vy -= CONFIG.GRAVITY;
    localPlayer.y += localPlayer.vy;
    if (localPlayer.y <= 0) { localPlayer.y = 0; localPlayer.vy = 0; localPlayer.onGround = true; }
    localPlayer.state = !localPlayer.onGround ? 'jump' : (moving ? 'walk' : 'idle');
    isJumping = !localPlayer.onGround;
  } else {
    // while dead, freeze vertical/horizontal movement visually
    localPlayer.vy = 0;
    localPlayer.y = 0;
    localPlayer.state = 'idle';
  }

  if (localEl) {
    // localEl sprite will be updated by updatePlayerEl when server sends updates,
    // but keep local visual consistent while dead
    if (isDead) {
      localEl.style.backgroundImage = `url(${CONFIG.SPRITES.dead})`;
      localEl.classList.add('dead');
    } else {
      updatePlayerEl(localEl, localPlayer);
    }
  }

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

setInterval(() => {
  if (!myId) return;
  socket.emit('update', {
    x: localPlayer.x,
    y: localPlayer.y,
    facing: localPlayer.facing,
    state: localPlayer.state,
    outfit: localPlayer.outfit,
    movedDuringMonster: !!(monsterActive && monsterActive.type === 'flodder' && movedThisFrame),
    isJumping: isJumping,
    isMoving: movedThisFrame,
  });
  movedThisFrame = false;
}, CONFIG.SEND_RATE);

let monsterActive = null;

function showMonster(type, duration) {
  const existing = document.getElementById('monster-overlay');
  if (existing) existing.remove();

  const container = document.createElement('div');
  container.id = 'monster-overlay';
  container.style.position = 'absolute';
  container.style.left = '0';
  container.style.top = '0';
  container.style.width = '100%';
  container.style.height = '100%';
  container.style.zIndex = 0;
  container.style.overflow = 'hidden';
  container.style.pointerEvents = 'none';
  container.style.transform = 'translateX(-100%)';
  container.style.transition = `transform ${CONFIG.MONSTER_SLIDE_DURATION}ms linear`;
  mapEl.appendChild(container);

  const img = document.createElement('img');
  img.style.position = 'absolute';
  img.style.left = '0';
  img.style.top = '0';
  img.style.width = '100%';
  img.style.height = '100%';
  img.style.objectFit = 'cover';
  img.style.imageRendering = 'pixelated';
  img.alt = type;
  const src = CONFIG.MONSTER_SPRITES[type] || `assets/${type}.gif`;
  img.src = src;
  container.appendChild(img);

  requestAnimationFrame(() => { container.style.transform = 'translateX(0%)'; });

  const stay = duration || CONFIG.MONSTER_STAY_MS;
  setTimeout(() => {
    container.style.transform = 'translateX(100%)';
    setTimeout(() => { const el = document.getElementById('monster-overlay'); if (el) el.remove(); }, CONFIG.MONSTER_SLIDE_DURATION);
  }, stay);
}

socket.on('monsterSpawn', ({ type, duration }) => {
  if (!CONFIG.MONSTER_SPRITES[type]) CONFIG.MONSTER_SPRITES[type] = `assets/${type}.gif`;
  showMonster(type, duration || CONFIG.MONSTER_STAY_MS);
  appendChatLog('System', type === 'flodder' ? 'A flooder sweeps across the land!' : 'A strange fake flooder appears!');
  monsterActive = { type, endsAt: Date.now() + (duration || CONFIG.MONSTER_STAY_MS), startedAt: Date.now() };
  setTimeout(() => { monsterActive = null; }, duration || CONFIG.MONSTER_STAY_MS);
});

// When a player dies: show dead sprite and lock local controls until respawn
socket.on('playerDied', ({ id, cause }) => {
  if (id === myId) {
    // clear inventory
    Object.keys(inventory).forEach(k => inventory[k] = 0);
    renderInventory();

    // set dead state locally
    isDead = true;
    if (localEl) {
      localEl.style.backgroundImage = `url(${CONFIG.SPRITES.dead})`;
      localEl.classList.add('dead');
    }
    appendChatLog('System', 'You died and lost your inventory.');
  } else {
    // remote player: show dead sprite
    const el = remoteEls[id];
    if (el) {
      el.style.backgroundImage = `url(${CONFIG.SPRITES.dead})`;
      el.classList.add('dead');
    }
    appendChatLog('System', `${id} died from ${cause}`);
  }
});

socket.on('playerRespawn', ({ id, player }) => {
  if (id === myId) {
    // clear dead state and update position
    isDead = false;
    localPlayer.x = player.x; localPlayer.y = player.y; localPlayer.vy = 0; localPlayer.onGround = true;
    updatePlayerEl(localEl, localPlayer);
  } else if (remoteEls[id]) {
    // remote player respawn: update sprite/position
    remoteEls[id].classList.remove('dead');
    updatePlayerEl(remoteEls[id], player);
  }
});

socket.on('contributionUpdate', ({ itemId, total, needed }) => {
  clientShopTotals[itemId] = total;
  if (clientShop[itemId]) clientShop[itemId].contributions = clientShop[itemId].contributions || {};
  renderShop();
});

socket.on('itemBought', ({ itemId, item }) => {
  clientShop[itemId] = item;
  clientShopTotals[itemId] = Object.values(item.contributions || {}).reduce((a,b)=>a+(b||0),0);
  if (itemId === 'fire') clientFireOn = true;
  renderShop();
  renderMapItems();
  appendChatLog('System', `${item.name || itemId} has been purchased for the room.`);
});

socket.on('fireToggled', ({ fireOn }) => {
  clientFireOn = !!fireOn;
  renderMapItems();
  appendChatLog('System', `Fire is now ${clientFireOn ? 'ON' : 'OFF'}.`);
});

// Test keys
document.addEventListener('keydown', (e) => {
  if (e.key === 'm' || e.key === 'M') socket.emit('startMinigame', { type: 'guessWord' });
  else if (e.key === 'n' || e.key === 'N') socket.emit('startMinigame', { type: 'rhythm' });
  else if (e.key === 'k' || e.key === 'K') {
    socket.emit('spawnMonsterNow');
    appendChatLog('System', 'Requested immediate monster spawn (test).');
  }
});
