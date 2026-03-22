// ── SOCKET ────────────────────────────────────────────────────────────────────
const socket = io();

// ── STATE ─────────────────────────────────────────────────────────────────────
let myId     = null;
let players  = {};   // id → { tx, ty, renderX, renderY, ... }
let pickups  = {};   // id → { tx, ty, type }
let bullets  = {};   // id → { tx, ty, dx, dy, renderX, renderY }
let mapTiles = [];
let MAP_W = 0, MAP_H = 0;
let TILE = 24;
let CFG  = {};

// Camera in pixel space (center of viewport)
let camX = 0, camY = 0;
let cellSize = 24; // px per tile
const CELL_MIN = 10, CELL_MAX = 48;

// Input
let chatFocused = false;
let mouseX = 0, mouseY = 0;
let selectedSize = 'medium';

// DOM
const canvas        = document.getElementById('gameCanvas');
const ctx           = canvas.getContext('2d');
const lobby         = document.getElementById('lobby');
const gameWrap      = document.getElementById('gameWrap');
const chatLogEl     = document.getElementById('chatLog');
const chatInput     = document.getElementById('chatInput');
const coordsEl      = document.getElementById('coordsDisplay');
const zoomEl        = document.getElementById('zoomDisplay');
const leaderboardEl = document.getElementById('leaderboard');
const playerListEl  = document.getElementById('playerList');
const deadOverlay   = document.getElementById('deadOverlay');
const roomCodeEl    = document.getElementById('roomCode');
const roomSizeEl    = document.getElementById('roomSize');

// ── LOBBY ─────────────────────────────────────────────────────────────────────
function showTab(t) {
  document.getElementById('tabCreate').style.display = t==='create'?'':'none';
  document.getElementById('tabJoin').style.display   = t==='join'  ?'':'none';
  document.querySelectorAll('.tab-btn').forEach((b,i)=>
    b.classList.toggle('active',(i===0&&t==='create')||(i===1&&t==='join')));
}
function selectSize(s) {
  selectedSize=s;
  document.querySelectorAll('.size-btn').forEach(b=>b.classList.toggle('active',b.dataset.size===s));
}
function getLobby() {
  return {
    name:  document.getElementById('nameInput').value.trim()||'Wanderer',
    char:  document.getElementById('charInput').value[0]||'@',
    color: document.getElementById('colorInput').value||'#00ff88',
  };
}
function createRoom() { socket.emit('createRoom',{...getLobby(),mapSize:selectedSize}); }
function joinRoom() {
  const code=document.getElementById('codeInput').value.trim().toUpperCase();
  if (code.length!==4){showErr('Enter a 4-letter code');return;}
  socket.emit('joinRoom',{...getLobby(),code});
}
function showErr(m){ document.getElementById('lobbyError').textContent=m; }

// ── CANVAS ────────────────────────────────────────────────────────────────────
function resizeCanvas(){ canvas.width=window.innerWidth; canvas.height=window.innerHeight; }
window.addEventListener('resize', resizeCanvas);

// ── TILE STYLES ───────────────────────────────────────────────────────────────
// Walls are bright, water is blue, decor is subtle ground cover
const TILE_STYLE = {
  '.': { ch:'·', col:'#1a2218' },
  '#': { ch:'#', col:'#4a5258' },
  '~': { ch:'~', col:'#0d3a50' },
  '"': { ch:'"', col:'#1c3018' },
  ',': { ch:',', col:'#182818' },
  '`': { ch:'`', col:'#1a2a16' },
  "'": { ch:"'", col:'#182218' },
  ';': { ch:';', col:'#1e2e1a' },
};

const PANEL_W = 168;
const CHAT_H  = 36;

function setFont(size) {
  const fs = Math.round(size / 0.58);
  ctx.font = `${fs}px 'Share Tech Mono', monospace`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
}

// World tile → screen pixel (center of tile)
function tileToScreen(tx, ty) {
  const vpW = canvas.width - PANEL_W*2;
  const vpH = canvas.height - CHAT_H;
  const vpCX = PANEL_W + vpW/2;
  const vpCY = vpH/2;
  const scale = cellSize / TILE;
  return {
    sx: vpCX + (tx*TILE + TILE/2 - camX) * scale,
    sy: vpCY + (ty*TILE + TILE/2 - camY) * scale,
  };
}

function screenToTile(sx, sy) {
  const vpW = canvas.width - PANEL_W*2;
  const vpH = canvas.height - CHAT_H;
  const vpCX = PANEL_W + vpW/2;
  const vpCY = vpH/2;
  const scale = cellSize / TILE;
  const wx = camX + (sx - vpCX) / scale;
  const wy = camY + (sy - vpCY) / scale;
  return { tx: Math.floor(wx/TILE), ty: Math.floor(wy/TILE) };
}

// ── RENDER LOOP ───────────────────────────────────────────────────────────────
let lastFrame = 0;
let lastHudUpdate = 0;

function gameLoop(ts) {
  requestAnimationFrame(gameLoop);
  const dt = Math.min((ts-lastFrame)/1000, 0.05);
  lastFrame = ts;

  if (!myId || !mapTiles.length) return;

  const me = players[myId];

  // Camera follows my tile position (grid-snapped, instant)
  if (me) {
    const target = tileCenter(me.tx, me.ty);
    // Smooth camera pan only — no player position lerp needed for self
    camX += (target.x - camX) * 0.18;
    camY += (target.y - camY) * 0.18;
    // Snap when close
    if (Math.abs(target.x-camX)<0.5) camX=target.x;
    if (Math.abs(target.y-camY)<0.5) camY=target.y;
  }

  // Smooth render positions for other players (lerp between grid tiles)
  for (const p of Object.values(players)) {
    const target = tileCenter(p.tx, p.ty);
    if (p.renderX===undefined) { p.renderX=target.x; p.renderY=target.y; }
    p.renderX += (target.x - p.renderX) * 0.3;
    p.renderY += (target.y - p.renderY) * 0.3;
    if (Math.abs(target.x-p.renderX)<0.3) p.renderX=target.x;
    if (Math.abs(target.y-p.renderY)<0.3) p.renderY=target.y;
  }

  // Smooth bullet positions (interpolate between tiles based on progress)
  for (const [id, b] of Object.entries(bullets)) {
    const BSPEED = (CFG.BULLET_SPEED_TPS||10) * TILE;
    const tx = b.tx * TILE + TILE/2 + b.dx * b.progress * TILE;
    const ty = b.ty * TILE + TILE/2 + b.dy * b.progress * TILE;
    if (b.renderX===undefined) { b.renderX=tx; b.renderY=ty; }
    // Bullets: snap render directly (they move fast enough)
    b.renderX = tx;
    b.renderY = ty;
    b.progress += (CFG.BULLET_SPEED_TPS||10) * dt;
  }

  draw();
  if (ts-lastHudUpdate>100) { updateHUD(); lastHudUpdate=ts; }
}
requestAnimationFrame(gameLoop);

function tileCenter(tx, ty) {
  return { x: tx*TILE + TILE/2, y: ty*TILE + TILE/2 };
}

// ── DRAW ─────────────────────────────────────────────────────────────────────
function draw() {
  const W=canvas.width, H=canvas.height;
  ctx.clearRect(0,0,W,H);
  ctx.fillStyle='#07090b';
  ctx.fillRect(0,0,W,H);

  const vpLeft=PANEL_W, vpRight=W-PANEL_W;
  const vpTop=0, vpBottom=H-CHAT_H;
  const vpW=vpRight-vpLeft, vpH=vpBottom-vpTop;
  const vpCX=vpLeft+vpW/2, vpCY=vpTop+vpH/2;
  const scale=cellSize/TILE;

  ctx.save();
  ctx.beginPath(); ctx.rect(vpLeft,vpTop,vpW,vpH); ctx.clip();

  setFont(cellSize);

  // Visible tile range
  const halfC=Math.ceil(vpW/cellSize/2)+2;
  const halfR=Math.ceil(vpH/cellSize/2)+2;
  const camTX=camX/TILE, camTY=camY/TILE;
  const startTX=Math.floor(camTX-halfC), endTX=Math.ceil(camTX+halfC);
  const startTY=Math.floor(camTY-halfR), endTY=Math.ceil(camTY+halfR);

  // ── TILES ──
  for (let ty=startTY; ty<=endTY; ty++) {
    for (let tx=startTX; tx<=endTX; tx++) {
      if (tx<0||tx>=MAP_W||ty<0||ty>=MAP_H) continue;
      const ch=mapTiles[ty]?.[tx]||'.';
      const ts=TILE_STYLE[ch]||TILE_STYLE['.'];
      const sx=vpCX+(tx*TILE+TILE/2-camX)*scale;
      const sy=vpCY+(ty*TILE+TILE/2-camY)*scale;
      ctx.fillStyle=ts.col;
      ctx.fillText(ts.ch,sx,sy);
    }
  }

  // ── PICKUPS ──
  for (const pk of Object.values(pickups)) {
    const sx=vpCX+(pk.tx*TILE+TILE/2-camX)*scale;
    const sy=vpCY+(pk.ty*TILE+TILE/2-camY)*scale;
    const pulse = 0.7 + 0.3*Math.sin(Date.now()*0.004);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = pk.type==='hp' ? '#00ff88' : '#ffa500';
    ctx.fillText(pk.type==='hp'?'+':'•', sx, sy);
    ctx.globalAlpha = 1;
  }

  // ── PLAYERS ──
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const sx=vpCX+(p.renderX-camX)*scale;
    const sy=vpCY+(p.renderY-camY)*scale;
    const isMe=p.id===myId;
    ctx.shadowColor=p.color;
    ctx.shadowBlur=isMe?cellSize*1.2:cellSize*0.6;
    ctx.fillStyle=p.color;
    ctx.fillText(p.char,sx,sy);
    ctx.shadowBlur=0;

    // HP pips under player
    if (cellSize>=12) {
      const pipW=(cellSize-4)/5;
      const bx=sx-(cellSize-4)/2, by=sy+cellSize*0.58;
      for (let i=0;i<5;i++) {
        ctx.fillStyle=i<p.hp?'#e03030':'#1a0808';
        ctx.fillRect(bx+i*(pipW+1),by,pipW,2);
      }
    }

    // Name tag
    if (cellSize>=16) {
      const origFont=ctx.font;
      ctx.font=`${Math.max(7,Math.round(cellSize*0.38))}px 'Share Tech Mono',monospace`;
      ctx.textAlign='center';
      ctx.fillStyle=isMe?'rgba(57,255,138,0.55)':'rgba(200,220,232,0.35)';
      ctx.fillText(p.name,sx,sy-cellSize*0.7);
      ctx.font=origFont;
      ctx.textAlign='center';
    }
  }

  // ── BULLETS ──
  for (const b of Object.values(bullets)) {
    const sx=vpCX+(b.renderX-camX)*scale;
    const sy=vpCY+(b.renderY-camY)*scale;
    const owner=players[b.ownerId];
    const col=owner?.color||'#ffffff';
    ctx.shadowColor=col; ctx.shadowBlur=8;
    ctx.fillStyle=col;
    // Draw as a directional dash
    ctx.save();
    ctx.translate(sx,sy);
    ctx.rotate(Math.atan2(b.dy,b.dx));
    ctx.fillRect(-Math.max(3,cellSize*0.3),-1,Math.max(6,cellSize*0.6),2);
    ctx.restore();
    ctx.shadowBlur=0;
  }

  // ── SHOOT DIRECTION INDICATOR (arrow from me toward mouse) ──
  const me=players[myId];
  if (me&&me.alive) {
    const msx=vpCX+(me.renderX-camX)*scale;
    const msy=vpCY+(me.renderY-camY)*scale;
    // Show cardinal arrow based on which arrow key was last pressed
    if (lastArrow) {
      const adx=lastArrow.dx, ady=lastArrow.dy;
      const len=cellSize*1.4;
      ctx.strokeStyle='rgba(255,255,255,0.18)';
      ctx.lineWidth=1.5;
      ctx.setLineDash([3,5]);
      ctx.beginPath();
      ctx.moveTo(msx,msy);
      ctx.lineTo(msx+adx*len, msy+ady*len);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── MAP BORDER ──
  const bsx=vpCX+(0-camX)*scale, bsy=vpCY+(0-camY)*scale;
  ctx.strokeStyle='rgba(100,140,180,0.1)';
  ctx.lineWidth=1;
  ctx.strokeRect(bsx,bsy,MAP_W*TILE*scale,MAP_H*TILE*scale);

  ctx.restore();
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function updateHUD() {
  const me=players[myId]; if (!me) return;
  coordsEl.textContent=`${me.tx}, ${me.ty}`;
  zoomEl.textContent=`ZOOM ${(cellSize/24).toFixed(2)}×`;
  document.getElementById('myChar').textContent=me.char;
  document.getElementById('myChar').style.color=me.color;
  document.getElementById('myName').textContent=me.name;
  document.getElementById('hpNum').textContent=me.hp;
  document.getElementById('ammoNum').textContent=me.bullets;
  document.getElementById('hpFill').style.width=`${(me.hp/5)*100}%`;
  document.getElementById('ammoFill').style.width=`${Math.min(100,(me.bullets/10)*100)}%`;
  document.getElementById('myKills').textContent=me.kills;
  leaderboardEl.innerHTML=Object.values(players)
    .sort((a,b)=>b.kills-a.kills).slice(0,8)
    .map(p=>`<div class="lb-row ${p.id===myId?'lb-me':''}">
      <span class="lb-char" style="color:${p.color}">${escHtml(p.char)}</span>
      <span class="lb-name">${escHtml(p.name)}</span>
      <span class="lb-kills">${p.kills}</span>
    </div>`).join('');
  playerListEl.innerHTML=Object.values(players)
    .map(p=>`<div class="pl-row">
      <span class="pl-char" style="color:${p.color}">${escHtml(p.char)}</span>
      <span class="pl-name">${escHtml(p.name)}</span>
      <span class="pl-hp">${p.alive?'♥'.repeat(p.hp):'☠'}</span>
    </div>`).join('');
}

// ── INPUT ─────────────────────────────────────────────────────────────────────
let lastArrow = null;

document.addEventListener('keydown', e => {
  if (lobby.style.display!=='none') return;

  if (e.key==='Enter') {
    if (chatFocused) {
      const msg=chatInput.value.trim();
      if (msg){socket.emit('chat',msg);chatInput.value='';}
      chatInput.blur(); chatFocused=false;
    } else { chatInput.focus(); chatFocused=true; }
    return;
  }
  if (chatFocused) return;
  e.preventDefault();

  const me=players[myId];

  // WASD → move one tile
  const MOVE_MAP = { w:{dx:0,dy:-1}, a:{dx:-1,dy:0}, s:{dx:0,dy:1}, d:{dx:1,dy:0} };
  const mv=MOVE_MAP[e.key.toLowerCase()];
  if (mv&&me?.alive) { socket.emit('move',mv); return; }

  // Arrow keys → shoot
  const SHOOT_MAP = {
    ArrowUp:   {dx:0,dy:-1}, ArrowDown: {dx:0,dy:1},
    ArrowLeft: {dx:-1,dy:0}, ArrowRight:{dx:1,dy:0},
  };
  const sh=SHOOT_MAP[e.key];
  if (sh&&me?.alive) {
    lastArrow=sh;
    socket.emit('shoot',sh);
    return;
  }

  // Space → center camera on self
  if (e.key===' '&&me) {
    const t=tileCenter(me.tx,me.ty);
    camX=t.x; camY=t.y;
  }
});

chatInput.addEventListener('focus',()=>{chatFocused=true;});
chatInput.addEventListener('blur', ()=>{chatFocused=false;});

// Scroll zoom
canvas.addEventListener('wheel',e=>{
  e.preventDefault();
  cellSize=Math.max(CELL_MIN,Math.min(CELL_MAX,cellSize-Math.sign(e.deltaY)*3));
},{passive:false});

// ── SOCKET EVENTS ─────────────────────────────────────────────────────────────
socket.on('roomError', msg=>showErr(msg));

socket.on('roomJoined', data=>{
  myId=socket.id;
  players={};
  for (const [id,p] of Object.entries(data.players)) {
    const tc=tileCenter(p.tx,p.ty);
    players[id]={...p, renderX:tc.x, renderY:tc.y};
  }
  pickups=data.pickups||{};
  mapTiles=data.map;
  MAP_W=data.cols; MAP_H=data.rows;
  TILE=data.config?.TILE||24;
  CFG=data.config||{};

  // Start camera at map center
  camX=(MAP_W*TILE)/2; camY=(MAP_H*TILE)/2;

  roomCodeEl.textContent=data.code;
  roomSizeEl.textContent=data.mapSize.toUpperCase()+` · ${data.cols}×${data.rows}`;
  lobby.style.display='none';
  gameWrap.style.display='block';
  resizeCanvas();
  addChat(null,`— Entered room ${data.code}. SPACE centers on you. —`,null,'sys');
});

socket.on('newPlayer', p=>{
  const tc=tileCenter(p.tx,p.ty);
  players[p.id]={...p,renderX:tc.x,renderY:tc.y};
  addChat(null,`${p.char} ${p.name} joined.`,null,'sys');
});

socket.on('playerLeft',id=>{
  const p=players[id];
  if (p) addChat(null,`${p.char} ${p.name} left.`,null,'sys');
  delete players[id];
});

socket.on('playerMoved',({id,tx,ty})=>{
  if (players[id]){players[id].tx=tx;players[id].ty=ty;}
});

// Server confirmed our move — snap ourselves if somehow off
socket.on('moveDenied',({tx,ty})=>{
  if (players[myId]){players[myId].tx=tx;players[myId].ty=ty;}
});

socket.on('bulletSpawned',b=>{
  bullets[b.id]={...b, progress:0, renderX:b.tx*TILE+TILE/2, renderY:b.ty*TILE+TILE/2};
});

socket.on('bulletPos',({id,tx,ty,progress})=>{
  if (bullets[id]){bullets[id].tx=tx;bullets[id].ty=ty;bullets[id].progress=progress;}
});

socket.on('bulletDead',({id})=>{ delete bullets[id]; });

socket.on('playerHit',({id,hp})=>{
  if (players[id]) players[id].hp=hp;
  if (id===myId){
    canvas.style.boxShadow='inset 0 0 50px rgba(255,58,74,0.6)';
    setTimeout(()=>canvas.style.boxShadow='',250);
  }
});

socket.on('playerDied',data=>{
  if (players[data.id]){players[data.id].alive=false;players[data.id].hp=0;}
  if (data.drops) for (const pk of data.drops) pickups[pk.id]=pk;
  const v=players[data.id];
  addChat(null,`☠ ${data.killerChar}${data.killerName} killed ${v?.char||''}${v?.name||'?'}`,null,'kill');
  if (data.id===myId) deadOverlay.style.display='flex';
});

socket.on('playerRespawned',p=>{
  const tc=tileCenter(p.tx,p.ty);
  players[p.id]={...p,renderX:tc.x,renderY:tc.y};
  if (p.id===myId){
    deadOverlay.style.display='none';
    camX=tc.x; camY=tc.y;
  }
});

socket.on('killUpdate',({id,kills})=>{ if (players[id]) players[id].kills=kills; });

socket.on('ammoUpdate',({bullets:b})=>{ if (players[myId]) players[myId].bullets=b; });
socket.on('noAmmo',()=>addChat(null,'— Out of ammo! —',null,'sys'));

socket.on('pickupsUpdate',data=>{ pickups=data; });

socket.on('pickupCollected',({pickupId,playerId,hp,bullets:b})=>{
  delete pickups[pickupId];
  if (playerId===myId&&players[myId]){players[myId].hp=hp;players[myId].bullets=b;}
});

socket.on('chatMessage',data=>{
  addChat(`${data.char} ${data.name}`,data.message,data.color);
});

socket.on('roomClosed',()=>{
  document.getElementById('roomClosedOverlay').style.display='flex';
});

// ── CHAT ──────────────────────────────────────────────────────────────────────
function addChat(name,msg,color,type){
  const el=document.createElement('div');
  el.className=`chat-msg${type?' '+type:''}`;
  if (name) el.innerHTML=`<span class="chat-name" style="color:${color||'var(--text-hi)'}">${escHtml(name)}:</span>${escHtml(msg)}`;
  else el.textContent=msg;
  chatLogEl.appendChild(el);
  setTimeout(()=>el.classList.add('fading'),7000);
  setTimeout(()=>el.remove(),8000);
  while (chatLogEl.children.length>10) chatLogEl.firstChild.remove();
}

function escHtml(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
