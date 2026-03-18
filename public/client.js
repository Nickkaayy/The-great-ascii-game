const socket = io();
const screen = document.getElementById('screen');
const chatLog = document.getElementById('chatLog');
const playerListEl = document.getElementById('playerList');
const chatInput = document.getElementById('chatInput');
const startScreen = document.getElementById('startScreen');


// Assuming you have the character's X and Y coordinates on the screen
const chatBubble = document.getElementById('chat-bubble');

// Position it slightly to the right and above the character
// You may need to add/subtract offsets depending on your character's sprite size
chatBubble.style.left = (character.x + 30) + 'px'; 
chatBubble.style.top = (character.y - 40) + 'px';


let myId = null;
let players = {};
let cameraX = 0;
let cameraY = 0;
const VIEW_W = 80;
const VIEW_H = 40;
let baseMap = [];

let pressedKeys = new Set();


const MAP_WIDTH = 100;  // 100 tiles wide
const MAP_HEIGHT = 100; // 100 tiles tall
let gameMap = [];

function generateWorld() {
    gameMap = []; // Clear any existing map
    for (let y = 0; y < MAP_HEIGHT; y++) {
        let row = [];
        for (let x = 0; x < MAP_WIDTH; x++) {
            let rand = Math.random();
            let tileType = 0; // Default: 0 = Grass
            
            if (rand > 0.85) {
                tileType = 1; // 15% chance of a Tree
            } else if (rand > 0.95) {
                tileType = 2; // 5% chance of a Rock
            }
            
            row.push(tileType);
        }
        gameMap.push(row);
    }
    console.log("World generated!");
}

// Call this once when the game starts
generateWorld();


function joinGame() {
  const name = document.getElementById('nameInput').value.trim() || 'Wanderer';
  const char = document.getElementById('charInput').value.trim() || '@';

  startScreen.style.display = 'none';
  screen.style.display = 'block';
  chatInput.focus();

  socket.emit('setInfo', { name, char });
}

// Load fixed map.txt (tiles infinitely)
fetch('/map.txt')
  .then(r => r.text())
  .then(text => {
    baseMap = text.trim().split('\n').map(line => line.split(''));
  });

function getTile(wx, wy) {
  if (!baseMap.length) return '.';
  const h = baseMap.length;
  const w = baseMap[0].length || 1;
  const lx = ((wx % w) + w) % w;
  const ly = ((wy % h) + h) % h;
  return baseMap[ly][lx];
}

function centerOnPlayer() {
  if (players[myId]) {
    cameraX = players[myId].x - Math.floor(VIEW_W / 2);
    cameraY = players[myId].y - Math.floor(VIEW_H / 2);
  }
}

function render() {
  if (!myId) return;
  let lines = [];
  for (let sy = 0; sy < VIEW_H; sy++) {
    let row = '';
    for (let sx = 0; sx < VIEW_W; sx++) {
      const wx = cameraX + sx;
      const wy = cameraY + sy;
      let char = getTile(wx, wy);
      let color = '#555';

      for (let id in players) {
        const p = players[id];
        if (p.x === wx && p.y === wy) {
          char = p.char;
          color = (id === myId) ? '#ff0' : (p.color || '#0f0');
          break;
        }
      }
      row += `<span style="color:${color}">${char}</span>`;
    }
    lines.push(row);
  }
  screen.innerHTML = lines.join('\n');
}

function updatePlayerList() {
  const names = Object.values(players).map(p => p.name).sort();
  playerListEl.innerHTML = `<strong>Players (${names.length})</strong><br>` + names.join('<br>');
}

function addChatMessage(text) {
  const msg = document.createElement('div');
  msg.textContent = text;
  chatLog.appendChild(msg);
  setTimeout(() => {
    msg.style.opacity = '0';
    setTimeout(() => msg.remove(), 1000);
  }, 5000);
}

// ====================== SOCKETS ======================
socket.on('joined', data => {
  myId = data.id;
  players = data.players;
  render();
  updatePlayerList();
});

socket.on('newPlayer', p => {
  players[p.id] = p;
  render();
  updatePlayerList();
});

socket.on('playerUpdate', data => {
  if (players[data.id]) {
    players[data.id].name = data.name;
    players[data.id].char = data.char;
  }
  render();
  updatePlayerList();
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
  updatePlayerList();
});

socket.on('chatMessage', data => {
  addChatMessage(`${data.name}: ${data.message}`);
});

// ====================== INPUT ======================
document.addEventListener('keydown', e => {
  if (startScreen.style.display !== 'none') return;

  const key = e.key.toLowerCase();
  if (document.activeElement === chatInput) {
    if (e.key === 'Enter') {
      if (chatInput.value.trim()) {
        socket.emit('chat', chatInput.value.trim());
        chatInput.value = '';
      }
    }
    return;
  }

  pressedKeys.add(key);

  if (key === ' ') {
    centerOnPlayer();
    render();
  }
});

document.addEventListener('keyup', e => {
  pressedKeys.delete(e.key.toLowerCase());
});

// Smooth movement loop (60ms = very responsive)
setInterval(() => {
  let moved = false;
  if (pressedKeys.has('w')) { socket.emit('move', 'up'); moved = true; }
  if (pressedKeys.has('a')) { socket.emit('move', 'left'); moved = true; }
  if (pressedKeys.has('s')) { socket.emit('move', 'down'); moved = true; }
  if (pressedKeys.has('d')) { socket.emit('move', 'right'); moved = true; }

  if (moved) render();
}, 60);

// Chat input styling
chatInput.addEventListener('focus', () => pressedKeys.clear());