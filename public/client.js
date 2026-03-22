// ── SOCKET & STATE ────────────────────────────────────────────────────────────
const socket = io();
let myId = null;
let players = {};

// Camera in world-tile coords (float, for smooth feel)
let camX = 0, camY = 0;

// Zoom: how many pixels per character cell
// 16 = default (1×), range 6–32
let cellSize = 16;
const CELL_MIN = 6;
const CELL_MAX = 36;

// Input
const pressedKeys = new Set();
let chatFocused = false;

// DOM refs
const canvas       = document.getElementById('gameCanvas');
const ctx          = canvas.getContext('2d');
const chatLog      = document.getElementById('chatLog');
const playerListEl = document.getElementById('playerList');
const chatInput    = document.getElementById('chatInput');
const startScreen  = document.getElementById('startScreen');
const hud          = document.getElementById('hud');
const coordsEl     = document.getElementById('coords');
const zoomEl       = document.getElementById('zoomDisplay');

// ── JOIN ──────────────────────────────────────────────────────────────────────
function joinGame() {
  const name  = document.getElementById('nameInput').value.trim() || 'Wanderer';
  const char  = document.getElementById('charInput').value.trim()[0] || '@';
  const color = document.getElementById('colorInput').value || '#00ff88';

  startScreen.style.display = 'none';
  hud.style.display = 'block';
  resizeCanvas();
  socket.emit('setInfo', { name, char, color });
  render();
}

// ── DETERMINISTIC WORLD GENERATION ───────────────────────────────────────────
// Uses a hash of (wx, wy) so the map is infinite, seamless, and consistent
// across all clients with NO server involvement.

function hash2(x, y) {
  // Quick integer hash (no external lib needed)
  let h = (x * 1619 + y * 31337 + x * y * 277) | 0;
  h ^= (h >>> 17);
  h  = Math.imul(h, 0xbf58476d);
  h ^= (h >>> 31);
  h  = Math.imul(h, 0x94d049bb);
  h ^= (h >>> 32);
  return (h >>> 0) / 0xffffffff; // 0..1
}

// Smooth noise via bilinear interpolation of hashed grid points
function smoothNoise(x, y, scale) {
  const sx = x / scale;
  const sy = y / scale;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = sx - ix, fy = sy - iy;
  // Smoothstep
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix,   iy);
  const b = hash2(ix+1, iy);
  const c = hash2(ix,   iy+1);
  const d = hash2(ix+1, iy+1);
  return a + (b-a)*ux + (c-a)*uy + (d-b)*ux*uy + (a-c)*ux*uy - (a-b)*ux*uy;
}

// Layered noise (octaves) for more organic terrain
function terrainNoise(wx, wy) {
  return (
    smoothNoise(wx, wy, 12) * 0.50 +
    smoothNoise(wx, wy, 5)  * 0.30 +
    smoothNoise(wx, wy, 2)  * 0.20
  );
}

// Tile definitions: [char, cssColor]
const TILES = {
  deep:   ['~', '#1a5f7a'],
  water:  ['~', '#2a8fa0'],
  shore:  ['.', '#8a7340'],
  plain:  ['.', '#3a5c25'],
  grass:  ['"', '#4a7a28'],
  forest: ['T', '#2d5c18'],
  hill:   ['^', '#6b7355'],
  rock:   ['#', '#555e66'],
  peak:   ['*', '#aab5bd'],
};

function getWorldTile(wx, wy) {
  const n = terrainNoise(wx, wy);
  if (n < 0.18) return TILES.deep;
  if (n < 0.28) return TILES.water;
  if (n < 0.33) return TILES.shore;
  if (n < 0.50) return TILES.plain;
  if (n < 0.60) return TILES.grass;
  if (n < 0.68) return TILES.forest;
  if (n < 0.76) return TILES.hill;
  if (n < 0.86) return TILES.rock;
  return TILES.peak;
}

// ── CANVAS RENDERING ──────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

window.addEventListener('resize', () => { resizeCanvas(); render(); });

// Which font size + family gives a 1:1 square cell?
// Share Tech Mono is close to 0.6 aspect ratio. We force it square by drawing
// each char in a cellSize × cellSize box, centered.
function setFont() {
  // A monospace char at `px` font-size is roughly 0.6× wide.
  // We want char width == cellSize, so font-size = cellSize / 0.6
  const fs = Math.round(cellSize / 0.6);
  ctx.font = `${fs}px 'Share Tech Mono', monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
}

function render() {
  if (!myId) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Fill background
  ctx.fillStyle = '#060a0c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  setFont();

  // How many cells fit on screen
  const cols = Math.ceil(canvas.width  / cellSize) + 2;
  const rows = Math.ceil(canvas.height / cellSize) + 2;

  // Top-left world tile (camX/camY is center of screen)
  const startWX = Math.floor(camX - cols / 2);
  const startWY = Math.floor(camY - rows / 2);

  // Pixel offset of startWX tile (for sub-tile scrolling)
  const offX = (canvas.width  / 2) - (camX - startWX) * cellSize;
  const offY = (canvas.height / 2) - (camY - startWY) * cellSize;

  // Build a player lookup: "wx,wy" → player
  const playerAt = {};
  for (const id in players) {
    const p = players[id];
    playerAt[`${p.x},${p.y}`] = p;
  }

  // Draw tiles
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const wx = startWX + col;
      const wy = startWY + row;
      const px = offX + col * cellSize + cellSize * 0.5;
      const py = offY + row * cellSize + cellSize * 0.5;

      const key = `${wx},${wy}`;
      const player = playerAt[key];

      if (player) {
        // Draw tile behind (dimmed)
        const [tc, tColor] = getWorldTile(wx, wy);
        ctx.fillStyle = tColor + '44';
        ctx.fillText(tc, px, py);

        // Draw player
        const isMe = player.id === myId;
        if (isMe) {
          // Subtle glow behind self
          ctx.shadowColor = player.color || '#00ff88';
          ctx.shadowBlur  = cellSize * 1.2;
        }
        ctx.fillStyle = player.color || '#00ff88';
        ctx.fillText(player.char || '@', px, py);
        ctx.shadowBlur = 0;
      } else {
        const [tc, tColor] = getWorldTile(wx, wy);
        ctx.fillStyle = tColor;
        ctx.fillText(tc, px, py);
      }
    }
  }

  // Update HUD text
  const me = players[myId];
  if (me) {
    coordsEl.textContent = `${me.x}, ${me.y}`;
  }
  const zoom = (cellSize / 16).toFixed(2);
  zoomEl.textContent = `ZOOM ${zoom}×`;
}

// ── CENTER CAMERA ON PLAYER ───────────────────────────────────────────────────
function centerOnMe() {
  const me = players[myId];
  if (me) { camX = me.x; camY = me.y; }
}

// ── PLAYER LIST ───────────────────────────────────────────────────────────────
function updatePlayerList() {
  const entries = Object.values(players);
  playerListEl.innerHTML = entries.map(p => {
    const tag = p.id === myId ? ' ◂' : '';
    return `<div style="color:${p.color || '#8fbfcf'}">${p.name}${tag}</div>`;
  }).join('');
}

// ── CHAT ─────────────────────────────────────────────────────────────────────
function addChatMessage(name, message, color) {
  const el = document.createElement('div');
  el.className = 'chat-msg';
  el.innerHTML = `<span class="chat-name" style="color:${color||'#00ff88'}">${escHtml(name)}</span>${escHtml(message)}`;
  chatLog.appendChild(el);
  // Fade after 6s, remove after 7s
  setTimeout(() => el.classList.add('fading'), 6000);
  setTimeout(() => el.remove(), 7000);
  // Keep max 8 messages visible
  while (chatLog.children.length > 8) chatLog.firstChild.remove();
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
socket.on('joined', data => {
  myId = data.id;
  players = data.players;
  centerOnMe();
  render();
  updatePlayerList();
});

socket.on('newPlayer', p => {
  players[p.id] = p;
  render();
  updatePlayerList();
});

socket.on('playerUpdate', data => {
  if (players[data.id]) Object.assign(players[data.id], data);
  render();
  updatePlayerList();
});

socket.on('playerMoved', data => {
  if (!players[data.id]) return;
  players[data.id].x = data.x;
  players[data.id].y = data.y;
  // Follow self
  if (data.id === myId) centerOnMe();
  render();
});

socket.on('playerLeft', id => {
  delete players[id];
  render();
  updatePlayerList();
});

socket.on('chatMessage', data => {
  const p = players[Object.keys(players).find(k => players[k].name === data.name)];
  addChatMessage(data.name, data.message, p?.color);
});

// ── INPUT ─────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (startScreen.style.display !== 'none') return;

  // Enter opens / submits chat
  if (e.key === 'Enter') {
    if (chatFocused) {
      const msg = chatInput.value.trim();
      if (msg) { socket.emit('chat', msg); chatInput.value = ''; }
      chatInput.blur();
      chatFocused = false;
    } else {
      chatInput.focus();
      chatFocused = true;
    }
    return;
  }

  if (chatFocused) return;

  const key = e.key.toLowerCase();
  pressedKeys.add(key);

  if (key === ' ') { centerOnMe(); render(); e.preventDefault(); }

  // Arrow keys → also move
  if (e.key === 'ArrowUp')    pressedKeys.add('w');
  if (e.key === 'ArrowDown')  pressedKeys.add('s');
  if (e.key === 'ArrowLeft')  pressedKeys.add('a');
  if (e.key === 'ArrowRight') pressedKeys.add('d');
});

document.addEventListener('keyup', e => {
  pressedKeys.delete(e.key.toLowerCase());
  if (e.key === 'ArrowUp')    pressedKeys.delete('w');
  if (e.key === 'ArrowDown')  pressedKeys.delete('s');
  if (e.key === 'ArrowLeft')  pressedKeys.delete('a');
  if (e.key === 'ArrowRight') pressedKeys.delete('d');
});

chatInput.addEventListener('focus', () => { chatFocused = true;  pressedKeys.clear(); });
chatInput.addEventListener('blur',  () => { chatFocused = false; pressedKeys.clear(); });

// ── ZOOM (SCROLL WHEEL) ───────────────────────────────────────────────────────
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const delta = -Math.sign(e.deltaY);
  // Zoom step: ±1 px per cell
  cellSize = Math.max(CELL_MIN, Math.min(CELL_MAX, cellSize + delta * 2));
  render();
}, { passive: false });

// ── MOVEMENT LOOP ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (chatFocused || !myId) return;
  let moved = false;
  if (pressedKeys.has('w')) { socket.emit('move', 'up');    moved = true; }
  if (pressedKeys.has('s')) { socket.emit('move', 'down');  moved = true; }
  if (pressedKeys.has('a')) { socket.emit('move', 'left');  moved = true; }
  if (pressedKeys.has('d')) { socket.emit('move', 'right'); moved = true; }
  if (moved) render();
}, 80);
