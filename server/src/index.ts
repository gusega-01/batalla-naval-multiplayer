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
      socket.emit('room:created', { roomCode });

      io.to(roomCode).emit('room:player_update', { 
        count: rooms[roomCode].players.length,
        players: rooms[roomCode].players
      });
    } catch (err) {
      console.error('❌ Error:', err);
    }
  });

  socket.on('room:join', (data) => {
    try {
      const { roomCode, playerName } = data;
      const room = rooms[roomCode];

      if (room && room.players.length < 4) {
        room.players.push({ id: socket.id, name: playerName || `Jugador ${room.players.length + 1}`, isBot: false });
        socket.join(roomCode);

        socket.emit('room:joined', { roomCode });
        io.to(roomCode).emit('room:player_update', {
          count: room.players.length,
          players: room.players
        });
      } else {
        socket.emit('error:msg', { message: 'Sala llena o no existe' });
      }
    } catch (err) {
      console.error('❌ Error:', err);
    }
  });

  socket.on('room:add_bot', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.players.length < 4) {
      const botNumber = room.players.filter(p => p.isBot).length + 1;
      room.players.push({ id: `bot_${Date.now()}_${botNumber}`, name: `🤖 Bot ${botNumber}`, isBot: true });

      io.to(roomCode).emit('room:player_update', {
        count: room.players.length,
        players: room.players
      });
    }
  });

  // RULETA DE OBJETIVO
  socket.on('game:spin_roulette', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room) return;

    // Saca un objetivo de los 4 posibles (incluyendo bots o a sí mismo)
    const targetIdx = Math.floor(Math.random() * room.players.length);
    const target = room.players[targetIdx];

    io.to(roomCode).emit('game:roulette_result', {
      message: `🎯 La ruleta cayó en: ${target.name}. ¡Todos los disparos van hacia él!`,
      targetId: target.id,
      targetName: target.name
    });
  });

  socket.on('game:action', ({ roomCode, targetId, row, col, type }) => {
    console.log(`Acción ${type} de jugador en sala ${roomCode}`);
  });

  socket.on('disconnect', () => {
    console.log('❌ Desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor de Batalla Naval Táctica en puerto ${PORT}`);
});