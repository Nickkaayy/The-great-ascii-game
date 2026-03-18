const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const CHUNK_SIZE = 40;
const VIEW_WIDTH = 80;   // visible columns
const VIEW_HEIGHT = 40;  // visible rows

const players = {};      // socket.id → player data
const changedTiles = new Map();  // "wx,wy" → char (for player-placed / modified tiles later)

app.use(express.static('public'));

function getChunk(cx, cy) {
  const chunk = Array(CHUNK_SIZE).fill().map(() => Array(CHUNK_SIZE).fill(' '));

  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const wx = cx * CHUNK_SIZE + lx;
      const wy = cy * CHUNK_SIZE + ly;

      // Simple procedural "space/wasteland" — feel free to improve later
      const n = Math.sin(wx * 0.04) * Math.cos(wy * 0.04) + Math.random() * 0.3;
      if (n > 0.55) chunk[ly][lx] = '#';      // rocks / mountains
      else if (n > 0.38) chunk[ly][lx] = '.'; // dirt / ground
      else if (Math.random() < 0.008) chunk[ly][lx] = '*'; // rare star / sparkle
    }
  }
  return chunk;
}

function getTile(wx, wy) {
  const key = `${wx},${wy}`;
  if (changedTiles.has(key)) return changedTiles.get(key);

  const cx = Math.floor(wx / CHUNK_SIZE);
  const cy = Math.floor(wy / CHUNK_SIZE);
  const chunk = getChunk(cx, cy);
  const lx = wx - cx * CHUNK_SIZE;
  const ly = wy - cy * CHUNK_SIZE;
  return chunk[ly][lx];
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // Create player
  players[socket.id] = {
    id: socket.id,
    name: 'Wanderer',
    char: '@',
    x: 0,           // world coords — can be huge negative/positive
    y: 0,
    color: '#0f0'
  };

  // Send join info to this player
  socket.emit('joined', {
    id: socket.id,
    players: Object.fromEntries(
      Object.entries(players).map(([id, p]) => [id, { name: p.name, char: p.char, x: p.x, y: p.y, color: p.color }])
    )
  });

  // Tell everyone else about new player
  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('setInfo', (data) => {
    if (players[socket.id]) {
      if (data.name && data.name.length > 0 && data.name.length < 16) {
        players[socket.id].name = data.name;
      }
      if (data.char && data.char.length === 1) {
        players[socket.id].char = data.char;
      }
      io.emit('playerUpdate', {
        id: socket.id,
        name: players[socket.id].name,
        char: players[socket.id].char
      });
    }
  });

  socket.on('move', (dir) => {
    const p = players[socket.id];
    if (!p) return;

    let nx = p.x, ny = p.y;
    if (dir === 'left')  nx--;
    if (dir === 'right') nx++;
    if (dir === 'up')    ny--;
    if (dir === 'down')  ny++;

    // No walls for now — fully open world
    p.x = nx;
    p.y = ny;

    io.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    io.emit('playerLeft', socket.id);
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});