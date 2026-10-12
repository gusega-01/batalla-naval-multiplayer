import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { roomManager } from './roomManager';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Sirve los archivos estáticos del cliente ajustando 4 niveles hacia arriba
app.use(express.static(path.join(__dirname, '../../../../client')));

io.on('connection', (socket) => {
  console.log('💡 Jugador conectado:', socket.id);

  socket.on('room:create', (data) => {
    try {
      const hostName = data?.hostName || 'Gustavo';
      const { roomCode, roomState } = roomManager.createRoom(socket.id, hostName);

      socket.join(roomCode);
      console.log(`🏰 Partida iniciada en sala ${roomCode} por ${hostName}`);

      const view = roomManager.getPlayerView(roomCode, socket.id);
      socket.emit('room:created', { roomCode, view });
    } catch (err) {
      console.error('❌ Error creando sala:', err);
    }
  });

  socket.on('room:join', (data) => {
    try {
      const { roomCode, playerName } = data;
      const joined = (roomManager as any).joinRoom(roomCode, socket.id, playerName || 'Rival');

      if (joined) {
        socket.join(roomCode);
        console.log(`⚔️ Jugador ${socket.id} se unió a la sala ${roomCode}`);
        const view = roomManager.getPlayerView(roomCode, socket.id);
        socket.emit('room:joined', { roomCode, view });
        io.to(roomCode).emit('room:opponent_joined', { message: 'El rival se ha conectado.' });
      }
    } catch (err) {
      console.error('❌ Error al unirse a sala:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Jugador desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});