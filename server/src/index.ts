import express, { Request, Response } from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

function resolverClientPath(): string {
  const posiblesRutas = [
    path.join(__dirname, '../../client'),
    path.join(__dirname, '../../../client'),
    path.join(process.cwd(), 'client'),
    path.join(process.cwd(), '../client')
  ];

  for (const ruta of posiblesRutas) {
    if (fs.existsSync(path.join(ruta, 'index.html'))) {
      return ruta;
    }
  }
  return path.join(process.cwd(), 'client');
}

const clientPath = resolverClientPath();
app.use(express.static(clientPath));

interface ShipInfo {
  id: string;
  length: number;
  coords: { r: number; c: number }[];
}

interface Player {
  id: string;
  name: string;
  isBot: boolean;
  energy: number;
  grid: (string | null)[][];
  ships: ShipInfo[];
  ready: boolean;
  isEliminated: boolean;
  disconnectedTimeout?: NodeJS.Timeout;
}

interface RoomData {
  players: Player[];
  currentTurnIndex: number;
  rouletteSpun: boolean;
  currentTargetId?: string;
  isFreeChoice?: boolean;
  gameStarted: boolean;
  gameOver: boolean;
  boardHistories: Record<string, Record<string, string>>;
}

const rooms: Record<string, RoomData> = {};

const shipConfigs = [
  { id: 'carrier', length: 4 },
  { id: 'battleship1', length: 3 },
  { id: 'battleship2', length: 3 },
  { id: 'cruiser1', length: 2 },
  { id: 'cruiser2', length: 2 },
  { id: 'patrol1', length: 1 },
  { id: 'patrol2', length: 1 },
  { id: 'patrol3', length: 1 }
];

function generarFlotaBot(): { grid: (string | null)[][], ships: ShipInfo[] } {
  const grid: (string | null)[][] = Array(10).fill(null).map(() => Array(10).fill(null));
  const ships: ShipInfo[] = [];

  shipConfigs.forEach(s => {
    let placed = false;
    while (!placed) {
      const r = Math.floor(Math.random() * 10);
      const c = Math.floor(Math.random() * 10);
      const orient = Math.random() < 0.5;

      let canPlace = true;
      const coords: { r: number, c: number }[] = [];
      for (let i = 0; i < s.length; i++) {
        const currR = orient ? r : r + i;
        const currC = orient ? c + i : c;
        if (currR >= 10 || currC >= 10 || grid[currR][currC] !== null) {
          canPlace = false; break;
        }
        coords.push({ r: currR, c: currC });
      }

      if (canPlace) {
        coords.forEach(coord => { grid[coord.r][coord.c] = s.id; });
        ships.push({ id: s.id, length: s.length, coords });
        placed = true;
      }
    }
  });
  return { grid, ships };
}

function verificarYMarcarHundidos(player: Player, boardHistory: Record<string, string>) {
  if (!player.ships) return;
  player.ships.forEach(ship => {
    const todoGolpeado = ship.coords.every(c => {
      const key = `${c.r}_${c.c}`;
      return boardHistory[key] === 'hit' || boardHistory[key] === 'sunk';
    });

    if (todoGolpeado) {
      ship.coords.forEach(c => {
        boardHistory[`${c.r}_${c.c}`] = 'sunk';
      });
    }
  });

  const tieneBarcosVivos = player.ships.some(ship => {
    return ship.coords.some(c => {
      const key = `${c.r}_${c.c}`;
      return boardHistory[key] !== 'hit' && boardHistory[key] !== 'sunk';
    });
  });

  if (!tieneBarcosVivos) {
    player.isEliminated = true;
  }
}

function chequearGanador(roomCode: string) {
  const room = rooms[roomCode];
  if (!room || room.gameOver) return;

  const jugadoresVivos = room.players.filter(p => !p.isEliminated);
  if (jugadoresVivos.length === 1 && room.gameStarted) {
    room.gameOver = true;
    const ganador = jugadoresVivos[0];
    io.to(roomCode).emit('game:over', { winnerName: ganador.name, winnerId: ganador.id });
  }
}

io.on('connection', (socket) => {
  socket.on('room:create', ({ hostName }) => {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[roomCode] = {
      players: [{ id: socket.id, name: hostName || 'Gustavo', isBot: false, energy: 3, grid: [], ships: [], ready: false, isEliminated: false }],
      currentTurnIndex: 0,
      rouletteSpun: false,
      gameStarted: false,
      gameOver: false,
      boardHistories: { [socket.id]: {} }
    
    };

// Evento para retransmitir las burlas de voz dirigidas con género y modo
socket.on('taunt:send', ({ text, targetId, gender, mode }) => {
  const cleanText = String(text || '').slice(0, 40).trim();
  if (!cleanText) return;

  const payload = {
    senderId: socket.id,
    text: cleanText,
    gender: gender || 'male',
    mode: mode || 'es'
  };

  if (targetId) {
    io.to(targetId).emit('taunt:receive', payload);
  } else {
    socket.broadcast.emit('taunt:receive', payload);
  }
});

    socket.join(roomCode);
    socket.emit('room:created', { roomCode });
    io.to(roomCode).emit('room:player_update', {
      count: rooms[roomCode].players.length,
      players: rooms[roomCode].players
    });
  });

  socket.on('room:join', ({ roomCode, playerName }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('error:msg', { message: 'La sala no existe' });

    const pExistente = room.players.find(p => p.name === playerName);
    if (pExistente && pExistente.disconnectedTimeout) {
      clearTimeout(pExistente.disconnectedTimeout);
      pExistente.disconnectedTimeout = undefined;
      pExistente.isBot = false;
      const oldId = pExistente.id;
      pExistente.id = socket.id;

      room.boardHistories[socket.id] = room.boardHistories[oldId] || {};
      delete room.boardHistories[oldId];

      socket.join(roomCode);
      socket.emit('room:joined', { roomCode });
      io.to(roomCode).emit('room:player_update', { count: room.players.length, players: room.players });

      if (room.gameStarted) {
        socket.emit('game:start', { activePlayer: room.players[room.currentTurnIndex] });
      }
      return;
    }

    if (room.players.length < 4) {
      const pId = socket.id;
      room.players.push({ id: pId, name: playerName || `Jugador ${room.players.length + 1}`, isBot: false, energy: 3, grid: [], ships: [], ready: false, isEliminated: false });
      room.boardHistories[pId] = {};

      socket.join(roomCode);
      socket.emit('room:joined', { roomCode });
      io.to(roomCode).emit('room:player_update', {
        count: room.players.length,
        players: room.players
      });
    } else {
      socket.emit('error:msg', { message: 'La sala está llena' });
    }
  });

  socket.on('room:add_bot', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.players.length < 4) {
      const botNumber = room.players.filter(p => p.isBot).length + 1;
      const botId = `bot_${Date.now()}_${botNumber}`;
      const botName = `🤖 Bot ${botNumber}`;
      const botData = generarFlotaBot();

      room.players.push({ id: botId, name: botName, isBot: true, energy: 3, grid: botData.grid, ships: botData.ships, ready: true, isEliminated: false });
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

  socket.on('player:confirm_fleet', ({ roomCode, grid, ships }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) {
      player.grid = grid;
      player.ships = ships || [];
      player.ready = true;
    }

    const todosListos = room.players.every(p => p.ready);
    if (todosListos && !room.gameStarted) {
      room.gameStarted = true;
      io.to(roomCode).emit('game:start', { activePlayer: room.players[0] });
    }
  });

  socket.on('game:spin_roulette', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.gameOver) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id || room.rouletteSpun) return;

    room.rouletteSpun = true;
    const targets = room.players.filter(p => !p.isEliminated).map(p => p.id);
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

  socket.on('game:action', ({ roomCode, targetId, row, col, type, cost, moveData }) => {
    const room = rooms[roomCode];
    if (!room || room.gameOver) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id) return;

    activePlayer.energy = Math.max(0, activePlayer.energy - (cost || 0));

    if (!room.boardHistories[targetId]) {
      room.boardHistories[targetId] = {};
    }

    if (type === 'move_ship' && moveData) {
      const { shipId, newR, newC } = moveData;
      const shipObj = activePlayer.ships.find(s => s.id === shipId);
      if (shipObj) {
        shipObj.coords.forEach(c => { activePlayer.grid[c.r][c.c] = null; });
        const isHoriz = shipObj.coords.length > 1 ? shipObj.coords[0].r === shipObj.coords[1].r : true;
        const newCoords: { r: number, c: number }[] = [];
        for (let i = 0; i < shipObj.length; i++) {
          const currR = isHoriz ? newR : newR + i;
          const currC = isHoriz ? newC + i : newC;
          if (currR < 10 && currC < 10) {
            activePlayer.grid[currR][currC] = shipId;
            newCoords.push({ r: currR, c: currC });
          }
        }
        shipObj.coords = newCoords;
      }
    } else if (type === 'shield') {
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
          /* LLUVIA DE 8 MISILES INTELIGENTE */
          const unvisited: { r: number, c: number }[] = [];
          for (let rIdx = 0; rIdx < 10; rIdx++) {
            for (let cIdx = 0; cIdx < 10; cIdx++) {
              const k = `${rIdx}_${cIdx}`;
              if (!room.boardHistories[targetId][k]) {
                unvisited.push({ r: rIdx, c: cIdx });
              }
            }
          }

          // Mezclar casillas sin visitar
          for (let i = unvisited.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [unvisited[i], unvisited[j]] = [unvisited[j], unvisited[i]];
          }

          const elegidas = unvisited.slice(0, 8);
          coordsAfectadas.push(...elegidas);

          // Si hay menos de 8 disponibles, rellenar con aleatorias
          while (coordsAfectadas.length < 8) {
            coordsAfectadas.push({
              r: Math.floor(Math.random() * 10),
              c: Math.floor(Math.random() * 10)
            });
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
              if (room.boardHistories[targetId][key] === 'shielded') {
                delete room.boardHistories[targetId][key];
              } else if (targetPlayer.grid[r][c] !== null) {
                room.boardHistories[targetId][key] = 'hit';
                activePlayer.energy = Math.min(10, activePlayer.energy + 1);
              } else {
                if (!room.boardHistories[targetId][key]) {
                  room.boardHistories[targetId][key] = 'water';
                }
              }
            }
          });

          verificarYMarcarHundidos(targetPlayer, room.boardHistories[targetId]);
        }
      }
    }

    io.to(roomCode).emit('game:sync_board', {
      boardHistories: room.boardHistories,
      activePlayerEnergy: activePlayer.energy,
      lastAction: { player: activePlayer.name, targetId, row, col, type }
    });

    chequearGanador(roomCode);
    if (!room.gameOver) avanzarTurno(roomCode);
  });

  function avanzarTurno(roomCode: string) {
    const room = rooms[roomCode];
    if (!room || room.gameOver) return;

    room.rouletteSpun = false;

    let intentos = 0;
    do {
      room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
      intentos++;
    } while (room.players[room.currentTurnIndex].isEliminated && intentos < room.players.length);

    const nextPlayer = room.players[room.currentTurnIndex];

    io.to(roomCode).emit('game:turn_changed', { activePlayer: nextPlayer });

    if (nextPlayer.isBot || nextPlayer.disconnectedTimeout) {
      setTimeout(() => {
        const objetivos = room.players.filter(p => p.id !== nextPlayer.id && !p.isEliminated);
        if (objetivos.length === 0) return;

        const target = objetivos[Math.floor(Math.random() * objetivos.length)];
        const r = Math.floor(Math.random() * 10);
        const c = Math.floor(Math.random() * 10);
        const key = `${r}_${c}`;

        if (room.boardHistories[target.id][key] === 'shielded') {
          delete room.boardHistories[target.id][key];
        } else {
          const isHit = target.grid[r][c] !== null;
          room.boardHistories[target.id][key] = isHit ? 'hit' : 'water';
          verificarYMarcarHundidos(target, room.boardHistories[target.id]);
        }

        io.to(roomCode).emit('game:sync_board', {
          boardHistories: room.boardHistories,
          lastAction: { player: nextPlayer.name, targetId: target.id, row: r, col: c, type: 'basic_shot' }
        });

        chequearGanador(roomCode);
        if (!room.gameOver) avanzarTurno(roomCode);
      }, 2000);
    }
  }

  socket.on('disconnect', () => {
    for (const roomCode in rooms) {
      const room = rooms[roomCode];
      const player = room.players.find(p => p.id === socket.id);
      if (player && !player.isBot) {
        player.disconnectedTimeout = setTimeout(() => {
          player.isBot = true;
        }, 60000);
      }
    }
  });
});

app.use((req: Request, res: Response) => {
  const file = path.join(clientPath, 'index.html');
  if (fs.existsSync(file)) {
    res.sendFile(file);
  } else {
    res.status(404).send('Archivo index.html no encontrado');
  }
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));