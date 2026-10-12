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

io.on('connection', (socket) => {
  console.log('💡 Jugador conectado:', socket.id);

  socket.on('room:create', ({ hostName }) => {
    const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    rooms[roomCode] = {
      players: [{ id: socket.id, name: hostName || 'Gustavo', isBot: false, energy: 3 }],
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
      room.players.push({ id: pId, name: playerName || `Jugador ${room.players.length + 1}`, isBot: false, energy: 3 });
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

      room.players.push({ id: botId, name: botName, isBot: true, energy: 3 });
      room.boardHistories[botId] = {};

      io.to(roomCode).emit('room:player_update', {
        count: room.players.length,
        players: room.players
      });

      if (room.players.length === 4) {
        room.gameStarted = true;
        io.to(roomCode).emit('game:start', {
          activePlayer: room.players[0]
        });
      }
    }
  });

  // Girar Ruleta en el Servidor
  socket.on('game:spin_roulette', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id) {
      return socket.emit('error:msg', { message: '¡No es tu turno de girar la ruleta!' });
    }

    if (room.rouletteSpun) return;

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

  // Ejecutar Acción/Disparo Sincronizado
  socket.on('game:action', ({ roomCode, targetId, row, col, type, isHit }) => {
    const room = rooms[roomCode];
    if (!room) return;

    const activePlayer = room.players[room.currentTurnIndex];
    if (activePlayer.id !== socket.id) {
      return socket.emit('error:msg', { message: '¡No es tu turno!' });
    }

    const key = `${row}_${col}`;
    const markState = isHit ? 'hit' : 'water';

    if (type === 'shield') room.boardHistories[socket.id][key] = 'shielded';
    else if (type === 'repair') delete room.boardHistories[socket.id][key];
    else room.boardHistories[targetId][key] = markState;

    // Sincronizar tablero para todos
    io.to(roomCode).emit('game:sync_board', {
      boardHistories: room.boardHistories,
      lastAction: { player: activePlayer.name, targetId, row, col, type, isHit }
    });

    // Pasar el turno al siguiente jugador
    avanzarTurno(roomCode);
  });

  function avanzarTurno(roomCode: string) {
    const room = rooms[roomCode];
    if (!room) return;

    room.rouletteSpun = false;
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    const nextPlayer = room.players[room.currentTurnIndex];

    io.to(roomCode).emit('game:turn_changed', {
      activePlayer: nextPlayer
    });

    // Si el turno le toca a un Bot, simula su tiro
    if (nextPlayer.isBot) {
      setTimeout(() => {
        const objetivos = room.players.filter(p => p.id !== nextPlayer.id);
        const target = objetivos[Math.floor(Math.random() * objetivos.length)];
        const r = Math.floor(Math.random() * 10);
        const c = Math.floor(Math.random() * 10);
        const key = `${r}_${c}`;
        const botHit = Math.random() < 0.5;

        room.boardHistories[target.id][key] = botHit ? 'hit' : 'water';

        io.to(roomCode).emit('game:sync_board', {
          boardHistories: room.boardHistories,
          lastAction: { player: nextPlayer.name, targetId: target.id, row: r, col: c, type: 'basic_shot', isHit: botHit }
        });

        avanzarTurno(roomCode);
      }, 1500);
    }
  }

  socket.on('disconnect', () => {
    console.log('❌ Jugador desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor Multijugador Sincronizado en Vivo listo en puerto ${PORT}`);
});