import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const rootDir = process.cwd().endsWith('server') 
  ? path.join(process.cwd(), '../client') 
  : path.join(process.cwd(), 'client');

app.use(express.static(rootDir));

app.get('{*splat}', (req, res) => {
  const indexPath = path.join(rootDir, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send('No se encontró el archivo index.html en: ' + indexPath);
  }
});

interface Player {
  id: string;
  name: string;
  isBot: boolean;
}

interface RoomData {
  players: Player[];
  currentTurnIndex: number;
}

const rooms: Record<string, RoomData> = {};

io.on('connection', (socket) => {
  console.log('💡 Jugador conectado:', socket.id);

  socket.on('room:create', (data) => {
    try {
      const roomCode = Math.floor(1000 + Math.random() * 9000).toString();
      const hostName = data?.hostName || 'Jugador 1';
      
      rooms[roomCode] = {
        players: [{ id: socket.id, name: hostName, isBot: false }],
        currentTurnIndex: 0
      };

      socket.join(roomCode);
      socket.emit('room:created', { roomCode, playerId: socket.id });

      io.to(roomCode).emit('room:player_update', { 
        count: rooms[roomCode].players.length,
        players: rooms[roomCode].players
      });
    } catch (err) {
      console.error('❌ Error creando sala:', err);
    }
  });

  socket.on('room:join', (data) => {
    try {
      const { roomCode, playerName } = data;
      const room = rooms[roomCode];

      if (room && room.players.length < 4) {
        const name = playerName || `Jugador ${room.players.length + 1}`;
        room.players.push({ id: socket.id, name, isBot: false });
        socket.join(roomCode);

        socket.emit('room:joined', { roomCode, playerId: socket.id });

        io.to(roomCode).emit('room:player_update', {
          count: room.players.length,
          players: room.players
        });

        if (room.players.length === 4) {
          io.to(roomCode).emit('game:start');
          io.to(roomCode).emit('game:turn', { activePlayer: room.players[0].name });
        }
      } else {
        socket.emit('error:msg', { message: 'La sala está llena o no existe' });
      }
    } catch (err) {
      console.error('❌ Error al unirse:', err);
    }
  });

  socket.on('room:add_bot', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.players.length < 4) {
      const botNumber = room.players.filter(p => p.isBot).length + 1;
      const botName = `🤖 Bot ${botNumber}`;
      room.players.push({ id: `bot_${Date.now()}_${botNumber}`, name: botName, isBot: true });

      io.to(roomCode).emit('room:player_update', {
        count: room.players.length,
        players: room.players
      });

      if (room.players.length === 4) {
        io.to(roomCode).emit('game:start');
        io.to(roomCode).emit('game:turn', { activePlayer: room.players[0].name });
      }
    }
  });

  socket.on('game:action', ({ roomCode, targetId, row, col }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Rotar ruleta de turnos al siguiente jugador
    room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
    const nextPlayer = room.players[room.currentTurnIndex];

    io.to(roomCode).emit('game:turn', { activePlayer: nextPlayer.name });

    // Si le toca el turno a un Bot, simula disparo a los 1.5s
    if (nextPlayer.isBot) {
      setTimeout(() => {
        room.currentTurnIndex = (room.currentTurnIndex + 1) % room.players.length;
        const afterBotPlayer = room.players[room.currentTurnIndex];
        io.to(roomCode).emit('game:turn', { activePlayer: afterBotPlayer.name });
      }, 1500);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Jugador desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor con Nicknames, Ruleta y Seleccionador de Rivales escuchando en puerto ${PORT}`);
});