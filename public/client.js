// ── SOCKET ────────────────────────────────────────────────────────────────────
const socket = io();

// ── STATE ─────────────────────────────────────────────────────────────────────
let myId = null;
let players = {};
let mapTiles = [];
let MAP_W = 300, MAP_H = 150;
let CFG = {};

// Camera: center of view in world-tile coords
let camX = 0, camY = 0;

// Zoom: pixels per cell
let cellSize = 7;         // start zoomed out to see full map
const CELL_MIN = 4;
const CELL_MAX = 32;

// Input
const pressedKeys = new Set();
let chatFocused = false;

// Targeting
let targetId = null;

// DOM
const canvas       = document.getElementById('gameCanvas');
const ctx          = canvas.getContext('2d');
const chatLogEl    = document.getElementById('chatLog');
const chatInput    = document.getElementById('chatInput');
const startScreen  = document.getElementById('startScreen');
const gameWrap     = document.getElementById('gameWrap');
const coordsEl     = document.getElementById('coordsDisplay');
const zoomEl       = document.getElementById('zoomDisplay');
const leaderboardEl= document.getElementById('leaderboard');
const nearbyEl     = document.getElementById('nearbyList');
const playerCountEl= document.getElementById('playerCount');
const winOverlay   = document.getElementById('winOverlay');
const targetDisplay= document.getElementById('targetDisplay');

// My status els
const myCharEl  = document.getElementById('myChar');
const myNameEl  = document.getElementById('myName');
const hpFillEl  = document.getElementById('hpFill');
const apFillEl  = document.getElementById('apFill');
const hpNumEl   = document.getElementById('hpNum');
const apNumEl   = document.getElementById('apNum');
const myKillsEl = document.getElementById('myKills');

// ── JOIN ──────────────────────────────────────────────────────────────────────
function joinGame() {
  const name  = document.getElementById('nameInput').value.trim() || 'Wanderer';
  const char  = document.getElementById('charInput').value[0] || '@';
  const color = document.getElementById('colorInput').value || '#00ff88';
  socket.emit('setInfo', { name, char, color });
  startScreen.style.display = 'none';
  gameWrap.style.display = 'block';
  resizeCanvas();
}

// ── CANVAS SETUP ─────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  render();
}
window.addEventListener('resize', resizeCanvas);

// ── TILE COLORS & CHARS ───────────────────────────────────────────────────────
const TILE_STYLE = {
  '.': { char: '.', color: '#1a2a18', bright: '#233020' },
  '#': { char: '#', color: '#3a4048', bright: '#505860' },
  '~': { char: '~', color: '#0d3a50', bright: '#1a5070' },
  'T': { char: 'T', color: '#1d4a18', bright: '#2a6020' },
  '"': { char: '"', color: '#244018', bright: '#305520' },
};

function getTileStyle(ch) {
  return TILE_STYLE[ch] || TILE_STYLE['.'];
}

// ── RENDERING ─────────────────────────────────────────────────────────────────
const PANEL_W = 180;
const CHAT_H  = 38;

function setFont(size) {
  // Force square cells: Share Tech Mono natural ratio ~0.58
  // We set font-size so that one char width ≈ cellSize
  const fs = Math.round(size / 0.58);
  ctx.font = `${fs}px 'Share Tech Mono', monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
}

function render() {
  if (!myId || !mapTiles.length) return;

  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#07090b';
  ctx.fillRect(0, 0, W, H);

  setFont(cellSize);

  // Viewport excluding panels
  const vpLeft   = PANEL_W;
  const vpRight  = W - PANEL_W;
  const vpTop    = 0;
  const vpBottom = H - CHAT_H;
  const vpW = vpRight - vpLeft;
  const vpH = vpBottom - vpTop;

  const cols = Math.ceil(vpW / cellSize) + 2;
  const rows = Math.ceil(vpH / cellSize) + 2;

  const startWX = Math.floor(camX - cols / 2);
  const startWY = Math.floor(camY - rows / 2);

  const offX = vpLeft + vpW / 2 - (camX - startWX) * cellSize;
  const offY = vpTop  + vpH / 2 - (camY - startWY) * cellSize;

  // Build player lookup
  const playerAt = {};
  for (const id in players) {
    const p = players[id];
    if (p.alive) playerAt[`${p.x},${p.y}`] = p;
  }

  // ── Draw tiles + players ──
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const wx = startWX + col;
      const wy = startWY + row;

      // Clip to map bounds
      if (wx < 0 || wx >= MAP_W || wy < 0 || wy >= MAP_H) continue;

      const px = offX + col * cellSize + cellSize * 0.5;
      const py = offY + row * cellSize + cellSize * 0.5;

      // Don't draw outside viewport
      if (px < vpLeft - cellSize || px > vpRight + cellSize) continue;
      if (py < vpTop  - cellSize || py > vpBottom + cellSize) continue;

      const tileCh = mapTiles[wy]?.[wx] || '.';
      const ts = getTileStyle(tileCh);
      const player = playerAt[`${wx},${wy}`];

      if (player) {
        const isMe = player.id === myId;
        const isTarget = player.id === targetId;

        // Draw tile dim behind player
        ctx.fillStyle = ts.color;
        ctx.fillText(ts.char, px, py);

        // Glow for self
        if (isMe) {
          ctx.shadowColor = player.color;
          ctx.shadowBlur  = cellSize * 1.5;
        } else if (isTarget) {
          ctx.shadowColor = '#ffa500';
          ctx.shadowBlur  = cellSize * 1.2;
        }

        // Dead player indicator (ghost)
        ctx.fillStyle = player.color || '#00ff88';
        ctx.fillText(player.char || '@', px, py);
        ctx.shadowBlur = 0;

        // HP bar under player (tiny)
        if (cellSize >= 10 && CFG.HP_MAX) {
          const barW = cellSize - 2;
          const barH = 2;
          const bx = px - barW / 2;
          const by = py + cellSize * 0.5 + 1;
          ctx.fillStyle = '#200a0a';
          ctx.fillRect(bx, by, barW, barH);
          ctx.fillStyle = player.hp <= 1 ? '#ff3a4a' : '#ff6040';
          ctx.fillRect(bx, by, barW * (player.hp / CFG.HP_MAX), barH);
        }

      } else {
        // Slightly brighten border tiles
        const isBorder = wx === 0 || wx === MAP_W-1 || wy === 0 || wy === MAP_H-1;
        ctx.fillStyle = isBorder ? '#404850' : ts.color;
        ctx.fillText(ts.char, px, py);
      }
    }
  }

  // ── Attack range ring for self (when targeting) ──
  if (targetId && players[myId] && cellSize >= 8) {
    const me = players[myId];
    const rangeTiles = CFG.ATTACK_RANGE_DEFAULT || 2;
    const ringPx = rangeTiles * cellSize;
    const myPx = offX + (me.x - startWX) * cellSize + cellSize * 0.5;
    const myPy = offY + (me.y - startWY) * cellSize + cellSize * 0.5;
    ctx.strokeStyle = 'rgba(255,164,0,0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(myPx - ringPx - cellSize*0.5, myPy - ringPx - cellSize*0.5, ringPx*2+cellSize, ringPx*2+cellSize);
    ctx.setLineDash([]);
  }

  // ── Map border outline ──
  const bx0 = offX + (0 - startWX) * cellSize + cellSize * 0.5;
  const by0 = offY + (0 - startWY) * cellSize + cellSize * 0.5;
  const bxW = MAP_W * cellSize;
  const byH = MAP_H * cellSize;
  ctx.strokeStyle = 'rgba(100,140,180,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx0 - cellSize*0.5, by0 - cellSize*0.5, bxW, byH);

  // ── Update HUD ──
  updateHUD();
}

// ── HUD UPDATES ───────────────────────────────────────────────────────────────
function updateHUD() {
  const me = players[myId];
  if (!me) return;

  // Coords
  coordsEl.textContent = `${me.x}, ${me.y}`;
  zoomEl.textContent   = `ZOOM ${(cellSize / 16).toFixed(2)}×`;

  // My status
  myCharEl.textContent  = me.char;
  myCharEl.style.color  = me.color;
  myNameEl.textContent  = me.name;
  hpNumEl.textContent   = me.hp;
  apNumEl.textContent   = me.ap;
  if (CFG.HP_MAX) hpFillEl.style.width = `${(me.hp / CFG.HP_MAX) * 100}%`;
  if (CFG.AP_MAX) apFillEl.style.width = `${(me.ap / CFG.AP_MAX) * 100}%`;
  myKillsEl.textContent = me.kills;

  // Target display
  if (targetId && players[targetId]) {
    const t = players[targetId];
    targetDisplay.style.display = 'block';
    document.getElementById('targetName').textContent = `${t.char} ${t.name}`;
    document.getElementById('targetName').style.color = t.color;
    document.getElementById('targetHp').textContent   = `HP: ${'♥'.repeat(t.hp)}${'♡'.repeat(Math.max(0,CFG.HP_MAX-t.hp))}`;
  } else {
    targetDisplay.style.display = 'none';
  }

  // Leaderboard (top 8 by kills)
  const sorted = Object.values(players)
    .filter(p => p.alive)
    .sort((a,b) => b.kills - a.kills)
    .slice(0, 8);

  leaderboardEl.innerHTML = sorted.map(p => `
    <div class="lb-row ${p.id===myId?'lb-me':''}">
      <span class="lb-char" style="color:${p.color}">${p.char}</span>
      <span class="lb-name">${escHtml(p.name)}</span>
      <span class="lb-kills">${p.kills}</span>
      <span class="lb-hp">${p.hp}♥</span>
    </div>
  `).join('');

  // Player count
  const alive = Object.values(players).filter(p=>p.alive).length;
  playerCountEl.textContent = `${alive} alive · ${Object.keys(players).length} total`;

  // Nearby players (within 20 tiles)
  const nearby = Object.values(players)
    .filter(p => p.id !== myId && p.alive)
    .map(p => ({ ...p, dist: chebyshev(me.x, me.y, p.x, p.y) }))
    .filter(p => p.dist <= 20)
    .sort((a,b) => a.dist - b.dist)
    .slice(0, 8);

  nearbyEl.innerHTML = nearby.map(p => `
    <div class="nearby-row" onclick="setTarget('${p.id}')">
      <span class="nearby-char" style="color:${p.color}">${p.char}</span>
      <span class="nearby-name">${escHtml(p.name)}</span>
      <span class="nearby-dist">${p.dist}t</span>
    </div>
  `).join('') || '<div style="font-size:9px;color:var(--text-dim);letter-spacing:1px">none nearby</div>';
}

function chebyshev(ax, ay, bx, by) { return Math.max(Math.abs(ax-bx), Math.abs(ay-by)); }

// ── TARGET ────────────────────────────────────────────────────────────────────
function setTarget(id) {
  targetId = id;
  render();
}

// ── ACTIONS ───────────────────────────────────────────────────────────────────
function doAttack(extraRange) {
  if (!targetId) { addChat('System', 'No target selected. Click a player.', null, 'system'); return; }
  socket.emit('attack', { targetId, extraRange });
}

function doDonate(amount) {
  if (!targetId) { addChat('System', 'No target selected.', null, 'system'); return; }
  socket.emit('donate', { targetId, amount });
}

// ── CANVAS CLICK → TARGET ─────────────────────────────────────────────────────
canvas.addEventListener('click', (e) => {
  if (!myId || !mapTiles.length) return;

  const W = canvas.width, H = canvas.height;
  const vpLeft = PANEL_W, vpRight = W - PANEL_W;
  const vpTop = 0, vpBottom = H - CHAT_H;
  const vpW = vpRight - vpLeft, vpH = vpBottom - vpTop;
  const cols = Math.ceil(vpW / cellSize) + 2;
  const rows = Math.ceil(vpH / cellSize) + 2;
  const startWX = Math.floor(camX - cols / 2);
  const startWY = Math.floor(camY - rows / 2);
  const offX = vpLeft + vpW / 2 - (camX - startWX) * cellSize;
  const offY = vpTop  + vpH / 2 - (camY - startWY) * cellSize;

  const wx = Math.floor((e.clientX - offX) / cellSize) + startWX;
  const wy = Math.floor((e.clientY - offY) / cellSize) + startWY;

  // Find player at clicked tile
  const clicked = Object.values(players).find(p => p.alive && p.x === wx && p.y === wy && p.id !== myId);
  if (clicked) {
    setTarget(clicked.id);
  } else {
    targetId = null;
    render();
  }
});

// ── ZOOM ──────────────────────────────────────────────────────────────────────
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = -Math.sign(e.deltaY);
  cellSize = Math.max(CELL_MIN, Math.min(CELL_MAX, cellSize + delta * 2));
  render();
}, { passive: false });

// ── CENTER ON ME ──────────────────────────────────────────────────────────────
function centerOnMe() {
  const me = players[myId];
  if (me) { camX = me.x; camY = me.y; }
}

// ── CHAT ──────────────────────────────────────────────────────────────────────
function addChat(name, message, color, type) {
  const el = document.createElement('div');
  el.className = `chat-msg${type ? ' '+type : ''}`;
  if (name) {
    el.innerHTML = `<span class="chat-name" style="color:${color||'var(--text-bright)'}">${escHtml(name)}</span>${escHtml(message)}`;
  } else {
    el.textContent = message;
  }
  chatLogEl.appendChild(el);
  setTimeout(() => el.classList.add('fading'), 7000);
  setTimeout(() => el.remove(), 8000);
  while (chatLogEl.children.length > 10) chatLogEl.firstChild.remove();
  chatLogEl.scrollTop = chatLogEl.scrollHeight;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
socket.on('joined', data => {
  myId    = data.id;
  players = data.players;
  mapTiles= data.mapTiles;
  MAP_W   = data.mapW;
  MAP_H   = data.mapH;
  CFG     = data.config;

  // Start camera at map center (overview), not on player
  camX = MAP_W / 2;
  camY = MAP_H / 2;

  if (gameWrap.style.display !== 'none') {
    resizeCanvas();
    render();
  }
  addChat(null, '— Entered the arena. SPACE to find yourself. —', null, 'system');
});

socket.on('newPlayer', p => {
  players[p.id] = p;
  addChat('System', `${p.char} ${p.name} has entered the arena.`, '#7a9ab0', 'system');
  render();
});

socket.on('playerUpdate', data => {
  if (players[data.id]) Object.assign(players[data.id], data);
  if (data.id === myId) {
    myCharEl.textContent = data.char;
    myCharEl.style.color = data.color;
  }
  render();
});

socket.on('playerMoved', data => {
  if (players[data.id]) { players[data.id].x = data.x; players[data.id].y = data.y; }
  // Follow self
  if (data.id === myId) { camX = data.x; camY = data.y; }
  render();
});

socket.on('apUpdate', data => {
  if (players[myId]) players[myId].ap = data.ap;
  updateHUD();
});

socket.on('attacked', data => {
  if (players[data.targetId]) players[data.targetId].hp = data.targetHp;
  const t = players[data.targetId];
  const a = players[data.attackerId];
  if (t && a) {
    addChat(null, `${a.char}${a.name} → ${t.char}${t.name} [${data.targetHp}HP left]`, null, 'kill');
  }
  render();
});

socket.on('playerDied', data => {
  if (players[data.id]) { players[data.id].alive = false; players[data.id].hp = 0; }
  const victim = players[data.id];
  addChat(null, `☠ ${data.killerChar}${data.killerName} eliminated ${victim?.char||''}${victim?.name||data.id}`, null, 'kill');
  if (data.id === targetId) { targetId = null; }
  render();
});

socket.on('playerRespawned', data => {
  if (players[data.id]) Object.assign(players[data.id], data);
  if (data.id === myId) {
    addChat(null, '— You have respawned. —', null, 'system');
    camX = data.x; camY = data.y;
  }
  render();
});

socket.on('killUpdate', data => {
  if (players[data.id]) players[data.id].kills = data.kills;
  render();
});

socket.on('donated', data => {
  addChat(null, `${players[data.fromId]?.name||data.fromId} gave ${data.amount}AP to ${players[data.toId]?.name||data.toId}`, null, 'system');
});

socket.on('chatMessage', data => {
  addChat(`${data.char} ${data.name}`, ': ' + data.message, data.color);
});

socket.on('playerLeft', id => {
  const p = players[id];
  if (p) addChat('System', `${p.char} ${p.name} left.`, '#7a9ab0', 'system');
  delete players[id];
  if (id === targetId) targetId = null;
  render();
});

socket.on('gameOver', data => {
  winOverlay.style.display = 'flex';
  document.getElementById('winChar').textContent = data.winnerChar;
  document.getElementById('winChar').style.color = data.winnerColor;
  document.getElementById('winName').textContent = data.winnerName;
  document.getElementById('winKills').textContent = `${data.kills} kills`;
  addChat(null, `★ ${data.winnerChar} ${data.winnerName} wins the arena! ★`, null, 'system');
});

socket.on('gameReset', data => {
  players = data.players;
  winOverlay.style.display = 'none';
  targetId = null;
  camX = MAP_W / 2;
  camY = MAP_H / 2;
  addChat(null, '— New round started. —', null, 'system');
  render();
});

// ── KEYBOARD INPUT ────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (startScreen.style.display !== 'none') return;

  if (e.key === 'Enter') {
    if (chatFocused) {
      const msg = chatInput.value.trim();
      if (msg) { socket.emit('chat', msg); chatInput.value = ''; }
      chatInput.blur(); chatFocused = false;
    } else {
      chatInput.focus(); chatFocused = true;
    }
    return;
  }

  if (chatFocused) return;
  e.preventDefault();

  const key = e.key.toLowerCase();
  pressedKeys.add(key);
  if (e.key === 'ArrowUp')    pressedKeys.add('w');
  if (e.key === 'ArrowDown')  pressedKeys.add('s');
  if (e.key === 'ArrowLeft')  pressedKeys.add('a');
  if (e.key === 'ArrowRight') pressedKeys.add('d');

  if (key === ' ') { centerOnMe(); render(); }
});

document.addEventListener('keyup', e => {
  const key = e.key.toLowerCase();
  pressedKeys.delete(key);
  if (e.key === 'ArrowUp')    pressedKeys.delete('w');
  if (e.key === 'ArrowDown')  pressedKeys.delete('s');
  if (e.key === 'ArrowLeft')  pressedKeys.delete('a');
  if (e.key === 'ArrowRight') pressedKeys.delete('d');
});

chatInput.addEventListener('focus', () => { chatFocused = true;  pressedKeys.clear(); });
chatInput.addEventListener('blur',  () => { chatFocused = false; pressedKeys.clear(); });

// ── MOVEMENT LOOP ─────────────────────────────────────────────────────────────
setInterval(() => {
  if (chatFocused || !myId) return;
  if (pressedKeys.has('w')) socket.emit('move', 'up');
  if (pressedKeys.has('s')) socket.emit('move', 'down');
  if (pressedKeys.has('a')) socket.emit('move', 'left');
  if (pressedKeys.has('d')) socket.emit('move', 'right');
}, 90);

// ── RENDER LOOP (for AP bar animation etc.) ───────────────────────────────────
setInterval(() => {
  if (myId && mapTiles.length) render();
}, 500);
