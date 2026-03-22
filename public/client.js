// ── SOCKET ────────────────────────────────────────────────────────────────────
const socket = io();

// ── STATE ─────────────────────────────────────────────────────────────────────
let myId = null;
let players = {};   // id → { ...serverData, renderX, renderY }
let pickups = {};
let bullets = {};   // id → { x, y, dx, dy, ownerId }
let mapTiles = [];
let MAP_W = 0, MAP_H = 0;
const TILE = 24;

// Camera (pixel-space center of viewport)
let camX = 0, camY = 0;
let cellSize = 18;  // px per tile for rendering
const CELL_MIN = 6, CELL_MAX = 36;

// Client-side prediction — must match server values
const PLAYER_SPEED = 200;
const PLAYER_RADIUS = 8;
const SOLID_TILES = new Set(['#', '~', 'T', '"']);

function tileBlocked(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return true;
  return SOLID_TILES.has(mapTiles[ty]?.[tx]);
}
function circleHitsMap(px, py) {
  const r = PLAYER_RADIUS;
  const checks = [[-r,-r],[r,-r],[-r,r],[r,r],[0,-r],[0,r],[-r,0],[r,0]];
  return checks.some(([dx,dy]) => tileBlocked(Math.floor((px+dx)/TILE), Math.floor((py+dy)/TILE)));
}
function resolveMove(ox, oy, nx, ny) {
  if (!circleHitsMap(nx, ny)) return { x: nx, y: ny };
  if (!circleHitsMap(nx, oy)) return { x: nx, y: oy };
  if (!circleHitsMap(ox, ny)) return { x: ox, y: ny };
  return { x: ox, y: oy };
}

// Input
const keysDown = new Set();
let chatFocused = false;
let mouseX = 0, mouseY = 0; // screen coords

// Lobby state
let selectedSize = 'medium';

// DOM
const canvas       = document.getElementById('gameCanvas');
const ctx          = canvas.getContext('2d');
const lobby        = document.getElementById('lobby');
const gameWrap     = document.getElementById('gameWrap');
const chatLogEl    = document.getElementById('chatLog');
const chatInput    = document.getElementById('chatInput');
const coordsEl     = document.getElementById('coordsDisplay');
const zoomEl       = document.getElementById('zoomDisplay');
const leaderboardEl= document.getElementById('leaderboard');
const playerListEl = document.getElementById('playerList');
const deadOverlay  = document.getElementById('deadOverlay');
const roomCodeEl   = document.getElementById('roomCode');
const roomSizeEl   = document.getElementById('roomSize');

// ── LOBBY UI ──────────────────────────────────────────────────────────────────
function showTab(t) {
  document.getElementById('tabCreate').style.display = t==='create' ? '' : 'none';
  document.getElementById('tabJoin').style.display   = t==='join'   ? '' : 'none';
  document.querySelectorAll('.tab-btn').forEach((b,i)=>b.classList.toggle('active', (i===0&&t==='create')||(i===1&&t==='join')));
}
function selectSize(s) {
  selectedSize = s;
  document.querySelectorAll('.size-btn').forEach(b => b.classList.toggle('active', b.dataset.size===s));
}
function getLobbyData() {
  return {
    name:  document.getElementById('nameInput').value.trim() || 'Wanderer',
    char:  document.getElementById('charInput').value[0] || '@',
    color: document.getElementById('colorInput').value || '#00ff88',
  };
}
function createRoom() {
  const d = getLobbyData();
  socket.emit('createRoom', { ...d, mapSize: selectedSize });
}
function joinRoom() {
  const code = document.getElementById('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { showLobbyError('Enter a 4-letter room code'); return; }
  const d = getLobbyData();
  socket.emit('joinRoom', { ...d, code });
}
function showLobbyError(msg) {
  document.getElementById('lobbyError').textContent = msg;
}

// ── CANVAS ────────────────────────────────────────────────────────────────────
function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}
window.addEventListener('resize', () => { resizeCanvas(); });

// ── TILE RENDERING ────────────────────────────────────────────────────────────
const TILE_STYLE = {
  '.': { ch:'.', col:'#1a2a18' },
  '#': { ch:'#', col:'#3a4048' },
  '~': { ch:'~', col:'#0d3a50' },
  'T': { ch:'T', col:'#1d4a18' },
  '"': { ch:'"', col:'#244018' },
};

const PANEL_W = 168;
const CHAT_H  = 36;

function setFont(size) {
  const fs = Math.round(size / 0.58);
  ctx.font = `${fs}px 'Share Tech Mono', monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
}

// Convert world-pixel coords to screen coords
function worldToScreen(wx, wy) {
  const vpCX = PANEL_W + (canvas.width  - PANEL_W*2) / 2;
  const vpCY =           (canvas.height - CHAT_H)    / 2;
  // Scale: cellSize px per tile; world coords are in pixels (TILE=24 per tile)
  const scale = cellSize / TILE;
  return {
    sx: vpCX + (wx - camX) * scale,
    sy: vpCY + (wy - camY) * scale,
  };
}

function screenToWorld(sx, sy) {
  const vpCX = PANEL_W + (canvas.width  - PANEL_W*2) / 2;
  const vpCY =           (canvas.height - CHAT_H)    / 2;
  const scale = cellSize / TILE;
  return {
    wx: camX + (sx - vpCX) / scale,
    wy: camY + (sy - vpCY) / scale,
  };
}

// ── MAIN RENDER LOOP ──────────────────────────────────────────────────────────
let lastFrame = 0;
function gameLoop(ts) {
  requestAnimationFrame(gameLoop);
  const dt = Math.min((ts - lastFrame) / 1000, 0.05);
  lastFrame = ts;

  if (!myId || !mapTiles.length) return;

  const me = players[myId];

  // ── Client-side prediction for local player ──
  // Move renderX/renderY ourselves using same physics as server.
  // Server position (x, y) silently corrects us if we drift.
  if (me && me.alive) {
    let mx = 0, my = 0;
    if (keysDown.has('w') || keysDown.has('arrowup'))    my -= 1;
    if (keysDown.has('s') || keysDown.has('arrowdown'))  my += 1;
    if (keysDown.has('a') || keysDown.has('arrowleft'))  mx -= 1;
    if (keysDown.has('d') || keysDown.has('arrowright')) mx += 1;

    if (mx !== 0 || my !== 0) {
      const len = Math.sqrt(mx*mx + my*my);
      const spd = PLAYER_SPEED * dt;
      const nx = me.renderX + (mx/len) * spd;
      const ny = me.renderY + (my/len) * spd;
      const resolved = resolveMove(me.renderX, me.renderY, nx, ny);
      me.renderX = resolved.x;
      me.renderY = resolved.y;
    }

    // Gently reconcile with server position (fixes any drift without snapping)
    me.renderX += (me.x - me.renderX) * 0.05;
    me.renderY += (me.y - me.renderY) * 0.05;

    // Camera locks directly to predicted position — zero lag
    camX = me.renderX;
    camY = me.renderY;
  }

  // ── Interpolate other players (lerp toward server position) ──
  for (const p of Object.values(players)) {
    if (p.id === myId) continue;
    if (p.renderX === undefined) { p.renderX = p.x; p.renderY = p.y; }
    p.renderX += (p.x - p.renderX) * 0.25;
    p.renderY += (p.y - p.renderY) * 0.25;
  }

  // ── Move bullets visually ──
  const BULLET_SPEED_PX = 280;
  for (const b of Object.values(bullets)) {
    b.x += b.dx * BULLET_SPEED_PX * dt;
    b.y += b.dy * BULLET_SPEED_PX * dt;
    b.life -= dt;
  }
  for (const [id, b] of Object.entries(bullets)) {
    if (b.life <= 0) delete bullets[id];
  }

  draw();
  updateHUD();
}
requestAnimationFrame(gameLoop);

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#07090b';
  ctx.fillRect(0, 0, W, H);

  const vpLeft   = PANEL_W, vpRight = W - PANEL_W;
  const vpTop    = 0,       vpBottom = H - CHAT_H;
  const vpW = vpRight - vpLeft, vpH = vpBottom - vpTop;
  const scale = cellSize / TILE;

  // Clip to viewport
  ctx.save();
  ctx.beginPath();
  ctx.rect(vpLeft, vpTop, vpW, vpH);
  ctx.clip();

  setFont(cellSize);

  const halfCols = Math.ceil(vpW / cellSize / 2) + 2;
  const halfRows = Math.ceil(vpH / cellSize / 2) + 2;

  const camTileX = camX / TILE, camTileY = camY / TILE;
  const startTX = Math.floor(camTileX - halfCols);
  const startTY = Math.floor(camTileY - halfRows);
  const endTX   = Math.ceil(camTileX  + halfCols);
  const endTY   = Math.ceil(camTileY  + halfRows);

  const vpCX = vpLeft + vpW/2, vpCY = vpTop + vpH/2;

  // ── Tiles ──
  for (let ty = startTY; ty <= endTY; ty++) {
    for (let tx = startTX; tx <= endTX; tx++) {
      if (tx<0||tx>=MAP_W||ty<0||ty>=MAP_H) continue;
      const ch = mapTiles[ty]?.[tx] || '.';
      const ts = TILE_STYLE[ch] || TILE_STYLE['.'];
      const sx = vpCX + (tx*TILE + TILE/2 - camX) * scale;
      const sy = vpCY + (ty*TILE + TILE/2 - camY) * scale;
      ctx.fillStyle = ts.col;
      ctx.fillText(ts.ch, sx, sy);
    }
  }

  // ── Pickups ──
  for (const pk of Object.values(pickups)) {
    const sx = vpCX + (pk.x - camX) * scale;
    const sy = vpCY + (pk.y - camY) * scale;
    if (pk.type === 'hp') {
      ctx.fillStyle = '#00ff88';
      ctx.fillText('+', sx, sy);
    } else {
      ctx.fillStyle = '#ffa500';
      ctx.fillText('•', sx, sy);
    }
  }

  // ── Players ──
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const sx = vpCX + (p.renderX - camX) * scale;
    const sy = vpCY + (p.renderY - camY) * scale;

    const isMe = p.id === myId;
    ctx.shadowColor = p.color;
    ctx.shadowBlur  = isMe ? cellSize * 1.4 : cellSize * 0.8;
    ctx.fillStyle   = p.color;
    ctx.fillText(p.char, sx, sy);
    ctx.shadowBlur  = 0;

    // HP bar
    if (cellSize >= 10) {
      const bw = cellSize - 2, bh = 2;
      const bx = sx - bw/2, by = sy + cellSize*0.55;
      ctx.fillStyle = '#200a0a';
      ctx.fillRect(bx, by, bw, bh);
      ctx.fillStyle = p.hp <= 1 ? '#ff3a4a' : '#e05030';
      ctx.fillRect(bx, by, bw * (p.hp / 5), bh);
    }

    // Name tag (only when zoomed in)
    if (cellSize >= 14) {
      ctx.font = `${Math.max(8, Math.round(cellSize * 0.45))}px 'Share Tech Mono', monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = isMe ? 'rgba(57,255,138,0.6)' : 'rgba(200,220,232,0.4)';
      ctx.fillText(p.name, sx, sy - cellSize * 0.72);
      setFont(cellSize);
    }
  }

  // ── Bullets ──
  for (const b of Object.values(bullets)) {
    const sx = vpCX + (b.x - camX) * scale;
    const sy = vpCY + (b.y - camY) * scale;
    const owner = players[b.ownerId];
    const col = owner?.color || '#ffffff';
    ctx.shadowColor = col;
    ctx.shadowBlur  = 6;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(2, cellSize * 0.14), 0, Math.PI*2);
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  // ── Aim line (from me to mouse) ──
  const me = players[myId];
  if (me && me.alive) {
    const msx = vpCX + (me.renderX - camX) * scale;
    const msy = vpCY + (me.renderY - camY) * scale;
    const dx = mouseX - msx, dy = mouseY - msy;
    const len = Math.sqrt(dx*dx+dy*dy) || 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.moveTo(msx, msy);
    ctx.lineTo(msx + dx/len*60, msy + dy/len*60);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // ── Map border ──
  const bsx = vpCX + (0 - camX) * scale;
  const bsy = vpCY + (0 - camY) * scale;
  ctx.strokeStyle = 'rgba(100,140,180,0.12)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bsx, bsy, MAP_W*TILE*scale, MAP_H*TILE*scale);

  ctx.restore();
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHUD() {
  const me = players[myId];
  if (!me) return;

  const tx = Math.floor((me.renderX ?? me.x) / TILE), ty = Math.floor((me.renderY ?? me.y) / TILE);
  coordsEl.textContent = `${tx}, ${ty}`;
  zoomEl.textContent   = `ZOOM ${(cellSize/16).toFixed(2)}×`;

  document.getElementById('myChar').textContent = me.char;
  document.getElementById('myChar').style.color = me.color;
  document.getElementById('myName').textContent = me.name;
  document.getElementById('hpNum').textContent  = me.hp;
  document.getElementById('ammoNum').textContent= me.bullets;
  document.getElementById('hpFill').style.width   = `${(me.hp/5)*100}%`;
  document.getElementById('ammoFill').style.width = `${Math.min(100,(me.bullets/10)*100)}%`;
  document.getElementById('myKills').textContent  = me.kills;

  // Leaderboard
  const sorted = Object.values(players).sort((a,b)=>b.kills-a.kills).slice(0,8);
  leaderboardEl.innerHTML = sorted.map(p=>`
    <div class="lb-row ${p.id===myId?'lb-me':''}">
      <span class="lb-char" style="color:${p.color}">${escHtml(p.char)}</span>
      <span class="lb-name">${escHtml(p.name)}</span>
      <span class="lb-kills">${p.kills}</span>
    </div>`).join('');

  // Player list
  playerListEl.innerHTML = Object.values(players).map(p=>`
    <div class="pl-row">
      <span class="pl-char" style="color:${p.color}">${escHtml(p.char)}</span>
      <span class="pl-name">${escHtml(p.name)}</span>
      <span class="pl-hp">${p.alive ? p.hp+'♥' : '☠'}</span>
    </div>`).join('');
}

// ── INPUT ─────────────────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (lobby.style.display !== 'none') return;

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
  if (e.key === ' ') { e.preventDefault(); }
  keysDown.add(e.key.toLowerCase());
  sendInput();
});

document.addEventListener('keyup', e => {
  keysDown.delete(e.key.toLowerCase());
  sendInput();
});

chatInput.addEventListener('focus', () => { chatFocused = true;  keysDown.clear(); sendInput(); });
chatInput.addEventListener('blur',  () => { chatFocused = false; keysDown.clear(); sendInput(); });

function sendInput() {
  if (!myId) return;
  let mx = 0, my = 0;
  if (keysDown.has('w') || keysDown.has('arrowup'))    my -= 1;
  if (keysDown.has('s') || keysDown.has('arrowdown'))  my += 1;
  if (keysDown.has('a') || keysDown.has('arrowleft'))  mx -= 1;
  if (keysDown.has('d') || keysDown.has('arrowright')) mx += 1;
  socket.emit('input', { moveX: mx, moveY: my });
}

// Mouse track
canvas.addEventListener('mousemove', e => {
  mouseX = e.clientX; mouseY = e.clientY;
});

// Shoot on click
canvas.addEventListener('click', e => {
  if (!myId || chatFocused) return;
  const me = players[myId];
  if (!me || !me.alive) return;

  const scale = cellSize / TILE;
  const vpLeft = PANEL_W;
  const vpCX = vpLeft + (canvas.width - PANEL_W*2) / 2;
  const vpCY = (canvas.height - CHAT_H) / 2;

  const msx = vpCX + (me.renderX - camX) * scale;
  const msy = vpCY + (me.renderY - camY) * scale;
  const dx = e.clientX - msx;
  const dy = e.clientY - msy;
  const len = Math.sqrt(dx*dx+dy*dy);
  if (len < 2) return;
  socket.emit('shoot', { dx: dx/len, dy: dy/len });
});

// Scroll to zoom
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  cellSize = Math.max(CELL_MIN, Math.min(CELL_MAX, cellSize - Math.sign(e.deltaY) * 2));
}, { passive: false });

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
socket.on('roomError', msg => showLobbyError(msg));

socket.on('roomJoined', data => {
  myId = data.players[socket.id] ? socket.id : Object.keys(data.players)[0];
  // Actually server sets socket.id as key
  myId = socket.id;

  // Init players with renderX/renderY
  players = {};
  for (const [id, p] of Object.entries(data.players)) {
    players[id] = { ...p, renderX: p.x, renderY: p.y };
  }
  pickups  = data.pickups || {};
  mapTiles = data.map;
  MAP_W    = data.cols;
  MAP_H    = data.rows;

  // Center camera on map center initially
  camX = (MAP_W * TILE) / 2;
  camY = (MAP_H * TILE) / 2;

  roomCodeEl.textContent = data.code;
  roomSizeEl.textContent = data.mapSize.toUpperCase() + ` · ${data.cols}×${data.rows}`;

  lobby.style.display    = 'none';
  gameWrap.style.display = 'block';
  resizeCanvas();
  addChat(null, `— Entered room ${data.code}. SPACE to find yourself. —`, null, 'sys');
});

socket.on('newPlayer', p => {
  players[p.id] = { ...p, renderX: p.x, renderY: p.y };
  addChat(null, `${p.char} ${p.name} joined.`, null, 'sys');
});

socket.on('playerLeft', id => {
  const p = players[id];
  if (p) addChat(null, `${p.char} ${p.name} left.`, null, 'sys');
  delete players[id];
});

socket.on('positions', data => {
  for (const [id, pos] of Object.entries(data)) {
    if (players[id]) { players[id].x = pos.x; players[id].y = pos.y; }
  }
});

socket.on('ammoUpdate', ({ bullets: b }) => {
  if (players[myId]) players[myId].bullets = b;
});

socket.on('noAmmo', () => {
  addChat(null, '— Out of ammo! Find a pickup. —', null, 'sys');
});

socket.on('bulletSpawned', b => {
  bullets[b.id] = { ...b, life: 3 };
});

socket.on('bulletDead', data => {
  delete bullets[data.id];
});

socket.on('playerHit', data => {
  if (players[data.id]) players[data.id].hp = data.hp;
  if (data.id === myId) {
    // Flash
    canvas.style.boxShadow = 'inset 0 0 40px rgba(255,58,74,0.5)';
    setTimeout(() => canvas.style.boxShadow = '', 200);
  }
});

socket.on('playerDied', data => {
  if (players[data.id]) { players[data.id].alive = false; players[data.id].hp = 0; }
  // Add dropped pickups
  if (data.drops) for (const pk of data.drops) pickups[pk.id] = pk;
  const victim = players[data.id];
  addChat(null, `☠ ${data.killerChar}${data.killerName} killed ${victim?.char||''}${victim?.name||'?'}`, null, 'kill');
  if (data.id === myId) {
    deadOverlay.style.display = 'flex';
  }
});

socket.on('playerRespawned', p => {
  players[p.id] = { ...p, renderX: p.x, renderY: p.y };
  if (p.id === myId) {
    deadOverlay.style.display = 'none';
    camX = p.x; camY = p.y;
  }
});

socket.on('killUpdate', data => {
  if (players[data.id]) players[data.id].kills = data.kills;
});

socket.on('pickupsUpdate', data => {
  pickups = data;
});

socket.on('pickupCollected', data => {
  delete pickups[data.pickupId];
  if (data.playerId === myId) {
    if (players[myId]) {
      players[myId].hp = data.hp;
      players[myId].bullets = data.bullets;
    }
  }
});

socket.on('chatMessage', data => {
  addChat(`${data.char} ${data.name}`, data.message, data.color);
});

socket.on('roomClosed', () => {
  document.getElementById('roomClosedOverlay').style.display = 'flex';
});

// Space = snap camera to self (camera already follows, this is instant re-center)
document.addEventListener('keydown', e => {
  if (e.key === ' ' && !chatFocused && myId && players[myId]) {
    const me = players[myId];
    camX = me.renderX ?? me.x;
    camY = me.renderY ?? me.y;
  }
});

// ── CHAT HELPER ───────────────────────────────────────────────────────────────
function addChat(name, msg, color, type) {
  const el = document.createElement('div');
  el.className = `chat-msg${type?' '+type:''}`;
  if (name) el.innerHTML = `<span class="chat-name" style="color:${color||'var(--text-hi)'}">${escHtml(name)}:</span>${escHtml(msg)}`;
  else el.textContent = msg;
  chatLogEl.appendChild(el);
  setTimeout(() => el.classList.add('fading'), 7000);
  setTimeout(() => el.remove(), 8000);
  while (chatLogEl.children.length > 10) chatLogEl.firstChild.remove();
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
