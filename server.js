const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // Disable per-message deflate — compression adds latency on small frequent packets
  perMessageDeflate: false,
  // Keep connections warm on Render free tier (avoids cold-start lag spikes)
  pingInterval: 10000,
  pingTimeout: 5000,
});
app.use(express.static('public'));

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const TILE = 24;          // pixels per tile
const PLAYER_SPEED = 200; // pixels per second
const BULLET_SPEED = 280; // pixels per second
const BULLET_RADIUS = 3;
const PLAYER_RADIUS = 8;
const HP_MAX = 5;
const BULLETS_START = 10;
const PICKUP_INTERVAL_MS = 60000;
const PICKUPS_PER_SPAWN = 6;
const PICKUP_HP_VAL = 2;
const PICKUP_AMMO_VAL = 5;
const TICK_MS = 1000 / 30; // 30hz — better accuracy, still stable on free tier

const MAP_SIZES = {
  small:  { w: 60,  h: 40  },
  medium: { w: 120, h: 75  },
  large:  { w: 240, h: 150 },
};

// ── MAP GENERATION ────────────────────────────────────────────────────────────
function makeRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s = Math.imul(s ^ (s >>> 16), 0x45d9f3b);
    s ^= s >>> 16;
    return (s >>> 0) / 0xffffffff;
  };
}

function generateMap(seed, cols, rows) {
  const rand = makeRand(seed);
  const tiles = Array.from({ length: rows }, () => Array(cols).fill('.'));

  // Border walls
  for (let y = 0; y < rows; y++) { tiles[y][0] = '#'; tiles[y][cols-1] = '#'; }
  for (let x = 0; x < cols; x++) { tiles[0][x] = '#'; tiles[rows-1][x] = '#'; }

  // Lakes
  const numLakes = Math.floor(cols * rows / 400) + 3;
  for (let l = 0; l < numLakes; l++) {
    const cx = Math.floor(rand()*(cols-20))+10;
    const cy = Math.floor(rand()*(rows-20))+10;
    const rx = Math.floor(rand()*5)+2, ry = Math.floor(rand()*3)+2;
    for (let dy=-ry; dy<=ry; dy++) for (let dx=-rx; dx<=rx; dx++) {
      if ((dx*dx)/(rx*rx)+(dy*dy)/(ry*ry)<=1) {
        const tx=cx+dx,ty=cy+dy;
        if (tx>0&&tx<cols-1&&ty>0&&ty<rows-1) tiles[ty][tx]='~';
      }
    }
  }

  // Rock walls
  const numWalls = Math.floor(cols * rows / 80);
  for (let w=0; w<numWalls; w++) {
    const x=Math.floor(rand()*(cols-10))+3, y=Math.floor(rand()*(rows-6))+3;
    const len=Math.floor(rand()*6)+2, horiz=rand()>0.5;
    for (let i=0;i<len;i++) {
      const tx=horiz?x+i:x, ty=horiz?y:y+i;
      if (tx>0&&tx<cols-1&&ty>0&&ty<rows-1&&tiles[ty][tx]!=='~') tiles[ty][tx]='#';
    }
  }

  // Trees
  const numTrees = Math.floor(cols*rows/18);
  for (let t=0;t<numTrees;t++) {
    const x=Math.floor(rand()*(cols-2))+1, y=Math.floor(rand()*(rows-2))+1;
    if (tiles[y][x]==='.') tiles[y][x]='T';
  }

  // Bushes
  const numBushes = Math.floor(cols*rows/20);
  for (let b=0;b<numBushes;b++) {
    const x=Math.floor(rand()*(cols-2))+1, y=Math.floor(rand()*(rows-2))+1;
    if (tiles[y][x]==='.') tiles[y][x]='"';
  }

  return tiles;
}

// ── COLLISION HELPERS ─────────────────────────────────────────────────────────
// Tiles that block player movement
const SOLID_MOVE = new Set(['#', '~', 'T', '"']);
// Tiles that block bullets (water does NOT block bullets)
const SOLID_BULLET = new Set(['#', 'T', '"']);

function tileAt(map, cols, rows, px, py) {
  const tx = Math.floor(px / TILE), ty = Math.floor(py / TILE);
  if (tx<0||tx>=cols||ty<0||ty>=rows) return '#';
  return map[ty][tx];
}

function isSolid(map, cols, rows, px, py) {
  return SOLID_MOVE.has(tileAt(map, cols, rows, px, py));
}

function isBulletBlocked(map, cols, rows, px, py) {
  return SOLID_BULLET.has(tileAt(map, cols, rows, px, py));
}

// Circle vs tile collision — check corners of bounding box
function circleCollidesMap(map, cols, rows, px, py, r) {
  const offsets = [[-r,-r],[r,-r],[-r,r],[r,r],[0,-r],[0,r],[-r,0],[r,0]];
  return offsets.some(([dx,dy]) => isSolid(map, cols, rows, px+dx, py+dy));
}

// Resolve movement: try full move, then axis-by-axis slide
function resolveMove(map, cols, rows, ox, oy, nx, ny, r) {
  if (!circleCollidesMap(map, cols, rows, nx, ny, r)) return { x: nx, y: ny };
  // Try slide on X only
  if (!circleCollidesMap(map, cols, rows, nx, oy, r)) return { x: nx, y: oy };
  // Try slide on Y only
  if (!circleCollidesMap(map, cols, rows, ox, ny, r)) return { x: ox, y: ny };
  return { x: ox, y: oy };
}

// Ray-march bullet path, return { hit: bool, x, y, playerId }
function marchBullet(map, cols, rows, bx, by, dx, dy, dist, players, shooterId) {
  const steps = Math.ceil(dist / 4);
  const sx = dx * (dist / steps), sy = dy * (dist / steps);
  let cx = bx, cy = by;
  for (let i = 0; i < steps; i++) {
    cx += sx; cy += sy;
    if (isBulletBlocked(map, cols, rows, cx, cy)) return { blocked: true, x: cx, y: cy };
    for (const [id, p] of Object.entries(players)) {
      if (id === shooterId || !p.alive) continue;
      const ddx = cx - p.x, ddy = cy - p.y;
      if (Math.sqrt(ddx*ddx+ddy*ddy) < PLAYER_RADIUS + BULLET_RADIUS)
        return { blocked: false, hit: true, playerId: id, x: cx, y: cy };
    }
  }
  return { blocked: false, hit: false, x: cx, y: cy };
}

// ── ROOM SYSTEM ───────────────────────────────────────────────────────────────
const rooms = {}; // code → room
let nextPickupId = 1;
let nextBulletId = 1;

function genCode() {
  return Math.random().toString(36).slice(2,6).toUpperCase();
}

function findOpenSpawn(map, cols, rows) {
  for (let attempts = 0; attempts < 200; attempts++) {
    const tx = Math.floor(Math.random()*(cols-4))+2;
    const ty = Math.floor(Math.random()*(rows-4))+2;
    if (map[ty][tx] === '.') return { x: tx*TILE+TILE/2, y: ty*TILE+TILE/2 };
  }
  return { x: 2*TILE+TILE/2, y: 2*TILE+TILE/2 };
}

function findEdgeSpawn(map, cols, rows) {
  const edge = Math.floor(Math.random()*4);
  for (let attempts = 0; attempts < 100; attempts++) {
    let tx, ty;
    if (edge===0)      { tx=Math.floor(Math.random()*(cols-4))+2; ty=1; }
    else if (edge===1) { tx=Math.floor(Math.random()*(cols-4))+2; ty=rows-2; }
    else if (edge===2) { tx=1; ty=Math.floor(Math.random()*(rows-4))+2; }
    else               { tx=cols-2; ty=Math.floor(Math.random()*(rows-4))+2; }
    if (map[ty]?.[tx] === '.') return { x: tx*TILE+TILE/2, y: ty*TILE+TILE/2 };
  }
  return findOpenSpawn(map, cols, rows);
}

function spawnPickups(room) {
  const { map, cols, rows, pickups } = room;
  for (let i = 0; i < PICKUPS_PER_SPAWN; i++) {
    for (let attempts = 0; attempts < 50; attempts++) {
      const tx = Math.floor(Math.random()*(cols-4))+2;
      const ty = Math.floor(Math.random()*(rows-4))+2;
      if (map[ty][tx] === '.') {
        const id = nextPickupId++;
        const type = Math.random() < 0.5 ? 'hp' : 'ammo';
        pickups[id] = { id, type, x: tx*TILE+TILE/2, y: ty*TILE+TILE/2 };
        break;
      }
    }
  }
  io.to(room.code).emit('pickupsUpdate', room.pickups);
}

function createRoom(code, hostId, mapSize) {
  const sz = MAP_SIZES[mapSize] || MAP_SIZES.medium;
  const seed = Math.floor(Math.random()*1e9);
  const map = generateMap(seed, sz.w, sz.h);
  const room = {
    code, hostId, mapSize,
    cols: sz.w, rows: sz.h,
    map, players: {}, bullets: {}, pickups: {},
    pickupTimer: null, tickTimer: null,
  };
  rooms[code] = room;

  // Pickup spawner
  room.pickupTimer = setInterval(() => spawnPickups(room), PICKUP_INTERVAL_MS);
  spawnPickups(room); // initial spawn

  // Game tick
  let lastTick = Date.now();
  room.tickTimer = setInterval(() => {
    const now = Date.now();
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    gameTick(room, dt);
  }, TICK_MS);

  return room;
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearInterval(room.pickupTimer);
  clearInterval(room.tickTimer);
  delete rooms[code];
}

// ── GAME TICK ─────────────────────────────────────────────────────────────────
function gameTick(room, dt) {
  const { players, bullets, map, cols, rows } = room;
  let bulletsChanged = false;
  let playersChanged = false;

  // Move players
  for (const p of Object.values(players)) {
    if (!p.alive || (!p.moveX && !p.moveY)) continue;
    const spd = PLAYER_SPEED * dt;
    const len = Math.sqrt(p.moveX*p.moveX + p.moveY*p.moveY) || 1;
    const ndx = p.moveX/len, ndy = p.moveY/len;
    const nx = p.x + ndx*spd, ny = p.y + ndy*spd;
    const resolved = resolveMove(map, cols, rows, p.x, p.y, nx, ny, PLAYER_RADIUS);

    // Pickup collection
    for (const [pid, pk] of Object.entries(room.pickups)) {
      const ddx = resolved.x - pk.x, ddy = resolved.y - pk.y;
      if (Math.sqrt(ddx*ddx+ddy*ddy) < PLAYER_RADIUS + 10) {
        if (pk.type === 'hp')   { p.hp = Math.min(HP_MAX, p.hp + PICKUP_HP_VAL); }
        if (pk.type === 'ammo') { p.bullets += PICKUP_AMMO_VAL; }
        delete room.pickups[pid];
        io.to(room.code).emit('pickupCollected', { pickupId: pid, playerId: p.id, hp: p.hp, bullets: p.bullets });
      }
    }

    if (resolved.x !== p.x || resolved.y !== p.y) {
      p.x = resolved.x; p.y = resolved.y;
      playersChanged = true;
    }
  }

  // Move bullets
  for (const [bid, b] of Object.entries(bullets)) {
    const dist = BULLET_SPEED * dt;
    const result = marchBullet(map, cols, rows, b.x, b.y, b.dx, b.dy, dist, players, b.ownerId);
    b.x = result.x; b.y = result.y;
    b.life -= dt;

    if (result.blocked || b.life <= 0) {
      io.to(room.code).emit('bulletDead', { id: bid, x: b.x, y: b.y, reason: 'wall' });
      delete bullets[bid];
      bulletsChanged = true;
    } else if (result.hit) {
      const target = players[result.playerId];
      const shooter = players[b.ownerId];
      target.hp -= 1;
      io.to(room.code).emit('bulletDead', { id: bid, x: b.x, y: b.y, reason: 'hit', targetId: result.playerId });
      io.to(room.code).emit('playerHit', { id: result.playerId, hp: target.hp, shooterId: b.ownerId });
      delete bullets[bid];
      bulletsChanged = true;

      if (target.hp <= 0) {
        target.alive = false;
        if (shooter) shooter.kills++;
        // Drop pickups
        const dropped = [];
        const dropAmt = Math.floor(target.bullets / 2);
        for (let d = 0; d < Math.min(dropAmt, 3); d++) {
          const id = nextPickupId++;
          const angle = (d / 3) * Math.PI * 2;
          room.pickups[id] = { id, type: 'ammo', x: target.x + Math.cos(angle)*16, y: target.y + Math.sin(angle)*16 };
          dropped.push(room.pickups[id]);
        }
        target.bullets = Math.max(0, target.bullets - dropAmt);
        io.to(room.code).emit('playerDied', {
          id: target.id, killerId: b.ownerId,
          killerName: shooter?.name || '?',
          killerChar: shooter?.char || '?',
          drops: dropped,
        });
        io.to(room.code).emit('killUpdate', { id: b.ownerId, kills: shooter?.kills || 0 });

        // Respawn after 4s
        setTimeout(() => {
          if (!rooms[room.code] || !players[target.id]) return;
          const sp = findEdgeSpawn(map, cols, rows);
          target.x = sp.x; target.y = sp.y;
          target.hp = HP_MAX; target.bullets = BULLETS_START; target.alive = true;
          io.to(room.code).emit('playerRespawned', pubPlayer(target));
        }, 4000);
      }
    }
  }

  if (playersChanged) {
    // Build moved positions
    const movedPos = {};
    for (const [id, p] of Object.entries(players)) {
      if (p.alive && (p.moveX || p.moveY)) movedPos[id] = { x: p.x, y: p.y };
    }

    for (const [id] of Object.entries(players)) {
      const sock = io.sockets.sockets.get(id);
      if (!sock) continue;

      // Send other players' positions (for rendering them)
      const others = {};
      for (const [oid, pos] of Object.entries(movedPos)) {
        if (oid !== id) others[oid] = pos;
      }
      if (Object.keys(others).length) sock.emit('positions', others);

      // Send self-correction ONLY if the player hit a wall (server pos differs from
      // what client would predict for open movement). Client ignores this unless
      // the delta exceeds its threshold — eliminates rubberbanding on open ground.
      const p = players[id];
      if (p && p.alive && (p.moveX || p.moveY)) {
        sock.emit('selfCorrection', { x: p.x, y: p.y });
      }
    }
  }
}

// ── PUB HELPERS ───────────────────────────────────────────────────────────────
function pubPlayer(p) {
  return { id:p.id, name:p.name, char:p.char, color:p.color,
           x:p.x, y:p.y, hp:p.hp, bullets:p.bullets, alive:p.alive, kills:p.kills };
}
function pubRoom(room) {
  return {
    code: room.code, hostId: room.hostId, mapSize: room.mapSize,
    cols: room.cols, rows: room.rows, map: room.map,
    players: Object.fromEntries(Object.entries(room.players).map(([id,p])=>[id,pubPlayer(p)])),
    pickups: room.pickups,
  };
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let myRoom = null;
  let myPlayer = null;

  // ── Create room ──
  socket.on('createRoom', ({ name, char, color, mapSize }) => {
    let code;
    do { code = genCode(); } while (rooms[code]);
    const room = createRoom(code, socket.id, mapSize || 'medium');
    const sp = findEdgeSpawn(room.map, room.cols, room.rows);
    myPlayer = {
      id: socket.id, name: (name||'Wanderer').slice(0,15),
      char: (char||'@')[0], color: color||'#00ff88',
      x: sp.x, y: sp.y, hp: HP_MAX, bullets: BULLETS_START,
      alive: true, kills: 0, moveX: 0, moveY: 0,
    };
    room.players[socket.id] = myPlayer;
    myRoom = room;
    socket.join(code);
    socket.emit('roomJoined', pubRoom(room));
  });

  // ── Join room ──
  socket.on('joinRoom', ({ code, name, char, color }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('roomError', 'Room not found'); return; }
    const sp = findEdgeSpawn(room.map, room.cols, room.rows);
    myPlayer = {
      id: socket.id, name: (name||'Wanderer').slice(0,15),
      char: (char||'@')[0], color: color||'#00ff88',
      x: sp.x, y: sp.y, hp: HP_MAX, bullets: BULLETS_START,
      alive: true, kills: 0, moveX: 0, moveY: 0,
    };
    room.players[socket.id] = myPlayer;
    myRoom = room;
    socket.join(code);
    socket.emit('roomJoined', pubRoom(room));
    socket.to(code).emit('newPlayer', pubPlayer(myPlayer));
  });

  // ── Input ──
  socket.on('input', ({ moveX, moveY }) => {
    if (!myPlayer || !myRoom) return;
    myPlayer.moveX = moveX || 0;
    myPlayer.moveY = moveY || 0;
  });

  // ── Shoot ──
  socket.on('shoot', ({ dx, dy }) => {
    if (!myPlayer || !myRoom || !myPlayer.alive) return;
    if (myPlayer.bullets <= 0) { socket.emit('noAmmo'); return; }
    const len = Math.sqrt(dx*dx+dy*dy);
    if (len === 0) return;
    myPlayer.bullets--;
    socket.emit('ammoUpdate', { bullets: myPlayer.bullets });
    const bid = nextBulletId++;
    const bullet = {
      id: bid, ownerId: socket.id,
      x: myPlayer.x, y: myPlayer.y,
      dx: dx/len, dy: dy/len,
      life: 3, // seconds until auto-expire
    };
    myRoom.bullets[bid] = bullet;
    // Broadcast to everyone EXCEPT shooter — shooter spawns bullet locally already
    socket.to(myRoom.code).emit('bulletSpawned', {
      id: bid, ownerId: socket.id,
      x: bullet.x, y: bullet.y, dx: bullet.dx, dy: bullet.dy,
    });
  });

  // ── Chat ──
  socket.on('chat', (msg) => {
    if (!myPlayer || !myRoom || !msg) return;
    io.to(myRoom.code).emit('chatMessage', {
      name: myPlayer.name, char: myPlayer.char, color: myPlayer.color,
      message: msg.slice(0,120),
    });
  });

  // ── Disconnect ──
  socket.on('disconnect', () => {
    if (!myRoom) return;
    delete myRoom.players[socket.id];
    io.to(myRoom.code).emit('playerLeft', socket.id);
    if (myRoom.hostId === socket.id) {
      io.to(myRoom.code).emit('roomClosed');
      destroyRoom(myRoom.code);
    } else if (Object.keys(myRoom.players).length === 0) {
      destroyRoom(myRoom.code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Running on :${PORT}`));
