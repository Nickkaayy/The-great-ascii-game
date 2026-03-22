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
const TILE             = 24;
const HP_MAX           = 5;
const BULLETS_START    = 10;
const BULLET_SPEED_TPS = 10;   // tiles per second (visual travel speed)
const PICKUP_INTERVAL  = 60000;
const PICKUPS_PER_WAVE = 8;
const PICKUP_HP_VAL    = 2;
const PICKUP_AMMO_VAL  = 5;

const MAP_SIZES = {
  small:  { w: 40,  h: 25  },
  medium: { w: 80,  h: 50  },
  large:  { w: 160, h: 100 },
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

// Decor tiles — purely visual, no collision
const DECOR = ['"', '"', '"', ',', '`', "'", ';'];

function generateMap(seed, cols, rows) {
  const rand = makeRand(seed);
  const tiles = Array.from({ length: rows }, () => Array(cols).fill('.'));

  // Border walls
  for (let y = 0; y < rows; y++) { tiles[y][0] = '#'; tiles[y][cols-1] = '#'; }
  for (let x = 0; x < cols; x++) { tiles[0][x] = '#'; tiles[rows-1][x] = '#'; }

  // Lakes (water — blocks players, not bullets)
  const numLakes = Math.floor(cols * rows / 300) + 2;
  for (let l = 0; l < numLakes; l++) {
    const cx = Math.floor(rand()*(cols-16))+8;
    const cy = Math.floor(rand()*(rows-12))+6;
    const rx = Math.floor(rand()*5)+2;
    const ry = Math.floor(rand()*3)+2;
    for (let dy=-ry; dy<=ry; dy++) for (let dx=-rx; dx<=rx; dx++) {
      if ((dx*dx)/(rx*rx)+(dy*dy)/(ry*ry)<=1) {
        const tx=cx+dx, ty=cy+dy;
        if (tx>0&&tx<cols-1&&ty>0&&ty<rows-1) tiles[ty][tx]='~';
      }
    }
  }

  // Rock walls (block players AND bullets)
  const numWalls = Math.floor(cols * rows / 60);
  for (let w=0; w<numWalls; w++) {
    const x = Math.floor(rand()*(cols-8))+3;
    const y = Math.floor(rand()*(rows-6))+3;
    const len = Math.floor(rand()*5)+2;
    const horiz = rand()>0.5;
    for (let i=0; i<len; i++) {
      const tx=horiz?x+i:x, ty=horiz?y:y+i;
      if (tx>0&&tx<cols-1&&ty>0&&ty<rows-1&&tiles[ty][tx]!=='~')
        tiles[ty][tx]='#';
    }
  }

  // Decorative ground cover — walkable, shootable-through
  const numDecor = Math.floor(cols*rows/5);
  for (let d=0; d<numDecor; d++) {
    const x = Math.floor(rand()*(cols-2))+1;
    const y = Math.floor(rand()*(rows-2))+1;
    if (tiles[y][x]==='.') tiles[y][x] = DECOR[Math.floor(rand()*DECOR.length)];
  }

  return tiles;
}

// ── COLLISION ─────────────────────────────────────────────────────────────────
// Player collision: walls + water
function blocksPlayer(tile) { return tile==='#'||tile==='~'; }
// Bullet collision: walls only
function blocksBullet(tile) { return tile==='#'; }

function tileAt(map, cols, rows, tx, ty) {
  if (tx<0||tx>=cols||ty<0||ty>=rows) return '#';
  return map[ty][tx];
}

// ── HELPERS ───────────────────────────────────────────────────────────────────
const rooms = {};
let nextBulletId = 1;
let nextPickupId = 1;

function genCode() {
  return Math.random().toString(36).slice(2,6).toUpperCase();
}

function findOpenTile(map, cols, rows) {
  for (let i=0; i<400; i++) {
    const tx = Math.floor(Math.random()*(cols-4))+2;
    const ty = Math.floor(Math.random()*(rows-4))+2;
    if (map[ty][tx]==='.') return { tx, ty };
  }
  return { tx:2, ty:2 };
}

function findEdgeTile(map, cols, rows) {
  const edge = Math.floor(Math.random()*4);
  for (let i=0; i<100; i++) {
    let tx, ty;
    if      (edge===0) { tx=Math.floor(Math.random()*(cols-4))+2; ty=1; }
    else if (edge===1) { tx=Math.floor(Math.random()*(cols-4))+2; ty=rows-2; }
    else if (edge===2) { tx=1; ty=Math.floor(Math.random()*(rows-4))+2; }
    else               { tx=cols-2; ty=Math.floor(Math.random()*(rows-4))+2; }
    if (!blocksPlayer(map[ty]?.[tx])) return { tx, ty };
  }
  return findOpenTile(map, cols, rows);
}

function spawnPickups(room) {
  for (let i=0; i<PICKUPS_PER_WAVE; i++) {
    for (let a=0; a<60; a++) {
      const tx=Math.floor(Math.random()*(room.cols-4))+2;
      const ty=Math.floor(Math.random()*(room.rows-4))+2;
      // Allow pickups on any non-wall non-water tile (including decor)
      const t=room.map[ty][tx];
      if (!blocksPlayer(t)) {
        const id=nextPickupId++;
        room.pickups[id]={ id, type:Math.random()<0.5?'hp':'ammo', tx, ty };
        break;
      }
    }
  }
  io.to(room.code).emit('pickupsUpdate', room.pickups);
}

function pubPlayer(p) {
  return { id:p.id, name:p.name, char:p.char, color:p.color,
           tx:p.tx, ty:p.ty, hp:p.hp, bullets:p.bullets,
           alive:p.alive, kills:p.kills };
}
function pubRoom(room) {
  return {
    code:room.code, hostId:room.hostId, mapSize:room.mapSize,
    cols:room.cols, rows:room.rows, map:room.map,
    players:Object.fromEntries(Object.entries(room.players).map(([id,p])=>[id,pubPlayer(p)])),
    pickups:room.pickups,
    config:{ TILE, HP_MAX, BULLETS_START, BULLET_SPEED_TPS },
  };
}

// ── BULLET TICK ───────────────────────────────────────────────────────────────
// Bullets travel one tile at a time. Each bullet has a fractional progress (0..1)
// between its current tile and next tile. When progress >= 1, it steps to next tile.
function tickBullets(room, dt) {
  const { bullets, players, map, cols, rows } = room;
  for (const [bid, b] of Object.entries(bullets)) {
    b.progress += BULLET_SPEED_TPS * dt;

    while (b.progress >= 1) {
      b.progress -= 1;
      b.tx += b.dx;
      b.ty += b.dy;

      // Wall check
      if (blocksBullet(tileAt(map, cols, rows, b.tx, b.ty))) {
        io.to(room.code).emit('bulletDead', { id:bid, tx:b.tx, ty:b.ty });
        delete bullets[bid];
        break;
      }

      // Player hit check
      let hit = false;
      for (const [pid, p] of Object.entries(players)) {
        if (pid===b.ownerId||!p.alive) continue;
        if (p.tx===b.tx&&p.ty===b.ty) {
          p.hp -= 1;
          const shooter = players[b.ownerId];
          io.to(room.code).emit('bulletDead', { id:bid, tx:b.tx, ty:b.ty });
          io.to(room.code).emit('playerHit', { id:pid, hp:p.hp, shooterId:b.ownerId });
          delete bullets[bid];
          hit = true;

          if (p.hp <= 0) {
            p.alive = false;
            if (shooter) shooter.kills++;
            // Drop pickups
            const dropped = [];
            const dropAmt = Math.min(Math.floor(p.bullets/2), 4);
            const dirs = [{dx:1,dy:0},{dx:-1,dy:0},{dx:0,dy:1},{dx:0,dy:-1}];
            for (let d=0; d<dropAmt; d++) {
              const dir=dirs[d%4];
              const dtx=p.tx+dir.dx, dty=p.ty+dir.dy;
              if (!blocksPlayer(tileAt(map,cols,rows,dtx,dty))) {
                const dpid=nextPickupId++;
                room.pickups[dpid]={ id:dpid, type:'ammo', tx:dtx, ty:dty };
                dropped.push(room.pickups[dpid]);
              }
            }
            p.bullets=Math.max(0,p.bullets-dropAmt);
            io.to(room.code).emit('playerDied',{
              id:pid, killerId:b.ownerId,
              killerName:shooter?.name||'?', killerChar:shooter?.char||'?',
              drops:dropped,
            });
            if (shooter) io.to(room.code).emit('killUpdate',{id:b.ownerId,kills:shooter.kills});
            setTimeout(()=>{
              if (!rooms[room.code]||!players[pid]) return;
              const sp=findEdgeTile(map,cols,rows);
              p.tx=sp.tx; p.ty=sp.ty; p.hp=HP_MAX; p.bullets=BULLETS_START; p.alive=true;
              io.to(room.code).emit('playerRespawned',pubPlayer(p));
            },4000);
          }
          break;
        }
      }
      if (hit || !bullets[bid]) break;
    }

    // Broadcast position for smooth visual travel
    if (bullets[bid]) {
      io.to(room.code).emit('bulletPos', { id:bid, tx:b.tx, ty:b.ty, progress:b.progress });
    }

    // Life expiry
    if (bullets[bid]) {
      b.life -= dt;
      if (b.life<=0) { io.to(room.code).emit('bulletDead',{id:bid}); delete bullets[bid]; }
    }
  }
}

function createRoom(code, hostId, mapSize) {
  const sz   = MAP_SIZES[mapSize]||MAP_SIZES.medium;
  const seed = Math.floor(Math.random()*1e9);
  const map  = generateMap(seed, sz.w, sz.h);
  const room = { code, hostId, mapSize, cols:sz.w, rows:sz.h,
                 map, players:{}, bullets:{}, pickups:{},
                 pickupTimer:null, bulletTimer:null };
  rooms[code] = room;
  room.pickupTimer = setInterval(()=>spawnPickups(room), PICKUP_INTERVAL);
  spawnPickups(room);
  let last = Date.now();
  room.bulletTimer = setInterval(()=>{
    const now=Date.now();
    const dt=Math.min((now-last)/1000, 0.1);
    last=now;
    if (Object.keys(room.bullets).length) tickBullets(room,dt);
  }, 1000/30);
  return room;
}

function destroyRoom(code) {
  const room=rooms[code]; if (!room) return;
  clearInterval(room.pickupTimer);
  clearInterval(room.bulletTimer);
  delete rooms[code];
}

// ── SOCKET ────────────────────────────────────────────────────────────────────
io.on('connection', (socket)=>{
  let myRoom=null, myPlayer=null;

  function joinAs(room, name, char, color) {
    const sp=findEdgeTile(room.map,room.cols,room.rows);
    myPlayer={
      id:socket.id, name:(name||'Wanderer').slice(0,15),
      char:(char||'@')[0], color:color||'#00ff88',
      tx:sp.tx, ty:sp.ty, hp:HP_MAX, bullets:BULLETS_START,
      alive:true, kills:0,
    };
    room.players[socket.id]=myPlayer;
    myRoom=room;
    socket.join(room.code);
  }

  socket.on('createRoom',({name,char,color,mapSize})=>{
    let code; do{code=genCode();}while(rooms[code]);
    const room=createRoom(code,socket.id,mapSize||'medium');
    joinAs(room,name,char,color);
    socket.emit('roomJoined',pubRoom(room));
  });

  socket.on('joinRoom',({code,name,char,color})=>{
    const room=rooms[code.toUpperCase()];
    if (!room){socket.emit('roomError','Room not found');return;}
    joinAs(room,name,char,color);
    socket.emit('roomJoined',pubRoom(room));
    socket.to(room.code).emit('newPlayer',pubPlayer(myPlayer));
  });

  // Move: client requests a tile step, server validates and confirms
  socket.on('move',({dx,dy})=>{
    if (!myPlayer||!myRoom||!myPlayer.alive) return;
    const ntx=myPlayer.tx+dx, nty=myPlayer.ty+dy;
    const tile=tileAt(myRoom.map,myRoom.cols,myRoom.rows,ntx,nty);
    if (blocksPlayer(tile)) { socket.emit('moveDenied',{tx:myPlayer.tx,ty:myPlayer.ty}); return; }
    // Check tile not occupied by another alive player
    const occupied=Object.values(myRoom.players).some(
      p=>p.id!==socket.id&&p.alive&&p.tx===ntx&&p.ty===nty
    );
    if (occupied) { socket.emit('moveDenied',{tx:myPlayer.tx,ty:myPlayer.ty}); return; }
    myPlayer.tx=ntx; myPlayer.ty=nty;
    // Pickup check
    for (const [pid,pk] of Object.entries(myRoom.pickups)) {
      if (pk.tx===ntx&&pk.ty===nty) {
        if (pk.type==='hp')   myPlayer.hp=Math.min(HP_MAX,myPlayer.hp+PICKUP_HP_VAL);
        if (pk.type==='ammo') myPlayer.bullets+=PICKUP_AMMO_VAL;
        delete myRoom.pickups[pid];
        io.to(myRoom.code).emit('pickupCollected',
          {pickupId:pid,playerId:socket.id,hp:myPlayer.hp,bullets:myPlayer.bullets});
      }
    }
    io.to(myRoom.code).emit('playerMoved',{id:socket.id,tx:myPlayer.tx,ty:myPlayer.ty});
  });

  // Shoot: cardinal direction bullet
  socket.on('shoot',({dx,dy})=>{
    if (!myPlayer||!myRoom||!myPlayer.alive) return;
    if (myPlayer.bullets<=0){socket.emit('noAmmo');return;}
    // Normalize to cardinal
    const adx=Math.abs(dx)>=Math.abs(dy)?(dx>0?1:-1):0;
    const ady=Math.abs(dy)>Math.abs(dx)?(dy>0?1:-1):0;
    if (adx===0&&ady===0) return;
    myPlayer.bullets--;
    socket.emit('ammoUpdate',{bullets:myPlayer.bullets});
    const bid=nextBulletId++;
    myRoom.bullets[bid]={
      id:bid, ownerId:socket.id,
      tx:myPlayer.tx, ty:myPlayer.ty,
      dx:adx, dy:ady, progress:0, life:4,
    };
    io.to(myRoom.code).emit('bulletSpawned',{
      id:bid, ownerId:socket.id,
      tx:myPlayer.tx, ty:myPlayer.ty,
      dx:adx, dy:ady,
    });
  });

  socket.on('chat',(msg)=>{
    if (!myPlayer||!myRoom||!msg) return;
    io.to(myRoom.code).emit('chatMessage',{
      name:myPlayer.name,char:myPlayer.char,color:myPlayer.color,
      message:msg.slice(0,120),
    });
  });

  socket.on('disconnect',()=>{
    if (!myRoom) return;
    delete myRoom.players[socket.id];
    io.to(myRoom.code).emit('playerLeft',socket.id);
    if (myRoom.hostId===socket.id){
      io.to(myRoom.code).emit('roomClosed');
      destroyRoom(myRoom.code);
    } else if (Object.keys(myRoom.players).length===0){
      destroyRoom(myRoom.code);
    }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Tank Tactics grid on :${PORT}`));
