const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  perMessageDeflate: false,
  pingInterval: 10000,
  pingTimeout: 5000,
});
app.use(express.static('public'));

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const TILE          = 24;
const BULLET_SPEED  = 300; // px/s — server marches bullets on its own tick
const BULLET_RADIUS = 4;
const PLAYER_RADIUS = 8;
const HP_MAX        = 5;
const BULLETS_START = 10;
const PICKUP_INTERVAL_MS = 60000;
const PICKUPS_PER_SPAWN  = 6;
const PICKUP_HP_VAL   = 2;
const PICKUP_AMMO_VAL = 5;
// Position update rate-limit: ignore updates faster than this (anti-speedhack)
const POS_UPDATE_MIN_MS = 33; // ~30hz max from any client

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
  for (let y = 0; y < rows; y++) { tiles[y][0] = '#'; tiles[y][cols-1] = '#'; }
  for (let x = 0; x < cols; x++) { tiles[0][x] = '#'; tiles[rows-1][x] = '#'; }
  const numLakes = Math.floor(cols * rows / 400) + 3;
  for (let l = 0; l < numLakes; l++) {
    const cx = Math.floor(rand()*(cols-20))+10;
    const cy = Math.floor(rand()*(rows-20))+10;
    const rx = Math.floor(rand()*5)+2, ry = Math.floor(rand()*3)+2;
    for (let dy=-ry; dy<=ry; dy++) for (let dx=-rx; dx<=rx; dx++) {
      if ((dx*dx)/(rx*rx)+(dy*dy)/(ry*ry)<=1) {
        const tx=cx+dx, ty=cy+dy;
        if (tx>0&&tx<cols-1&&ty>0&&ty<rows-1) tiles[ty][tx]='~';
      }
    }
  }
  const numWalls = Math.floor(cols * rows / 80);
  for (let w=0; w<numWalls; w++) {
    const x=Math.floor(rand()*(cols-10))+3, y=Math.floor(rand()*(rows-6))+3;
    const len=Math.floor(rand()*6)+2, horiz=rand()>0.5;
    for (let i=0;i<len;i++) {
      const tx=horiz?x+i:x, ty=horiz?y:y+i;
      if (tx>0&&tx<cols-1&&ty>0&&ty<rows-1&&tiles[ty][tx]!=='~') tiles[ty][tx]='#';
    }
  }
  for (let t=0; t<Math.floor(cols*rows/18); t++) {
    const x=Math.floor(rand()*(cols-2))+1, y=Math.floor(rand()*(rows-2))+1;
    if (tiles[y][x]==='.') tiles[y][x]='T';
  }
  for (let b=0; b<Math.floor(cols*rows/20); b++) {
    const x=Math.floor(rand()*(cols-2))+1, y=Math.floor(rand()*(rows-2))+1;
    if (tiles[y][x]==='.') tiles[y][x]='"';
  }
  return tiles;
}

// ── COLLISION ─────────────────────────────────────────────────────────────────
// Bullets are blocked by walls, trees, bushes — NOT water
const BULLET_SOLID = new Set(['#', 'T', '"']);

function tileAt(map, cols, rows, px, py) {
  const tx = Math.floor(px/TILE), ty = Math.floor(py/TILE);
  if (tx<0||tx>=cols||ty<0||ty>=rows) return '#';
  return map[ty][tx];
}

function bulletBlocked(map, cols, rows, px, py) {
  return BULLET_SOLID.has(tileAt(map, cols, rows, px, py));
}

// March bullet from (bx,by) by dist pixels, return result
function marchBullet(map, cols, rows, bx, by, dx, dy, dist, players, ownerId) {
  const steps = Math.ceil(dist / 3);
  const sx = dx*(dist/steps), sy = dy*(dist/steps);
  let cx=bx, cy=by;
  for (let i=0; i<steps; i++) {
    cx+=sx; cy+=sy;
    if (bulletBlocked(map, cols, rows, cx, cy))
      return { type:'wall', x:cx, y:cy };
    for (const [id, p] of Object.entries(players)) {
      if (id===ownerId || !p.alive) continue;
      const ddx=cx-p.x, ddy=cy-p.y;
      if (Math.sqrt(ddx*ddx+ddy*ddy) < PLAYER_RADIUS+BULLET_RADIUS)
        return { type:'hit', playerId:id, x:cx, y:cy };
    }
  }
  return { type:'none', x:cx, y:cy };
}

// ── ROOM HELPERS ──────────────────────────────────────────────────────────────
const rooms = {};
let nextPickupId = 1;
let nextBulletId = 1;

function genCode() {
  return Math.random().toString(36).slice(2,6).toUpperCase();
}

function findOpenSpawn(map, cols, rows) {
  for (let i=0; i<300; i++) {
    const tx=Math.floor(Math.random()*(cols-4))+2;
    const ty=Math.floor(Math.random()*(rows-4))+2;
    if (map[ty][tx]==='.') return { x:tx*TILE+TILE/2, y:ty*TILE+TILE/2 };
  }
  return { x:2*TILE+TILE/2, y:2*TILE+TILE/2 };
}

function findEdgeSpawn(map, cols, rows) {
  const edge = Math.floor(Math.random()*4);
  for (let i=0; i<100; i++) {
    let tx, ty;
    if      (edge===0) { tx=Math.floor(Math.random()*(cols-4))+2; ty=1; }
    else if (edge===1) { tx=Math.floor(Math.random()*(cols-4))+2; ty=rows-2; }
    else if (edge===2) { tx=1; ty=Math.floor(Math.random()*(rows-4))+2; }
    else               { tx=cols-2; ty=Math.floor(Math.random()*(rows-4))+2; }
    if (map[ty]?.[tx]==='.') return { x:tx*TILE+TILE/2, y:ty*TILE+TILE/2 };
  }
  return findOpenSpawn(map, cols, rows);
}

function spawnPickups(room) {
  for (let i=0; i<PICKUPS_PER_SPAWN; i++) {
    for (let a=0; a<50; a++) {
      const tx=Math.floor(Math.random()*(room.cols-4))+2;
      const ty=Math.floor(Math.random()*(room.rows-4))+2;
      if (room.map[ty][tx]==='.') {
        const id=nextPickupId++;
        const type=Math.random()<0.5?'hp':'ammo';
        room.pickups[id]={ id, type, x:tx*TILE+TILE/2, y:ty*TILE+TILE/2 };
        break;
      }
    }
  }
  io.to(room.code).emit('pickupsUpdate', room.pickups);
}

function pubPlayer(p) {
  return { id:p.id, name:p.name, char:p.char, color:p.color,
           x:p.x, y:p.y, hp:p.hp, bullets:p.bullets, alive:p.alive, kills:p.kills };
}
function pubRoom(room) {
  return {
    code:room.code, hostId:room.hostId, mapSize:room.mapSize,
    cols:room.cols, rows:room.rows, map:room.map,
    players:Object.fromEntries(Object.entries(room.players).map(([id,p])=>[id,pubPlayer(p)])),
    pickups:room.pickups,
  };
}

// ── BULLET TICK ───────────────────────────────────────────────────────────────
// Bullets still live on the server (for authoritative hit detection),
// but movement is ticked here. This is the ONLY server tick — lightweight.
function tickBullets(room, dt) {
  const { bullets, players, map, cols, rows } = room;
  for (const [bid, b] of Object.entries(bullets)) {
    const dist = BULLET_SPEED * dt;
    const result = marchBullet(map, cols, rows, b.x, b.y, b.dx, b.dy, dist, players, b.ownerId);
    b.x = result.x; b.y = result.y;
    b.life -= dt;

    if (result.type === 'wall' || b.life <= 0) {
      io.to(room.code).emit('bulletDead', { id:bid, x:b.x, y:b.y });
      delete bullets[bid];

    } else if (result.type === 'hit') {
      const target  = players[result.playerId];
      const shooter = players[b.ownerId];
      if (!target) { delete bullets[bid]; continue; }

      target.hp -= 1;
      io.to(room.code).emit('bulletDead', { id:bid, x:b.x, y:b.y });
      io.to(room.code).emit('playerHit', { id:result.playerId, hp:target.hp, shooterId:b.ownerId });
      delete bullets[bid];

      if (target.hp <= 0) {
        target.alive = false;
        if (shooter) shooter.kills++;

        // Drop ammo pickups at death position
        const dropped = [];
        const dropAmt = Math.min(Math.floor(target.bullets/2), 3);
        for (let d=0; d<dropAmt; d++) {
          const pid = nextPickupId++;
          const angle = (d/dropAmt)*Math.PI*2;
          room.pickups[pid] = { id:pid, type:'ammo',
            x:target.x+Math.cos(angle)*18, y:target.y+Math.sin(angle)*18 };
          dropped.push(room.pickups[pid]);
        }
        target.bullets = Math.max(0, target.bullets-dropAmt);

        io.to(room.code).emit('playerDied', {
          id:target.id, killerId:b.ownerId,
          killerName:shooter?.name||'?', killerChar:shooter?.char||'?',
          drops:dropped,
        });
        if (shooter) io.to(room.code).emit('killUpdate', { id:b.ownerId, kills:shooter.kills });

        // Respawn after 4s
        setTimeout(() => {
          if (!rooms[room.code] || !players[target.id]) return;
          const sp = findEdgeSpawn(map, cols, rows);
          target.x=sp.x; target.y=sp.y;
          target.hp=HP_MAX; target.bullets=BULLETS_START; target.alive=true;
          io.to(room.code).emit('playerRespawned', pubPlayer(target));
        }, 4000);
      }
    }
  }
}

function createRoom(code, hostId, mapSize) {
  const sz  = MAP_SIZES[mapSize] || MAP_SIZES.medium;
  const seed = Math.floor(Math.random()*1e9);
  const map  = generateMap(seed, sz.w, sz.h);
  const room = {
    code, hostId, mapSize,
    cols:sz.w, rows:sz.h,
    map, players:{}, bullets:{}, pickups:{},
    pickupTimer:null, bulletTimer:null,
  };
  rooms[code] = room;

  room.pickupTimer = setInterval(() => spawnPickups(room), PICKUP_INTERVAL_MS);
  spawnPickups(room);

  // Only tick bullets — no player movement here
  let last = Date.now();
  room.bulletTimer = setInterval(() => {
    const now = Date.now();
    const dt  = Math.min((now-last)/1000, 0.1); // cap dt so stalls don't teleport
    last = now;
    if (Object.keys(room.bullets).length) tickBullets(room, dt);
  }, 1000/30); // 30hz is plenty just for bullets

  return room;
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearInterval(room.pickupTimer);
  clearInterval(room.bulletTimer);
  delete rooms[code];
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let myRoom   = null;
  let myPlayer = null;
  let lastPosTime = 0; // rate-limit position updates

  function joinRoomAs(room, name, char, color) {
    const sp = findEdgeSpawn(room.map, room.cols, room.rows);
    myPlayer = {
      id:socket.id,
      name:(name||'Wanderer').slice(0,15),
      char:(char||'@')[0],
      color:color||'#00ff88',
      x:sp.x, y:sp.y,
      hp:HP_MAX, bullets:BULLETS_START,
      alive:true, kills:0,
    };
    room.players[socket.id] = myPlayer;
    myRoom = room;
    socket.join(room.code);
  }

  socket.on('createRoom', ({ name, char, color, mapSize }) => {
    let code; do { code=genCode(); } while (rooms[code]);
    const room = createRoom(code, socket.id, mapSize||'medium');
    joinRoomAs(room, name, char, color);
    socket.emit('roomJoined', pubRoom(room));
  });

  socket.on('joinRoom', ({ code, name, char, color }) => {
    const room = rooms[code.toUpperCase()];
    if (!room) { socket.emit('roomError', 'Room not found'); return; }
    joinRoomAs(room, name, char, color);
    socket.emit('roomJoined', pubRoom(room));
    socket.to(room.code).emit('newPlayer', pubPlayer(myPlayer));
  });

  // ── Client pushes its own position — server stores it for bullet hit checks ──
  // Rate-limited so a cheater can't spam. Max ~30 updates/sec accepted.
  socket.on('pos', ({ x, y }) => {
    if (!myPlayer || !myRoom || !myPlayer.alive) return;
    const now = Date.now();
    if (now - lastPosTime < POS_UPDATE_MIN_MS) return;
    lastPosTime = now;

    // Sanity-bound: don't accept positions outside the map
    const maxX = myRoom.cols * TILE, maxY = myRoom.rows * TILE;
    if (x<0||x>maxX||y<0||y>maxY) return;

    myPlayer.x = x;
    myPlayer.y = y;

    // Check pickup collection at new position
    for (const [pid, pk] of Object.entries(myRoom.pickups)) {
      const dx=x-pk.x, dy=y-pk.y;
      if (Math.sqrt(dx*dx+dy*dy) < PLAYER_RADIUS+12) {
        if (pk.type==='hp')   myPlayer.hp = Math.min(HP_MAX, myPlayer.hp+PICKUP_HP_VAL);
        if (pk.type==='ammo') myPlayer.bullets += PICKUP_AMMO_VAL;
        delete myRoom.pickups[pid];
        io.to(myRoom.code).emit('pickupCollected',
          { pickupId:pid, playerId:socket.id, hp:myPlayer.hp, bullets:myPlayer.bullets });
      }
    }

    // Broadcast position to everyone else in the room (not back to self)
    socket.to(myRoom.code).emit('pos', { id:socket.id, x, y });
  });

  // ── Shoot ──
  socket.on('shoot', ({ x, y, dx, dy }) => {
    if (!myPlayer || !myRoom || !myPlayer.alive) return;
    if (myPlayer.bullets <= 0) { socket.emit('noAmmo'); return; }
    const len = Math.sqrt(dx*dx+dy*dy);
    if (!len) return;

    myPlayer.bullets--;
    socket.emit('ammoUpdate', { bullets:myPlayer.bullets });

    const bid = nextBulletId++;
    // Use shooter's reported position (they own it) — but clamp to map
    const bx = Math.max(0, Math.min(myRoom.cols*TILE, x??myPlayer.x));
    const by = Math.max(0, Math.min(myRoom.rows*TILE, y??myPlayer.y));

    myRoom.bullets[bid] = {
      id:bid, ownerId:socket.id,
      x:bx, y:by,
      dx:dx/len, dy:dy/len,
      life:3,
    };

    // Tell everyone else so they can render the bullet
    socket.to(myRoom.code).emit('bulletSpawned', {
      id:bid, ownerId:socket.id, x:bx, y:by, dx:dx/len, dy:dy/len,
    });
  });

  socket.on('chat', (msg) => {
    if (!myPlayer || !myRoom || !msg) return;
    io.to(myRoom.code).emit('chatMessage', {
      name:myPlayer.name, char:myPlayer.char, color:myPlayer.color,
      message:msg.slice(0,120),
    });
  });

  socket.on('disconnect', () => {
    if (!myRoom) return;
    delete myRoom.players[socket.id];
    io.to(myRoom.code).emit('playerLeft', socket.id);
    if (myRoom.hostId===socket.id) {
      io.to(myRoom.code).emit('roomClosed');
      destroyRoom(myRoom.code);
    } else if (Object.keys(myRoom.players).length===0) {
      destroyRoom(myRoom.code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Tank Tactics on :${PORT}`));
