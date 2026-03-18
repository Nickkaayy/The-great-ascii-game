const socket = io();
const screen = document.getElementById('screen');
const startScreen = document.getElementById('startScreen');

let myId = null;
let players = {};
let cameraX = 0;
let cameraY = 0;
const VIEW_W = 80;
const VIEW_H = 40;

function joinGame() {
  const name = document.getElementById('nameInput').value.trim() || 'Wanderer';
  const char = document.getElementById('charInput').value.trim() || '@';

  startScreen.style.display = 'none';
  screen.style.display = 'block';

  socket.emit('setInfo', { name, char });
}

socket.on('joined', data => {
  myId = data.id;
  players = data.players;
  centerOnPlayer();
  render();
});

socket.on('newPlayer', p => {
  players[p.id] = p;
  render();
});

socket.on('playerUpdate', data => {
  if (players[data.id]) {
    players[data.id].name = data.name;
    players[data.id].char = data.char;
  }
  render();
});

socket.on('playerMoved', data => {
  if (players[data.id]) {
    players[data.id].x = data.x;
    players[data.id].y = data.y;
  }
  render();
});

socket.on('playerLeft', id => {
  delete players[id];
  render();
});

function centerOnPlayer() {
  if (players[myId]) {
    cameraX = players[myId].x - Math.floor(VIEW_W / 2);
    cameraY = players[myId].y - Math.floor(VIEW_H / 2);
  }
}

function render() {
  if (!myId || !players[myId]) return;

  let lines = [];

  for (let sy = 0; sy < VIEW_H; sy++) {
    let row = '';
    for (let sx = 0; sx < VIEW_W; sx++) {
      const wx = cameraX + sx;
      const wy = cameraY + sy;

      let tile = '.'; // fallback

      // You can call a server function later for real tile — for now fake simple procedural
      const n = Math.sin(wx * 0.04) * Math.cos(wy * 0.04) + Math.random() * 0.3;
      if (n > 0.55) tile = '#';
      else if (n > 0.38) tile = '.';
      else if (Math.random() < 0.008) tile = '*';

      let char = tile;
      let color = '#555';

      for (let id in players) {
        const p = players[id];
        if (p.x === wx && p.y === wy) {
          char = p.char;
          color = p.color || '#0f0';
          if (id === myId) color = '#ff0'; // highlight self
          break;
        }
      }

      row += `<span style="color:${color}">${char}</span>`;
    }
    lines.push(row);
  }

  screen.innerHTML = lines.join('\n');
}

// Input
document.addEventListener('keydown', e => {
  if (startScreen.style.display !== 'none') return;

  let moved = false;
  if (e.key === 'ArrowLeft')  { cameraX--; moved = true; }
  if (e.key === 'ArrowRight') { cameraX++; moved = true; }
  if (e.key === 'ArrowUp')    { cameraY--; moved = true; }
  if (e.key === 'ArrowDown')  { cameraY++; moved = true; }

  if (e.key === ' ') {
    centerOnPlayer();
    moved = true;
  }

  // Also send real player move to server when we decide to move self
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) {
    let dir;
    if (e.key === 'ArrowLeft') dir = 'left';
    if (e.key === 'ArrowRight') dir = 'right';
    if (e.key === 'ArrowUp') dir = 'up';
    if (e.key === 'ArrowDown') dir = 'down';
    socket.emit('move', dir);
  }

  if (moved) render();
});

// Initial render loop in case things update
setInterval(render, 300); // gentle refresh