# 2D Multiplayer Map

## Setup
1. `npm install`
2. Drop your sprite GIFs into `public/assets/`:
   - `public/assets/idle.gif`
   - `public/assets/walk.gif`
   (Same two files are reused for every player — change the paths in `public/index.js` → `CONFIG.SPRITES` if you want per-player skins.)
3. `npm start`
4. Open `http://localhost:3000` in as many browser tabs/devices as you like.

## Files
- `server.js` — Express + Socket.IO server, relays player positions.
- `public/index.html` — page shell.
- `public/style.css` — map/player styling (sizes must match `CONFIG` in index.js).
- `public/index.js` — client game logic: input, physics (walk + jump), rendering, networking.

## Tweaking
Almost everything (map size, speed, jump height, gravity, sprite paths) is in the `CONFIG` object at the top of `public/index.js`. Just remember `MAP_WIDTH`/`CHAR_WIDTH`/`CHAR_HEIGHT` should stay in sync with the matching CSS values in `style.css`.
