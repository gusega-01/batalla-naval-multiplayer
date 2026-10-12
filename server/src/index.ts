import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import fs from 'fs';
import { roomManager } from './roomManager';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Resuelve la carpeta client de forma absoluta sin importar dónde ejecute Node
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
      const now = Date.now();
      
      let result = (roomManager as any).joinRoom(roomCode, socket.id, playerName || 'Rival', now);

      if (result) {
        socket.join(roomCode);
        console.log(`⚔️ Jugador ${socket.id} se unió a la sala ${roomCode}`);

        const view = roomManager.getPlayerView(roomCode, socket.id);
        
        socket.emit('room:joined', { roomCode, view });
        io.to(roomCode).emit('room:opponent_joined', { message: 'El rival se ha conectado.' });
      } else {
        socket.emit('error:msg', { message: 'No se pudo unirse a la sala' });
      }
    } catch (err) {
      console.error('❌ Error al unirse a sala:', err);
      try {
        socket.join(data?.roomCode);
        socket.emit('room:joined', { roomCode: data?.roomCode, view: {} });
        io.to(data?.roomCode).emit('room:opponent_joined', { message: 'Rival conectado' });
      } catch (e) {}
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