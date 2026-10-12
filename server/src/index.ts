import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rootDir = process.cwd().endsWith('server') 
  ? path.join(process.cwd(), '../client') 
  : path.join(process.cwd(), 'client');

app.use(express.static(rootDir));

app.get('{*splat}', (req, res) => {
  const indexPath = path.join(rootDir, 'index.html');
  if (fs.existsSync(indexPath)) res.sendFile(indexPath);
  else res.status(404).send('Archivo no encontrado');
});

interface Player {
  id: string;
  name: string;
  isBot: boolean;
  energy: number;
  grid: (string | null)[][];
  ready: boolean;
}

interface RoomData {
  players: Player[];
  currentTurnIndex: number;
  rouletteSpun: boolean;
  currentTargetId?: string;
  isFreeChoice?: boolean;
  gameStarted: boolean;
  boardHistories: Record<string, Record<string, string>>;
}

const rooms: Record<string, RoomData> = {};

function generarFlotaBot(): (string | null)[][] {
  const grid: (string | null)[][] = Array(10).fill(null).map(() => Array(10).fill(null));
  const ships = [
    { id: 'carrier', length: 4 },
    { id: 'battleship', length: 3 },
    { id: 'cruiser1', length: 3 },
    { id: 'destroyer', length: 2 },
    { id: 'patrol1', length: 1 },
    { id: 'patrol2', length: 1 }
  ];

  ships.forEach(s => {
    let placed = false;
    while (!placed) {
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const orient = Math.random() < 0.5;

      let canPlace = true;
      for (let i = 0; i < s.length; i++) {
        const currR = orient ? r : r + i;
        const currC = orient ? c + i : c;
        if (currR >= 10 || currC >= 10 || grid[currR][currC] !== null) {
          canPlace = false; break;
        }
      }

      if (canPlace) {
        for (let i = 0; i < s.length; i++) {
          const currR = orient ? r : r + i;
          const currC = orient ? c + i : c;
          grid[currR][currC] = s.id;
        }
        placed = true;
      }
    }
  });
  return grid;
}

io.on('connection', (socket) => {
  console.log('💡 Conectado:', socket.id);

  socket.on('room:create', ({ hostName }) => {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[roomCode] = {
      players: [{ id: socket.id, name: hostName || 'Gustavo', isBot: false, energy: 3, grid: [], ready: false }],
      currentTurnIndex: 0,
      rouletteSpun: false,
      gameStarted: false,
      boardHistories: { [socket.id]: {} }
    };

    socket.join(roomCode);
    socket.emit('room:created', { roomCode });
    io.to(roomCode).emit('room:player_update', {
      count: rooms[roomCode].players.length,
      players: rooms[roomCode].players
    });
  });

  socket.on('room:join', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (room && room.players.length < 4) {
      const pId = socket.id;
      room.players.push({ id: pId, name: playerName || `Jugador ${room.players.length + 1}`, isBot: false, energy: 3, grid: [], ready: false });
      room.boardHistories[pId] = {};

      socket.join(roomCode);
      socket.emit('room:joined', { roomCode });
      io.to(roomCode).emit('room:player_update', {
        count: room.players.length,
        players: room.players
      });
    } else {
      socket.emit('error:msg', { message: 'La sala está llena o no existe' });
    }
  });

  socket.on('room:add_bot', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.players.length < 4) {
      const botNumber = room.players.filter(p => p.isBot).length + 1;
      const botId = `bot_${Date.now()}_${botNumber}`;
      const botName = `🤖 Bot ${botNumber}`;

      room.players.push({ id: botId, name: botName, isBot: true, energy: 3, grid: generarFlotaBot(), ready: true });
      room.boardHistories[botId] = {};

      io.to(roomCode).emit('room:player_update', {
        count: room.players.length,
        players: room.players
      });

      if (room.players.length === 4) {
        io.to(roomCode).emit('room:start_placement');
      }
    }
  });

  socket.on('player:confirm_fleet', ({ roomCode, grid }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.grid = grid;
      player.ready = true;
    }

    // Si todos los humanos confirmaron barcos, arranca el juego
    const todosListos = room.players.every(p => p.ready);
    if (todosListos && !room.gameStarted) {
      room.gameStarted = true;
      io.to(roomCode).emit('game:start', { activePlayer: room.players[0] });
    }
  });

  socket.on('game:spin_roulette', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id || room.rouletteSpun) return;

    room.rouletteSpun = true;
    const targets = room.players.map(p => p.id);
    const chosenId = targets[Math.floor(Math.random() * targets.length)];

    if (chosenId === socket.id) {
      room.isFreeChoice = true;
      room.currentTargetId = undefined;
    } else {
      room.isFreeChoice = false;
      room.currentTargetId = chosenId;
    }

    const chosenPlayer = room.players.find(p => p.id === chosenId);

    io.to(roomCode).emit('game:roulette_result', {
      targetId: room.currentTargetId,
      isFreeChoice: room.isFreeChoice,
      targetName: chosenPlayer ? chosenPlayer.name : 'Tu Nombre',
      activePlayerId: activePlayer.id
    });
  });

  socket.on('game:action', ({ roomCode, targetId, row, col, type, cost }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id) return;

    activePlayer.energy = Math.max(0, activePlayer.energy - (cost || 0));

    if (type === 'shield') {
      room.boardHistories[socket.id][`${row}_${col}`] = 'shielded';
    } else if (type === 'repair') {
      delete room.boardHistories[socket.id][`${row}_${col}`];
    } else {
      const targetPlayer = room.players.find(p => p.id === targetId);
      if (targetPlayer) {
        const coordsAfectadas: { r: number, c: number }[] = [];

        if (type === 'basic_shot') coordsAfectadas.push({ r: row, c: col });
        else if (type === 'cross_shot') {
          coordsAfectadas.push({ r: row, c: col }, { r: row - 1, c: col }, { r: row + 1, c: col }, { r: row, c: col - 1 }, { r: row, c: col + 1 });
        } else if (type === 'rain') {
          for (let i = 0; i < 6; i++) {
            coordsAfectadas.push({ r: Math.floor(Math.random() * 10), c: Math.floor(Math.random() * 10) });
          }
        } else if (type === 'sonar') {
          for (let dr = 0; dr < 2; dr++) {
            for (let dc = 0; dc < 2; dc++) {
              if (row + dr < 10 && col + dc < 10) {
                const key = `${row + dr}_${col + dc}`;
                if (targetPlayer.grid[row + dr][col + dc] !== null) {
                  room.boardHistories[targetId][key] = 'sonar';
                }
              }
            }
          }
        }

        if (type !== 'sonar') {
          coordsAfectadas.forEach(({ r, c }) => {
            if (r >= 0 && r < 10 && c >= 0 && c < 10) {
              const key = `${r}_${c}`;
              if (targetPlayer.grid[r][c] !== null) {
                room.boardHistories[targetId][key] = 'hit';
                activePlayer.energy = Math.min(10, activePlayer.energy + 1);
              } else {
                if (!room.boardHistories[targetId][key]) {
                  room.boardHistories[targetId][key] = 'water';
                }
              }
            }
          });
        }
      }
    }

    io.to(roomCode).emit('game:sync_board', {
      boardHistories: room.boardHistories,
      activePlayerEnergy: activePlayer.energy,
      lastAction: { player: activePlayer.name, targetId, row, col, type }
    });

    avanzarTurno(roomCode);
  });

  function avanzarTurno(roomCode: string) {
    const room = rooms[roomCode];
    if (!room) return;

    room.rouletteSpun = false;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    const nextPlayer = room.players[room.currentTurnIndex];

    io.to(roomCode).emit('game:turn_changed', { activePlayer: nextPlayer });

    if (nextPlayer.isBot) {
      setTimeout(() => {
        const objetivos = room.players.filter(p => p.id !== nextPlayer.id);
        const target = objetivos[Math.floor(Math.random() * objetivos.length)];
        const r = Math.floor(Math.random() * 10);
        const c = Math.floor(Math.random() * 10);
        const key = `${r}_${c}`;

        const isHit = target.grid[r][c] !== null;
        room.boardHistories[target.id][key] = isHit ? 'hit' : 'water';

        io.to(roomCode).emit('game:sync_board', {
          boardHistories: room.boardHistories,
          lastAction: { player: nextPlayer.name, targetId: target.id, row: r, col: c, type: 'basic_shot' }
        });

        avanzarTurno(roomCode);
      }, 1500);
    }
  }

  socket.on('disconnect', () => { console.log('❌ Desconectado:', socket.id); });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));