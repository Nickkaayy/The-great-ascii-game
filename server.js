const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const players = {};

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  players[socket.id] = {
    id: socket.id,
    name: 'Wanderer',
    char: '@',
    x: 0,
    y: 0,
    color: '#00ff88'
  };

  socket.emit('joined', {
    id: socket.id,
    players: Object.fromEntries(
      Object.entries(players).map(([id, p]) => [id, { ...p }])
    )
  });

  socket.broadcast.emit('newPlayer', players[socket.id]);

  socket.on('setInfo', (data) => {
    if (!players[socket.id]) return;
    if (data.name && data.name.length > 0 && data.name.length < 16)
      players[socket.id].name = data.name;
    if (data.char && data.char.length === 1)
      players[socket.id].char = data.char;
    if (data.color) players[socket.id].color = data.color;
    io.emit('playerUpdate', { id: socket.id, ...players[socket.id] });
  });

  socket.on('move', (dir) => {
    const p = players[socket.id];
    if (!p) return;
    if (dir === 'left')  p.x--;
    if (dir === 'right') p.x++;
    if (dir === 'up')    p.y--;
    if (dir === 'down')  p.y++;
    io.emit('playerMoved', { id: socket.id, x: p.x, y: p.y });
  });

  socket.on('chat', (message) => {
    if (!players[socket.id] || !message) return;
    io.emit('chatMessage', { name: players[socket.id].name, message: message.slice(0, 120) });
  });

  socket.on('disconnect', () => {
    io.emit('playerLeft', socket.id);
    delete players[socket.id];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
