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

  // Farming — all client-side, per the request: a seed is a rare woodcutting
  // drop once you're high enough level, and the farm (once bought) turns one
  // seed into hay after a wait. None of this touches the server.
  SEED_DROP_LEVEL: 50,   // minimum woodcutting level before trees can drop seeds
  SEED_DROP_CHANCE: 0.01, // 1%
  FARM_GROW_MS: 60 * 1000, // 1 minute

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
    fish4: 'assets/fish4.png',
    logs: 'assets/logs.png',
    fireOn: 'assets/fireOn.gif',
    fireOff: 'assets/fireOff.gif',
    house: 'assets/house.gif',
    house2: 'assets/house2.gif',
    platform: 'assets/platform.gif',
    lava: 'assets/lava.gif',
    dead: 'assets/dead.gif',
    seed: 'assets/seed.png',
    hay: 'assets/hay.png',
  },

  OUTFITS: {
    knight: { name: 'Knight', price: 50, currency: 'logs' },
    goblin: { name: 'Goblin', price: 500, currency: 'fish' },
    demon: { name: 'Demon', price: 500, currency: 'fish2' },
    hazmat: { name: 'Hazmat', price: 200, currency: 'logs' },
    mantis: { name: 'Mantis', price: 5, currency: 'hay' },
    pinker: { name: 'Pinker', price: 300, currency: 'fish2' },
    phantom: { name: 'Phantom', price: 100, currency: 'fish4' },
    // Real-money skin — no price/currency (that lives on the server, tied to
    // the actual Stripe Price), just premium:true + what to show for it.
    aqua: { name: 'Aqua', premium: true, priceEUR: 2.00 },
  },

  SHOP_CATALOG: {
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
      zIndex: -1, // background decorations render behind the lake(0)/trees(1)/players(2); house is frontmost of this group
      next: { id: 'house2', priceMultiplier: 2, sprite: 'assets/house2.gif' },
      bought: false, contributions: {},
    },
    lamp: {
      id: 'lamp', name: 'Lamp', price: 10, currency: 'logs',
      x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
      sprite: 'assets/lamp.gif',
      zIndex: -3,
      bought: false, contributions: {},
    },
    wall: {
      id: 'wall', name: 'Wall', price: 10, currency: 'logs',
      x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
      sprite: 'assets/wall.gif',
      zIndex: -4, // behind every other decoration/tree/lake — furthest back
      bought: false, contributions: {},
    },
    farm: {
      id: 'farm', name: 'Farm', price: 10, currency: 'logs',
      x: 0, y: -86.8, width: 500, height: 500, // left:0%, bottom:0% (of the whole map), 100% x 100%
      sprite: 'assets/farm.gif',
      zIndex: -2, // behind house, in front of wall/lamp
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
  },

  MONSTER_SPRITES: { flodder: 'assets/flodder.gif', fakeflodder: 'assets/fakeflodder.gif', worren: 'assets/worren.gif' },
  MONSTER_SLIDE_DURATION: 1000,
  MONSTER_STAY_MS: 20000,

  LAVA_STAY_MS: 15000,
  LAVA_FADE_MS: 800,
};

function pct(value) { return `${(value / CONFIG.MAP_SIZE) * 100}%`; }
function outfitSprite(state, outfitId) { return `assets/${state}${outfitId}.gif`; }

const socket = io();
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

// ============================================================
// Auth — MongoDB-backed username/password accounts. A logged-in session
// (just a random token) is cached in localStorage so a page refresh doesn't
// force a re-login; everything else (rooms, game state) is unaffected and
// still keyed off whatever username came back from the server.
// ============================================================
const authScreenEl = document.getElementById('auth-screen');
const authUsernameInput = document.getElementById('auth-username-input');
const authPasswordInput = document.getElementById('auth-password-input');
const authError = document.getElementById('auth-error');

function enterLobbyAs(username) {
  usernameInput.value = username;
  authScreenEl.classList.add('hidden');
  lobbyEl.classList.remove('hidden');
  refreshPremiumOwnership();
  refreshCreatorLinkText();
}

async function submitAuth(endpoint) {
  authError.textContent = '';
  const username = authUsernameInput.value.trim();
  const password = authPasswordInput.value;
  if (!username || !password) {
    authError.textContent = 'Enter a username and password.';
    return;
  }
  try {
    const res = await fetch(`/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) {
      authError.textContent = data.error || 'Something went wrong.';
      return;
    }
    localStorage.setItem('crahdenAuthToken', data.token);
    enterLobbyAs(data.username);
  } catch (err) {
    authError.textContent = 'Could not reach the server. Try again.';
  }
}

document.getElementById('login-btn').addEventListener('click', () => submitAuth('login'));
document.getElementById('register-btn').addEventListener('click', () => submitAuth('register'));
[authUsernameInput, authPasswordInput].forEach((input) => {
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth('login'); });
});

document.getElementById('logout-link').addEventListener('click', () => {
  const token = localStorage.getItem('crahdenAuthToken');
  if (token) fetch('/api/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }).catch(() => {});
  localStorage.removeItem('crahdenAuthToken');
  lobbyEl.classList.add('hidden');
  authScreenEl.classList.remove('hidden');
  authUsernameInput.value = '';
  authPasswordInput.value = '';
});

// ------------------------------------------------------------
// Creator self-onboarding — any logged-in account can start this; you still
// separately decide which skin pays which creator via PREMIUM_SKINS on the
// server, this link just gets someone through Stripe's own onboarding form
// without you doing anything by hand.
// ------------------------------------------------------------
const creatorLink = document.getElementById('creator-link');
const creatorCountryRow = document.getElementById('creator-country-row');
const creatorCountrySelect = document.getElementById('creator-country-select');
let creatorAccountExists = false; // set by refreshCreatorLinkText — an existing account already has its country locked in

async function refreshCreatorLinkText() {
  const token = localStorage.getItem('crahdenAuthToken');
  if (!token) return;
  try {
    const res = await fetch('/api/creator/status', { headers: { 'x-auth-token': token } });
    if (!res.ok) return;
    const data = await res.json();
    creatorAccountExists = !!data.isCreator;
    if (data.onboardingComplete) creatorLink.textContent = '✅ Creator account connected';
    else if (data.isCreator) creatorLink.textContent = '⏳ Continue creator onboarding';
    else creatorLink.textContent = '🎨 Become a creator';
  } catch (err) {
    // offline/hiccup — link just keeps its last known label
  }
}

async function startCreatorOnboarding(country) {
  const token = localStorage.getItem('crahdenAuthToken');
  if (!token) return;
  try {
    const res = await fetch('/api/creator/onboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, country }),
    });
    const data = await res.json();
    if (!res.ok) { lobbyError.textContent = data.error || 'Could not start onboarding.'; return; }
    window.location.href = data.url; // off to Stripe's hosted onboarding form
  } catch (err) {
    lobbyError.textContent = 'Could not reach the server.';
  }
}

creatorLink.addEventListener('click', () => {
  // Country can only be set once, at account creation — Stripe otherwise
  // defaults it to the platform's own country, which is exactly the bug
  // this picker fixes. An existing account already has it locked in, so
  // there's nothing to ask a second time.
  if (creatorAccountExists) { startCreatorOnboarding(); return; }
  creatorCountryRow.classList.remove('hidden');
});

document.getElementById('creator-country-confirm').addEventListener('click', () => {
  const country = creatorCountrySelect.value;
  if (!country) { lobbyError.textContent = 'Pick a country first.'; return; }
  startCreatorOnboarding(country);
});

// Try to silently restore a session on page load; fall back to the auth screen.
(async () => {
  const token = localStorage.getItem('crahdenAuthToken');
  if (!token) return;
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) { localStorage.removeItem('crahdenAuthToken'); return; }
    const data = await res.json();
    enterLobbyAs(data.username);
  } catch (err) {
    // network hiccup — just leave the auth screen showing, no need to nuke the stored token
  }
})();

// Coming back from Stripe Checkout — actively CONFIRMS the purchase against
// the server (see /api/premium/confirm) rather than just hoping the webhook
// already landed; this is what actually grants the skin most of the time now.
(async () => {
  const params = new URLSearchParams(window.location.search);
  const purchase = params.get('purchase');
  const sessionId = params.get('session_id');
  const onboarding = params.get('onboarding');
  if (!purchase && !onboarding) return;

  // At this point we're back on the room lobby screen (not inside a room
  // yet), so the in-game chat log isn't visible — use the lobby's own line.
  if (purchase === 'success') {
    const token = localStorage.getItem('crahdenAuthToken');
    if (token && sessionId) {
      try {
        const res = await fetch('/api/premium/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token, sessionId }),
        });
        const data = await res.json();
        lobbyError.style.color = res.ok ? 'var(--accent-green, #7cb342)' : '';
        lobbyError.textContent = res.ok
          ? 'Thanks for your purchase! Check the shop for your new skin.'
          : (data.error || 'Payment went through, but confirming it failed — it should still catch up automatically next time you log in.');
        if (res.ok) refreshPremiumOwnership();
      } catch (err) {
        lobbyError.textContent = 'Could not confirm your purchase — it should still catch up automatically next time you log in.';
      }
    } else {
      lobbyError.style.color = 'var(--accent-green, #7cb342)';
      lobbyError.textContent = 'Thanks for your purchase! Check the shop for your new skin.';
    }
  } else if (purchase === 'cancelled') {
    lobbyError.textContent = 'Checkout cancelled — no charge was made.';
  } else if (onboarding === 'return') {
    // Stripe reviews submitted info asynchronously, so this doesn't
    // necessarily mean onboarding is fully approved yet — refreshCreatorLinkText()
    // (called from enterLobbyAs above) will reflect the real status once it lands.
    lobbyError.style.color = 'var(--accent-green, #7cb342)';
    lobbyError.textContent = 'Stripe onboarding submitted — this can take a moment to finish processing.';
  }

  // Tidy the URL last, after everything above has actually run — and to a
  // hardcoded '/' rather than window.location.pathname. That second part
  // matters: with a trailing slash in APP_BASE_URL, the redirect URL Stripe
  // sends back ends up with a DOUBLE slash (.../?purchase=...), which some
  // browsers then parse pathname as "//" — and passing that to replaceState
  // throws a SecurityError (it gets interpreted as a protocol-relative URL).
  // That threw BEFORE the confirm call above ever ran, which is what
  // actually caused a real purchase to never get granted. Wrapped in
  // try/catch too now as a second layer, since a thrown error here should
  // never be able to block anything that matters again.
  try {
    window.history.replaceState({}, '', '/');
  } catch (err) {
    console.error('Could not clean up the URL (harmless):', err);
  }
})();

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
let isHiding = false; // true while hidden via /house — immune, invisible, and frozen
function controlsLocked() { return isDead || isHiding; }

window.addEventListener('keydown', (e) => {
  if (document.activeElement === chatInput) return;
  if (controlsLocked()) return;
  if (e.key in keys) { keys[e.key] = true; e.preventDefault(); }
  if ((e.key === 'e' || e.key === 'E') && !e.repeat) tryInteract();
});
window.addEventListener('keyup', (e) => {
  if (e.key in keys) { keys[e.key] = false; e.preventDefault(); }
});

function bindTouchButton(id, key) {
  const btn = document.getElementById(id);
  const press = (e) => { e.preventDefault(); if (!controlsLocked()) keys[key] = true; };
  const release = (e) => { e.preventDefault(); keys[key] = false; };
  btn.addEventListener('pointerdown', press);
  btn.addEventListener('pointerup', release);
  btn.addEventListener('pointerleave', release);
  btn.addEventListener('pointercancel', release);
}
bindTouchButton('btn-left', 'ArrowLeft');
bindTouchButton('btn-right', 'ArrowRight');
bindTouchButton('btn-jump', 'ArrowUp');
document.getElementById('btn-interact').addEventListener('pointerdown', (e) => { e.preventDefault(); if (!controlsLocked()) tryInteract(); });

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
let farmGrowing = null; // { until: <timestamp> } while a planted seed is growing — client-side only

function tryInteract() {
  const now = Date.now();
  if (now - lastInteract < CONFIG.INTERACT_COOLDOWN) return;
  if (!localEl || controlsLocked()) return;

  const px = localPlayer.x + CONFIG.CHAR_WIDTH / 2;
  const lakeCenterX = CONFIG.LAKE.x + CONFIG.LAKE.width / 2;
  if (Math.abs(px - lakeCenterX) < CONFIG.INTERACT_RANGE) {
    lastInteract = now;
    const lvl = skills.fishing.level || 1;
    const tiers = [
      { level: 1, id: 'fish', weight: 1.0 },
      { level: 20, id: 'fish2', weight: 0.25 },
      { level: 50, id: 'fish3', weight: 0.15 },
      { level: 100, id: 'fish4', weight: 0.15 },
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

      // Rare bonus drop, once woodcutting is high enough — doesn't replace the log.
      const wcLevel = skills.woodcutting.level || 1;
      if (wcLevel >= CONFIG.SEED_DROP_LEVEL && Math.random() < CONFIG.SEED_DROP_CHANCE) {
        addItem('seed', 1);
        showFloatingIcon(localEl, CONFIG.SPRITES.seed, 'Seed!');
      }

      socket.emit('chopTree', { treeId: t.id });
      return;
    }
  }

  // Farm planting now happens by clicking the seed in your inventory (see
  // plantSeed(), wired up in renderInventory()) instead of pressing E.
}

// Plant one seed on the farm — triggered by clicking the seed's inventory
// slot. Entirely client-side, same as the rest of the farm/seed/hay loop.
function plantSeed() {
  if (!clientShop.farm || !clientShop.farm.bought) {
    appendChatLog('System', 'There\'s no farm in this room yet — someone needs to fund one in the shop.');
    return;
  }

  const now = Date.now();
  if (farmGrowing) {
    const remaining = Math.max(0, Math.ceil((farmGrowing.until - now) / 1000));
    appendChatLog('System', remaining > 0 ? `The farm is still growing (${remaining}s left).` : 'The farm should be ready any moment.');
    return;
  }

  if ((inventory.seed || 0) <= 0) {
    appendChatLog('System', 'You need a seed to plant here (rare woodcutting drop past level 50).');
    return;
  }

  inventory.seed -= 1;
  renderInventory();
  if (localEl) showFloatingIcon(localEl, CONFIG.SPRITES.seed, 'Planted');
  appendChatLog('System', 'You planted a seed. Check back in a minute.');

  farmGrowing = { until: now + CONFIG.FARM_GROW_MS };
  setTimeout(() => {
    farmGrowing = null;
    addItem('hay', 1);
    if (localEl) showFloatingIcon(localEl, CONFIG.SPRITES.hay, '+1');
    appendChatLog('System', 'Your farm produced hay!');
  }, CONFIG.FARM_GROW_MS);
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

// Shop items can price themselves in ANY inventory item id (not just logs/fish) —
// this renders whatever icon that item actually uses, falling back to its name
// as plain text if it's some future item with no icon registered yet.
function currencyDisplay(currency) {
  const icon = ITEM_ICONS[currency] || CONFIG.SPRITES[currency];
  if (icon) return `<img src="${icon}" style="width:14px;height:14px;vertical-align:-2px;object-fit:contain;">`;
  return currency;
}

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
      if (itemId === 'seed') {
        slot.style.cursor = 'pointer';
        slot.title = 'Click to plant on the farm';
        slot.addEventListener('click', plantSeed);
      }
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
let premiumCheckoutInFlight = false; // guards against double-clicking Buy and opening two Stripe tabs

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

// Real-money skin — hits the server to create a Stripe Checkout session,
// then hands the browser off to Stripe's hosted payment page entirely.
// Ownership is granted by the server's webhook once payment actually
// completes, not by anything that happens here client-side.
async function buyPremiumSkin(id) {
  if (premiumCheckoutInFlight) return;
  const token = localStorage.getItem('crahdenAuthToken');
  if (!token) { appendChatLog('System', 'Log in to buy premium skins.'); return; }

  premiumCheckoutInFlight = true;
  try {
    const res = await fetch('/api/premium/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, skinId: id }),
    });
    const data = await res.json();
    if (!res.ok) {
      appendChatLog('System', data.error || 'Could not start checkout.');
      premiumCheckoutInFlight = false;
      return;
    }
    window.location.href = data.url; // off to Stripe — page navigates away, no need to reset the flag
  } catch (err) {
    appendChatLog('System', 'Could not reach the server. Try again.');
    premiumCheckoutInFlight = false;
  }
}

async function refreshPremiumOwnership() {
  const token = localStorage.getItem('crahdenAuthToken');
  if (!token) return;
  try {
    const res = await fetch('/api/premium/owned', { headers: { 'x-auth-token': token } });
    if (!res.ok) return;
    const data = await res.json();
    (data.ownedSkins || []).forEach((id) => wardrobe.add(id));
    renderShop();
  } catch (err) {
    // offline/hiccup — premium ownership just won't show up until next refresh, not fatal
  }
}

function toggleEquip(id) {
  equippedOutfit = equippedOutfit === id ? null : id;
  localPlayer.outfit = equippedOutfit;
  updatePlayerEl(localEl, localPlayer);
  renderWardrobe();
}

function renderShop() {
  renderShopSkins();
  renderShopPremium();
  renderShopStructures();
  renderWardrobe();
  renderMapItems();
}

function renderShopSkins() {
  const container = document.getElementById('shop-skins');
  if (!container) return;
  container.innerHTML = '';

  const entries = Object.entries(CONFIG.OUTFITS).filter(([, item]) => !item.premium);
  entries.forEach(([id, item]) => {
    const owned = wardrobe.has(id);
    const have = inventory[item.currency] || 0;
    const canAfford = have >= item.price;
    const card = document.createElement('div');
    card.className = 'shop-item';
    card.innerHTML = `
      <img src="${outfitSprite('idle', id)}" class="shop-item-img" alt="${item.name}">
      <div class="shop-item-name">${item.name}</div>
      <div class="shop-item-price">${item.price} ${currencyDisplay(item.currency)}</div>
      <button class="btn btn-sm ${owned || !canAfford ? 'btn-disabled' : 'btn-blue'}" ${owned || !canAfford ? 'disabled' : ''}>
        ${owned ? 'Owned' : 'Buy'}
      </button>
    `;
    if (!owned && canAfford) {
      card.querySelector('button').addEventListener('click', () => buyOutfit(id));
    }
    container.appendChild(card);
  });
}

function renderShopPremium() {
  const container = document.getElementById('shop-premium');
  if (!container) return;
  container.innerHTML = '';

  const entries = Object.entries(CONFIG.OUTFITS).filter(([, item]) => item.premium);
  if (entries.length === 0) {
    container.innerHTML = '<p class="empty-msg">No premium skins yet.</p>';
    return;
  }

  entries.forEach(([id, item]) => {
    const owned = wardrobe.has(id);
    const card = document.createElement('div');
    card.className = 'shop-item';
    card.innerHTML = `
      <img src="${outfitSprite('idle', id)}" class="shop-item-img" alt="${item.name}">
      <div class="shop-item-name">${item.name} 💎</div>
      <div class="shop-item-price">€${item.priceEUR.toFixed(2)}</div>
      <button class="btn btn-sm ${owned ? 'btn-disabled' : 'btn-blue'}" ${owned ? 'disabled' : ''}>
        ${owned ? 'Owned' : 'Buy'}
      </button>
    `;
    if (!owned) card.querySelector('button').addEventListener('click', () => buyPremiumSkin(id));
    container.appendChild(card);
  });
}

function renderShopStructures() {
  const container = document.getElementById('shop-structures');
  if (!container) return;
  container.innerHTML = '';

  Object.entries(clientShop).forEach(([id, item]) => {
    const owned = item.bought;
    const total = clientShopTotals[id] || Object.values(item.contributions || {}).reduce((a, b) => a + (b || 0), 0);
    const card = document.createElement('div');
    card.className = 'shop-item';
    card.innerHTML = `
      <img src="${item.sprite || item.spriteOn || CONFIG.SPRITES[id] || CONFIG.SPRITES.house}" class="shop-item-img" alt="${item.name}">
      <div class="shop-item-name">${item.name}</div>
      <div class="shop-item-price">${item.price} ${currencyDisplay(item.currency)}</div>
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
      // btnContainer.appendChild(btn100);
    } else if (id === 'fire') {
      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'btn btn-sm btn-blue';
      toggleBtn.textContent = clientFireOn ? 'Turn Off' : 'Turn On';
      toggleBtn.addEventListener('click', () => socket.emit('toggleFire'));
      btnContainer.appendChild(toggleBtn);
    } else {
      btnContainer.innerHTML = '<div style="font-size:12px;color:#9a9a9a">Purchased</div>';
    }
    container.appendChild(card);
  });
}

document.querySelectorAll('.shop-subtab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.shop-subtab-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.shopTab;
    document.querySelectorAll('.shop-subpane').forEach((pane) => {
      pane.classList.toggle('active', pane.dataset.shopPane === target);
    });
  });
});

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
      // width/height/x/y all come from the shop's SHOP_CATALOG entry (server.js) —
      // change those there to move or resize any decoration.
      el = document.createElement('div');
      el.className = 'map-item';
      el.style.position = 'absolute';
      el.style.width = pct(item.width != null ? item.width : 120);
      el.style.height = pct(item.height != null ? item.height : 120);
      el.style.backgroundSize = 'contain';
      el.style.backgroundRepeat = 'no-repeat';
      el.style.left = pct(item.x != null ? item.x : 50); // was `item.x || 50` — broke for x:0 (falsy), causing the 10% offset
      el.style.bottom = pct(CONFIG.GROUND_HEIGHT + (item.y || 0));
      el.style.zIndex = item.zIndex != null ? item.zIndex : 1; // background decorations (wall/farm/house/lamp) set their own — see SHOP_CATALOG
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

// ============================================================
// Lava floor — random every 5-20 min. Same size as the map, appears with a
// fade, stays a while, fades out. Anyone not standing on a bought "platform"
// (or hiding via /house) dies once the grace period passes.
// ============================================================
function showLava(duration) {
  const existing = document.getElementById('lava-overlay');
  if (existing) existing.remove();

  const el = document.createElement('div');
  el.id = 'lava-overlay';
  el.style.position = 'absolute';
  el.style.left = '0';
  el.style.top = '0';
  el.style.width = '100%';
  el.style.height = '100%';
  el.style.backgroundImage = `url(${CONFIG.SPRITES.lava})`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundPosition = 'center';
  el.style.pointerEvents = 'none';
  el.style.zIndex = 10; // above players/nametags/chat bubbles/everything — lava covers the whole scene
  el.style.opacity = '0';
  el.style.transition = `opacity ${CONFIG.LAVA_FADE_MS}ms ease-in-out`;
  mapEl.appendChild(el);

  void el.offsetWidth; // force reflow so the fade-in reliably animates
  requestAnimationFrame(() => { el.style.opacity = '1'; });

  const stay = duration || CONFIG.LAVA_STAY_MS;
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => { const e = document.getElementById('lava-overlay'); if (e) e.remove(); }, CONFIG.LAVA_FADE_MS);
  }, stay);
}

socket.on('lavaSpawn', ({ duration }) => {
  showLava(duration || CONFIG.LAVA_STAY_MS);
  // "The floor is turning to lava!" arrives as its own system chat message
  // from the server, so nothing else needed here.
});

let movedThisFrame = false;
// Returns the top surface height (logical units above the base ground) of
// whichever bought isPlatform item overlaps this x, or null if none does.
// `surfaceOffset` on the item lets you nudge that surface up/down slightly
// without touching the collision math, in case it doesn't line up exactly
// with where the sprite's art visually ends.
function platformTopAt(x) {
  let top = null;
  Object.values(clientShop).forEach((item) => {
    if (!item.bought || !item.isPlatform) return;
    const left = item.x;
    const right = item.x + item.width;
    if (x + CONFIG.CHAR_WIDTH > left && x < right) {
      const t = (item.y || 0) + item.height + (item.surfaceOffset || 0);
      if (top === null || t > top) top = t;
    }
  });
  return top;
}

let isJumping = false;

function loop() {
  if (!controlsLocked()) {
    let moving = false;
    if (keys.ArrowLeft) { localPlayer.x -= CONFIG.MOVE_SPEED; localPlayer.facing = 'left'; moving = true; movedThisFrame = true; }
    if (keys.ArrowRight) { localPlayer.x += CONFIG.MOVE_SPEED; localPlayer.facing = 'right'; moving = true; movedThisFrame = true; }
    localPlayer.x = Math.max(0, Math.min(CONFIG.MAP_SIZE - CONFIG.CHAR_WIDTH, localPlayer.x));

    if (keys.ArrowUp && localPlayer.onGround) { localPlayer.vy = CONFIG.JUMP_FORCE; localPlayer.onGround = false; }

    const prevY = localPlayer.y;
    localPlayer.vy -= CONFIG.GRAVITY;
    const nextY = prevY + localPlayer.vy;

    // A platform only catches you if you're actually landing on it from
    // above this frame (falling, and crossing its top between prevY and
    // nextY) — walking underneath it at ground level never snaps you up.
    const pTop = platformTopAt(localPlayer.x);
    let landLevel = 0; // true ground is always the fallback
    if (pTop !== null && localPlayer.vy <= 0 && prevY >= pTop && nextY <= pTop) {
      landLevel = pTop;
    } else if (pTop !== null && prevY === pTop && nextY <= pTop) {
      landLevel = pTop; // already resting on it, staying put
    }

    if (nextY <= landLevel) {
      localPlayer.y = landLevel;
      localPlayer.vy = 0;
      localPlayer.onGround = true;
    } else {
      localPlayer.y = nextY;
      localPlayer.onGround = false; // includes walking off a platform's edge — gravity keeps pulling down from here
    }

    localPlayer.state = !localPlayer.onGround ? 'jump' : (moving ? 'walk' : 'idle');
    isJumping = !localPlayer.onGround;
  } else {
    // while dead or hiding, freeze vertical/horizontal movement
    localPlayer.vy = 0;
    localPlayer.y = 0;
    localPlayer.state = 'idle';
  }

  if (localEl) {
    if (isHiding) {
      localEl.style.display = 'none'; // invisible while hidden in the house
    } else if (isDead) {
      localEl.style.display = '';
      localEl.style.backgroundImage = `url(${CONFIG.SPRITES.dead})`;
      localEl.classList.add('dead');
    } else {
      localEl.style.display = '';
      localEl.classList.remove('dead');
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
  container.style.transition = 'none'; // set below, after a forced reflow, so it reliably animates
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

  // Force layout to commit the starting position before enabling the
  // transition — without this the very first slide-in sometimes just
  // snaps into place instead of animating (the "clumsy" jump-cut).
  void container.offsetWidth;
  container.style.transition = `transform ${CONFIG.MONSTER_SLIDE_DURATION}ms ease-in-out`;
  requestAnimationFrame(() => { container.style.transform = 'translateX(0%)'; });

  const stay = duration || CONFIG.MONSTER_STAY_MS;
  setTimeout(() => {
    container.style.transform = 'translateX(100%)';
    setTimeout(() => { const el = document.getElementById('monster-overlay'); if (el) el.remove(); }, CONFIG.MONSTER_SLIDE_DURATION);
  }, stay);
}

// Note: the "X appears!" announcement is sent as its own system chat message
// by the server (sysMsg in spawnMonster) — appending another one here would
// just duplicate it, so this handler only drives the visual/local-state side.
socket.on('monsterSpawn', ({ type, duration }) => {
  if (!CONFIG.MONSTER_SPRITES[type]) CONFIG.MONSTER_SPRITES[type] = `assets/${type}.gif`;
  showMonster(type, duration || CONFIG.MONSTER_STAY_MS);
  monsterActive = { type, endsAt: Date.now() + (duration || CONFIG.MONSTER_STAY_MS), startedAt: Date.now() };
  setTimeout(() => { monsterActive = null; }, duration || CONFIG.MONSTER_STAY_MS);
});

// /house — hidden players are invisible and immune everywhere else in the
// game (see controlsLocked()); this just drives the visibility toggle.
socket.on('playerHiding', ({ id, hiding, player }) => {
  if (id === myId) {
    isHiding = hiding;
    if (localEl) localEl.style.display = hiding ? 'none' : '';
    if (!hiding && player) {
      localPlayer.x = player.x; localPlayer.y = player.y; localPlayer.vy = 0; localPlayer.onGround = true;
      updatePlayerEl(localEl, localPlayer);
    }
  } else {
    const el = remoteEls[id];
    if (!el) return;
    el.style.display = hiding ? 'none' : '';
    if (!hiding && player) updatePlayerEl(el, player);
  }
});

// When a player dies: show dead sprite and lock local controls until respawn
// Note: the public "X died from the flodder" announcement already arrives as
// its own system chat message from the server — this handler only drives the
// visual/local-state side of a death, so it doesn't duplicate that line.
socket.on('playerDied', ({ id }) => {
  if (id === myId) {
    Object.keys(inventory).forEach(k => inventory[k] = 0);
    renderInventory();

    isDead = true;
    if (localEl) {
      localEl.style.backgroundImage = `url(${CONFIG.SPRITES.dead})`;
      localEl.classList.add('dead');
    }
  } else {
    const el = remoteEls[id];
    if (el) {
      el.style.backgroundImage = `url(${CONFIG.SPRITES.dead})`;
      el.classList.add('dead');
    }
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

// Test keys (debug only — guarded so typing "k"/"l" in chat doesn't trigger these)
document.addEventListener('keydown', (e) => {
  if (document.activeElement === chatInput) return;
  if (e.key === 'k' || e.key === 'K') {
    socket.emit('spawnMonsterNow');
    appendChatLog('System', 'Requested immediate monster spawn (test).');
  } else if (e.key === 'l' || e.key === 'L') {
    socket.emit('spawnLavaNow');
    appendChatLog('System', 'Requested immediate lava spawn (test).');
  }
});