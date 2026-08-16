// ============================================================
// SERVER — Express + Socket.IO
// Updated: fakeflodder waits grace period before checking stationary players.
// Players are marked dead server-side and respawn after RESPAWN_MS.
// ============================================================
require('dotenv').config();
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Stripe = require('stripe');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;

// ------------------------------------------------------------
// Stripe webhook — MUST be registered with express.raw() and BEFORE
// express.json() below, since Stripe's signature check needs the exact raw
// request body. If this were parsed as JSON first, the signature would
// never verify. See handleStripeWebhook() further down for the logic.
// ------------------------------------------------------------
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => handleStripeWebhook(req, res));

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));


// ------------------------------------------------------------
// Auth — MongoDB-backed accounts (username + password, username unique) via
// Mongoose. Sessions are just a random token kept in memory (token ->
// username); no need for anything heavier for a game this size.
// Connection needs MONGO_PASS in .env; MONGO_USER/MONGO_CLUSTER/MONGODB_DB
// are optional overrides (defaulted below to match your cluster).
// ------------------------------------------------------------
const userSchema = new mongoose.Schema({
  username: { type: String, required: true },
  usernameLower: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  ownedSkins: { type: [String], default: [] }, // ids from PREMIUM_SKINS the user has paid for
  // Self-serve creator payouts (Stripe Connect Express). A user becomes a
  // "creator" just by starting onboarding — no separate signup/role needed.
  stripeAccountId: { type: String, default: null },
  stripeOnboardingComplete: { type: Boolean, default: false }, // true once Stripe confirms charges_enabled && payouts_enabled
  createdAt: { type: Date, default: Date.now },
});
const User = mongoose.model('User', userSchema);

// One row per completed purchase — not strictly needed for the game to
// function (ownedSkins on User is what's actually checked), but cheap to
// keep and useful if you ever need to answer "did this payment go through"
// or reconcile against Stripe's own records.
const purchaseSchema = new mongoose.Schema({
  username: { type: String, required: true },
  skinId: { type: String, required: true },
  stripeSessionId: { type: String, required: true, unique: true },
  amountCents: { type: Number, required: true },
  creatorCutCents: { type: Number, required: true },
  creatorStripeAccountId: { type: String },
  createdAt: { type: Date, default: Date.now },
});
const Purchase = mongoose.model('Purchase', purchaseSchema);

const sessions = new Map(); // token -> username

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, username);
  return token;
}

app.post('/api/register', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: 'Username must be 3-20 characters.' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters.' });
    }

    const usernameLower = username.toLowerCase();
    const existing = await User.findOne({ usernameLower });
    if (existing) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await User.create({ username, usernameLower, passwordHash });

    const token = createSession(username);
    res.json({ token, username });
  } catch (err) {
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'That username is already taken.' });
    }
    console.error('register error:', err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');

    const user = await User.findOne({ usernameLower: username.toLowerCase() });
    if (!user) return res.status(401).json({ error: 'Incorrect username or password.' });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ error: 'Incorrect username or password.' });

    const token = createSession(user.username);
    res.json({ token, username: user.username });
  } catch (err) {
    console.error('login error:', err);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

// Lets the client silently restore a session after a page refresh.
// Accepts the token from either a POST body or (for GET requests) a header —
// used by every authenticated REST route below, not just /api/session.
function usernameFromReq(req) {
  const token = String((req.body && req.body.token) || req.headers['x-auth-token'] || '');
  return sessions.get(token) || null;
}

app.post('/api/session', (req, res) => {
  const username = usernameFromReq(req);
  if (!username) return res.status(401).json({ error: 'Session expired.' });
  res.json({ username });
});

app.post('/api/logout', (req, res) => {
  sessions.delete(String(req.body.token || ''));
  res.json({ ok: true });
});

// ------------------------------------------------------------
// Premium skins — real-money purchases via Stripe Connect. To add a new
// one: give it an id below, create a matching Product/Price in the Stripe
// Dashboard, put its Price id in .env, and set creatorUsername to the game
// account of whoever should get the cut — they onboard themselves via
// /api/creator/onboard (see further down), no manual Stripe account
// creation on your end anymore. priceEUR/creatorCutEUR are just for
// display — the ACTUAL charge/split amounts come from Stripe (the Price
// object for the charge, application_fee_amount for the split), so those
// two numbers must be kept in sync with what you set up in Stripe.
// ------------------------------------------------------------
const PREMIUM_SKINS = {
  aqua: {
    id: 'aqua',
    name: 'Aqua',
    priceEUR: 2.00,
    creatorCutEUR: 1.00,
    stripePriceId: process.env.STRIPE_PRICE_AQUA_SKIN,
    creatorUsername: process.env.AQUA_CREATOR_USERNAME, // their game username, not a raw Stripe id
  },
};

// Looks up the creator's Stripe account for a skin — returns null if they
// haven't been assigned, haven't onboarded yet, or onboarding isn't done.
// Confirms (and self-heals) a user's onboarding status directly against
// Stripe, rather than trusting only whatever the account.updated webhook
// last reported — that webhook needs its own separate "listen to events on
// connected accounts" subscription in the Dashboard, which is easy to miss,
// and this way nothing gets permanently stuck on "not done yet" if it was.
async function ensureOnboardingStatus(user) {
  if (!user || !user.stripeAccountId || user.stripeOnboardingComplete || !stripe) {
    return user ? user.stripeOnboardingComplete : false;
  }
  try {
    const account = await stripe.accounts.retrieve(user.stripeAccountId);
    const ready = !!(account.charges_enabled && account.payouts_enabled);
    if (ready !== user.stripeOnboardingComplete) {
      user.stripeOnboardingComplete = ready;
      await user.save();
    }
    return ready;
  } catch (err) {
    console.error('Error checking Stripe account status:', err);
    return user.stripeOnboardingComplete;
  }
}

async function resolveCreatorAccount(skin) {
  if (!skin.creatorUsername) return null;
  const creator = await User.findOne({ usernameLower: skin.creatorUsername.toLowerCase() });
  if (!creator || !creator.stripeAccountId) return null;
  const ready = await ensureOnboardingStatus(creator);
  return ready ? creator.stripeAccountId : null;
}

app.get('/api/premium/owned', async (req, res) => {
  const username = usernameFromReq(req);
  if (!username) return res.status(401).json({ error: 'Not logged in.' });
  const user = await User.findOne({ usernameLower: username.toLowerCase() });
  res.json({ ownedSkins: user ? user.ownedSkins : [] });
});

app.post('/api/premium/checkout', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Payments are not configured on this server.' });

    const username = usernameFromReq(req);
    if (!username) return res.status(401).json({ error: 'Not logged in.' });

    const skin = PREMIUM_SKINS[req.body.skinId];
    if (!skin) return res.status(404).json({ error: 'Unknown skin.' });
    if (!skin.stripePriceId) {
      return res.status(500).json({ error: `${skin.name} isn't fully set up yet (missing Stripe price).` });
    }

    const creatorAccountId = await resolveCreatorAccount(skin);
    if (!creatorAccountId) {
      return res.status(500).json({ error: `${skin.name}'s creator hasn't finished onboarding yet — check back later.` });
    }

    const user = await User.findOne({ usernameLower: username.toLowerCase() });
    if (user && user.ownedSkins.includes(skin.id)) {
      return res.status(409).json({ error: 'You already own this skin.' });
    }

    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const creatorCutCents = Math.round(skin.creatorCutEUR * 100);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: skin.stripePriceId, quantity: 1 }],
      payment_intent_data: {
        application_fee_amount: creatorCutCents, // this slice goes to the creator, the rest stays with you
        transfer_data: { destination: creatorAccountId },
      },
      metadata: { username, skinId: skin.id },
      success_url: `${baseUrl}/?purchase=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?purchase=cancelled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('checkout error:', err);
    // Surfacing the real Stripe message (not just a generic one) — this is
    // almost always a Connect config issue (e.g. the connected account
    // missing a capability), and err.message says exactly which one.
    res.status(500).json({ error: err.message ? `Checkout failed: ${err.message}` : 'Could not start checkout. Try again.' });
  }
});

// Grants a skin from a completed Checkout Session — shared by both the
// webhook (handleStripeWebhook, further down) and /api/premium/confirm just
// below. Having two paths to the same result is intentional: webhooks can
// fail to arrive for all sorts of reasons outside your control (a
// misconfigured endpoint, Stripe having an incident, a firewall), so the
// confirm endpoint — called the instant the browser lands back on
// success_url — makes unlocking the skin NOT depend on the webhook ever
// showing up, while the webhook still runs too in case the browser never
// makes it back (closed tab, connection drop, etc). $addToSet plus the
// unique index on stripeSessionId make it safe if both paths run for the
// same purchase.
async function grantSkinFromSession(session) {
  const { username, skinId } = session.metadata || {};
  const skin = PREMIUM_SKINS[skinId];
  if (!username || !skin) return null;

  await User.updateOne(
    { usernameLower: username.toLowerCase() },
    { $addToSet: { ownedSkins: skin.id } }
  );

  try {
    const creatorAccountId = await resolveCreatorAccount(skin);
    await Purchase.create({
      username,
      skinId: skin.id,
      stripeSessionId: session.id,
      amountCents: session.amount_total,
      creatorCutCents: Math.round(skin.creatorCutEUR * 100),
      creatorStripeAccountId: creatorAccountId,
    });
  } catch (err) {
    if (err.code !== 11000) console.error('Error recording purchase:', err); // 11000 = already recorded by the other path
  }

  return skin;
}

// Called by the client the instant it lands back on success_url — verifies
// the payment directly with Stripe (never trusts the client's say-so) and
// grants the skin right away instead of waiting on the webhook.
app.post('/api/premium/confirm', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Payments are not configured on this server.' });

    const username = usernameFromReq(req);
    if (!username) return res.status(401).json({ error: 'Not logged in.' });

    const sessionId = String(req.body.sessionId || '');
    if (!sessionId) return res.status(400).json({ error: 'Missing session id.' });

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (session.payment_status !== 'paid') {
      return res.status(402).json({ error: 'Payment has not completed yet.' });
    }
    if (!session.metadata || session.metadata.username !== username) {
      return res.status(403).json({ error: 'This purchase belongs to a different account.' });
    }

    const skin = await grantSkinFromSession(session);
    if (!skin) return res.status(404).json({ error: 'Unknown skin.' });

    res.json({ ok: true, skinId: skin.id });
  } catch (err) {
    console.error('confirm error:', err);
    res.status(500).json({ error: 'Could not confirm your purchase — contact support if this keeps happening.' });
  }
});

// ------------------------------------------------------------
// Creator self-onboarding (Stripe Connect Express). Any logged-in game
// account can become a creator this way — you still separately decide who
// gets paid for what by setting creatorUsername on a skin in PREMIUM_SKINS,
// this just removes the need for you to manually create their Stripe
// account and hand them a link.
// ------------------------------------------------------------
// ------------------------------------------------------------
// Creator self-onboarding (Stripe Connect Express). Any logged-in game
// account can become a creator this way — you still separately decide who
// gets paid for what by setting creatorUsername on a skin in PREMIUM_SKINS,
// this just removes the need for you to manually create their Stripe
// account and hand them a link.
//
// Access is gated by this allowlist — add a username here to let them in.
// Everyone else gets a "contact us" message instead of ever reaching Stripe.
// ------------------------------------------------------------
const CREATOR_ALLOWLIST = [
  // 'SomeArtistUsername',
];
const CREATOR_CONTACT_MESSAGE = 'You need to contact plypoode@gmail.com to become a Crahden creator.';

function isAllowedCreator(username) {
  return CREATOR_ALLOWLIST.some((u) => u.toLowerCase() === username.toLowerCase());
}

app.post('/api/creator/onboard', async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: 'Payments are not configured on this server.' });

    const username = usernameFromReq(req);
    if (!username) return res.status(401).json({ error: 'Not logged in.' });

    const user = await User.findOne({ usernameLower: username.toLowerCase() });
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    // Already has an account (allowlisted in the past, or already started) —
    // let them continue/resume even if they were later removed from the
    // list, rather than stranding an in-progress or completed onboarding.
    if (!user.stripeAccountId && !isAllowedCreator(username)) {
      return res.status(403).json({ error: CREATOR_CONTACT_MESSAGE });
    }

    let accountId = user.stripeAccountId;
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }, // this is the one that actually matters for receiving a skin's cut
        },
      });
      accountId = account.id;
      user.stripeAccountId = accountId;
      await user.save();
    }

    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const accountLink = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${baseUrl}/api/creator/onboard-refresh?token=${encodeURIComponent(req.body.token || '')}`,
      return_url: `${baseUrl}/?onboarding=return`,
      type: 'account_onboarding',
    });

    res.json({ url: accountLink.url });
  } catch (err) {
    console.error('creator onboard error:', err);
    res.status(500).json({ error: 'Could not start onboarding. Try again.' });
  }
});

// Stripe redirects here (a plain browser navigation, not a fetch call) if an
// onboarding link expired or something went wrong mid-flow — regenerate a
// fresh link and bounce the creator straight back into it.
app.get('/api/creator/onboard-refresh', async (req, res) => {
  try {
    const username = sessions.get(String(req.query.token || ''));
    if (!username || !stripe) return res.redirect('/');

    const user = await User.findOne({ usernameLower: username.toLowerCase() });
    if (!user || !user.stripeAccountId) return res.redirect('/');

    const baseUrl = process.env.APP_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const accountLink = await stripe.accountLinks.create({
      account: user.stripeAccountId,
      refresh_url: `${baseUrl}/api/creator/onboard-refresh?token=${encodeURIComponent(req.query.token)}`,
      return_url: `${baseUrl}/?onboarding=return`,
      type: 'account_onboarding',
    });
    res.redirect(accountLink.url);
  } catch (err) {
    console.error('onboard-refresh error:', err);
    res.redirect('/');
  }
});

app.get('/api/creator/status', async (req, res) => {
  const username = usernameFromReq(req);
  if (!username) return res.status(401).json({ error: 'Not logged in.' });
  const user = await User.findOne({ usernameLower: username.toLowerCase() });
  const onboardingComplete = await ensureOnboardingStatus(user);
  res.json({
    isCreator: !!(user && user.stripeAccountId),
    onboardingComplete,
  });
});

// Called by app.post('/api/stripe/webhook', ...) registered up near the top
// of the file (has to be before express.json() — see the comment there).
async function handleStripeWebhook(req, res) {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send('Webhook not configured.');
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    try {
      const skin = await grantSkinFromSession(session);
      if (skin) console.log(`${session.metadata?.username} unlocked premium skin "${skin.id}" (via webhook)`);
    } catch (err) {
      console.error('Error granting skin from webhook:', err);
    }
  }

  // Fired whenever a connected account's status changes — this is how we
  // find out a creator has actually finished onboarding (Stripe reviews
  // their submitted info asynchronously, so "finished the form" and
  // "cleared to receive payouts" aren't the same moment).
  if (event.type === 'account.updated') {
    const account = event.data.object;
    const ready = !!(account.charges_enabled && account.payouts_enabled);
    try {
      await User.updateOne(
        { stripeAccountId: account.id },
        { $set: { stripeOnboardingComplete: ready } }
      );
    } catch (err) {
      console.error('Error updating creator onboarding status:', err);
    }
  }

  res.json({ received: true });
}

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
    io.to(code).emit('playerRespawn', { id: pid, player: publicPlayer(room.players[pid]) });
  }, RESPAWN_MS);
}

// Server-internal bookkeeping (hideTimer is a Node Timeout object, which
// socket.io's serializer will crash trying to inspect — "Maximum call stack
// size exceeded" in hasBinary — if it's ever included in an emit). Every
// player object that goes out over a socket must go through this first.
function publicPlayer(p) {
  if (!p) return p;
  const { x, y, facing, state, outfit, username, dead, hiding } = p;
  return { x, y, facing, state, outfit, username, dead, hiding };
}

function publicPlayers(players) {
  const out = {};
  Object.keys(players).forEach((id) => { out[id] = publicPlayer(players[id]); });
  return out;
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

  io.to(code).emit('playerHiding', { id: socketId, hiding: false, player: publicPlayer(p) });
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
      players: publicPlayers(room.players),
      trees: room.trees,
      purchasableItems: room.purchasableItems,
      fireOn: room.fireOn,
    });

    socket.to(code).emit('playerJoined', { id: socket.id, player: publicPlayer(room.players[socket.id]) });

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

    socket.to(code).emit('playerUpdated', { id: socket.id, player: publicPlayer(room.players[socket.id]) });
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
          zIndex: n.zIndex != null ? n.zIndex : item.zIndex,
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

// Only MONGO_PASS is required — these default to match your cluster, but
// can be overridden in .env if you ever rotate the user or move clusters.
const MONGO_USER = process.env.MONGO_USER || 'Cfroz';
const MONGO_CLUSTER = process.env.MONGO_CLUSTER || 'cluster0.qbivfie.mongodb.net';
const MONGO_DB = process.env.MONGODB_DB || 'crahden';

async function start() {
  if (!process.env.MONGO_PASS) {
    console.error('Missing MONGO_PASS in .env — the login system needs it to connect to MongoDB.');
    process.exit(1);
  }
  if (!stripe) {
    console.warn('STRIPE_SECRET_KEY not set — premium skins will be disabled, everything else still works.');
  } else if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('STRIPE_WEBHOOK_SECRET not set — checkouts can start but purchases will never actually unlock a skin.');
  }

  await mongoose.connect(
    `mongodb+srv://${MONGO_USER}:${process.env.MONGO_PASS}@${MONGO_CLUSTER}/${MONGO_DB}`
  );
  await User.init(); // makes sure the unique index on usernameLower exists before we accept registrations
  console.log('Connected to MongoDB');

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start();