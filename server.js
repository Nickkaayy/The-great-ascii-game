const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

// ── WORLD CONFIG ──────────────────────────────────────────────────────────────
const MAP_W = 300;
const MAP_H = 150;
const AP_MAX = 10;
const AP_REGEN_MS = 20000;
const HP_MAX = 5;
const ATTACK_RANGE_DEFAULT = 2;
const ATTACK_AP_BASE = 2;
const MOVE_AP = 1;
const DONATE_AP_PER = 1;
const KILL_AP_REWARD = 3;
const RANGE_EXT_AP = 1;

// ── MAP GENERATION ────────────────────────────────────────────────────────────
const SESSION_SEED = Math.floor(Math.random() * 1e9);

function makeRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s ^= s >>> 16;
    return (s >>> 0) / 0xffffffff;
  };
}

function generateMap() {
  const rand = makeRand(SESSION_SEED);
  const tiles = Array.from({ length: MAP_H }, () => Array(MAP_W).fill('.'));

  // Hard border
  for (let y = 0; y < MAP_H; y++) { tiles[y][0] = '#'; tiles[y][MAP_W-1] = '#'; }
  for (let x = 0; x < MAP_W; x++) { tiles[0][x] = '#'; tiles[MAP_H-1][x] = '#'; }

  // Lakes
  for (let l = 0; l < 22; l++) {
    const cx = Math.floor(rand() * (MAP_W - 30)) + 15;
    const cy = Math.floor(rand() * (MAP_H - 20)) + 10;
    const rx = Math.floor(rand() * 8) + 3;
    const ry = Math.floor(rand() * 5) + 2;
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        if ((dx*dx)/(rx*rx) + (dy*dy)/(ry*ry) <= 1) {
          const tx = cx+dx, ty = cy+dy;
          if (tx>0 && tx<MAP_W-1 && ty>0 && ty<MAP_H-1) tiles[ty][tx] = '~';
        }
      }
    }
  }

  // Rock walls
  for (let w = 0; w < 80; w++) {
    const x = Math.floor(rand() * (MAP_W-20)) + 5;
    const y = Math.floor(rand() * (MAP_H-10)) + 5;
    const len = Math.floor(rand() * 8) + 2;
    const horiz = rand() > 0.5;
    for (let i = 0; i < len; i++) {
      const tx = horiz ? x+i : x, ty = horiz ? y : y+i;
      if (tx>0 && tx<MAP_W-1 && ty>0 && ty<MAP_H-1 && tiles[ty][tx] !== '~')
        tiles[ty][tx] = '#';
    }
  }

  // Trees
  for (let t = 0; t < 500; t++) {
    const x = Math.floor(rand()*(MAP_W-2))+1, y = Math.floor(rand()*(MAP_H-2))+1;
    if (tiles[y][x] === '.') tiles[y][x] = 'T';
  }

  // Bushes
  for (let b = 0; b < 400; b++) {
    const x = Math.floor(rand()*(MAP_W-2))+1, y = Math.floor(rand()*(MAP_H-2))+1;
    if (tiles[y][x] === '.') tiles[y][x] = '"';
  }

  return tiles;
}

const MAP_TILES = generateMap();

// ── HELPERS ───────────────────────────────────────────────────────────────────
function chebyshev(ax, ay, bx, by) { return Math.max(Math.abs(ax-bx), Math.abs(ay-by)); }

function randomSpawn() {
  const edge = Math.floor(Math.random()*4);
  let x, y;
  if (edge===0) { x=Math.floor(Math.random()*(MAP_W-4))+2; y=2; }
  else if (edge===1) { x=Math.floor(Math.random()*(MAP_W-4))+2; y=MAP_H-3; }
  else if (edge===2) { x=2; y=Math.floor(Math.random()*(MAP_H-4))+2; }
  else { x=MAP_W-3; y=Math.floor(Math.random()*(MAP_H-4))+2; }
  return { x, y };
}

function pub(p) {
  return { id:p.id, name:p.name, char:p.char, color:p.color,
           x:p.x, y:p.y, hp:p.hp, ap:p.ap, alive:p.alive, kills:p.kills };
}

function allPub() {
  return Object.fromEntries(Object.entries(players).map(([id,p])=>[id,pub(p)]));
}

// ── PLAYERS ───────────────────────────────────────────────────────────────────
const players = {};
let gameOver = false;

function checkWin() {
  if (gameOver) return;
  const alive = Object.values(players).filter(p=>p.alive);
  if (alive.length === 1 && Object.keys(players).length > 1) {
    gameOver = true;
    const w = alive[0];
    io.emit('gameOver', { winnerId:w.id, winnerName:w.name, winnerChar:w.char, winnerColor:w.color, kills:w.kills });
    setTimeout(resetGame, 12000);
  }
}

function resetGame() {
  gameOver = false;
  for (const id in players) {
    const sp = randomSpawn();
    Object.assign(players[id], { x:sp.x, y:sp.y, hp:HP_MAX, ap:3, alive:true, kills:0 });
  }
  io.emit('gameReset', { players: allPub() });
}

// ── AP REGEN ──────────────────────────────────────────────────────────────────
setInterval(() => {
  for (const id in players) {
    const p = players[id];
    if (p.alive && p.ap < AP_MAX) {
      p.ap = Math.min(AP_MAX, p.ap+1);
      const sock = io.sockets.sockets.get(id);
      if (sock) sock.emit('apUpdate', { ap: p.ap });
    }
  }
}, AP_REGEN_MS);

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const sp = randomSpawn();
  players[socket.id] = {
    id: socket.id, name:'Wanderer', char:'@', color:'#00ff88',
    x:sp.x, y:sp.y, hp:HP_MAX, ap:3, alive:true, kills:0
  };

  socket.emit('joined', {
    id: socket.id,
    mapTiles: MAP_TILES,
    mapW: MAP_W, mapH: MAP_H,
    players: allPub(),
    config: { AP_MAX, HP_MAX, ATTACK_RANGE_DEFAULT, MOVE_AP, ATTACK_AP_BASE,
              DONATE_AP_PER, KILL_AP_REWARD, RANGE_EXT_AP }
  });

  socket.broadcast.emit('newPlayer', pub(players[socket.id]));

  socket.on('setInfo', (data) => {
    const p = players[socket.id]; if (!p) return;
    if (data.name?.trim()) p.name = data.name.trim().slice(0,15);
    if (data.char) p.char = String(data.char)[0];
    if (data.color) p.color = data.color;
    io.emit('playerUpdate', pub(p));
  });

  socket.on('move', (dir) => {
    const p = players[socket.id]; if (!p||!p.alive) return;
    if (p.ap < MOVE_AP) { socket.emit('err','Not enough AP (need 1)'); return; }
    let nx=p.x, ny=p.y;
    if (dir==='up') ny--; else if (dir==='down') ny++;
    else if (dir==='left') nx--; else if (dir==='right') nx++;
    nx = Math.max(1,Math.min(MAP_W-2,nx));
    ny = Math.max(1,Math.min(MAP_H-2,ny));
    const tile = MAP_TILES[ny][nx];
    if (tile==='#'||tile==='~') { socket.emit('err','Blocked'); return; }
    if (Object.values(players).some(o=>o.id!==socket.id&&o.alive&&o.x===nx&&o.y===ny))
      { socket.emit('err','Tile occupied'); return; }
    p.ap -= MOVE_AP; p.x=nx; p.y=ny;
    socket.emit('apUpdate',{ap:p.ap});
    io.emit('playerMoved',{id:socket.id,x:p.x,y:p.y});
  });

  socket.on('attack', ({ targetId, extraRange=0 }) => {
    const p = players[socket.id], t = players[targetId];
    if (!p||!p.alive||!t||!t.alive||p.id===t.id) return;
    const range = ATTACK_RANGE_DEFAULT + extraRange;
    const apCost = ATTACK_AP_BASE + extraRange * RANGE_EXT_AP;
    if (p.ap < apCost) { socket.emit('err',`Need ${apCost} AP`); return; }
    if (chebyshev(p.x,p.y,t.x,t.y) > range) { socket.emit('err','Out of range'); return; }
    p.ap -= apCost; t.hp -= 1;
    socket.emit('apUpdate',{ap:p.ap});
    io.emit('attacked',{ attackerId:socket.id, targetId, targetHp:t.hp, ax:p.x,ay:p.y,tx:t.x,ty:t.y });
    if (t.hp <= 0) {
      t.alive=false; t.hp=0; p.kills++;
      p.ap=Math.min(AP_MAX,p.ap+KILL_AP_REWARD);
      socket.emit('apUpdate',{ap:p.ap});
      io.emit('playerDied',{id:targetId,killerId:socket.id,killerName:p.name,killerChar:p.char});
      io.emit('killUpdate',{id:socket.id,kills:p.kills});
      setTimeout(()=>{
        if (!players[targetId]) return;
        const sp=randomSpawn();
        Object.assign(t,{x:sp.x,y:sp.y,hp:HP_MAX,ap:0,alive:true});
        io.emit('playerRespawned',pub(t));
        const ts=io.sockets.sockets.get(targetId);
        if (ts) ts.emit('apUpdate',{ap:0});
      },5000);
      checkWin();
    }
  });

  socket.on('donate', ({ targetId, amount=1 }) => {
    const p = players[socket.id], t = players[targetId];
    if (!p||!p.alive||!t||!t.alive) return;
    if (chebyshev(p.x,p.y,t.x,t.y)>1) { socket.emit('err','Must be adjacent to donate'); return; }
    const amt = Math.max(1,Math.min(amount,p.ap));
    p.ap -= amt; t.ap=Math.min(AP_MAX,t.ap+amt);
    socket.emit('apUpdate',{ap:p.ap});
    const ts=io.sockets.sockets.get(targetId);
    if (ts) ts.emit('apUpdate',{ap:t.ap});
    io.emit('donated',{fromId:socket.id,fromName:p.name,toId:targetId,toName:t.name,amount:amt});
  });

  socket.on('chat', (msg) => {
    const p=players[socket.id]; if (!p||!msg) return;
    io.emit('chatMessage',{id:socket.id,name:p.name,char:p.char,color:p.color,message:msg.slice(0,120)});
  });

  socket.on('disconnect', () => {
    io.emit('playerLeft',socket.id);
    delete players[socket.id];
    if (!gameOver) checkWin();
  });
});

const PORT = process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Tank Tactics on :${PORT}`));
