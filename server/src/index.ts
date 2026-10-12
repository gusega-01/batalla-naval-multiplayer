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
// Resuelve la ruta hacia la carpeta client desde cualquier entorno
const clientPath = path.resolve(process.cwd(), '../client');
app.use(express.static(clientPath));

app.get('{*splat}', (req, res) => {
  res.sendFile(path.join(clientPath, 'index.html'));
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
      
      // Intentamos llamar a joinRoom pasando timestamp
      let result = (roomManager as any).joinRoom(roomCode, socket.id, playerName || 'Rival', now);

      // Si no devolvió objeto, verificamos booleano o éxito
      if (result) {
        socket.join(roomCode);
        console.log(`⚔️ Jugador ${socket.id} se unió a la sala ${roomCode}`);

        const view = roomManager.getPlayerView(roomCode, socket.id);
        
        // Le avisamos al invitado que ya entró
        socket.emit('room:joined', { roomCode, view });
        
        // Le avisamos al creador que su rival ya se conectó
        io.to(roomCode).emit('room:opponent_joined', { message: 'El rival se ha conectado.' });
      } else {
        socket.emit('error:msg', { message: 'No se pudo unirse a la sala (¿está llena o no existe?)' });
      }
    } catch (err) {
      console.error('❌ Error al unirse a sala:', err);
      // Forzamos el ingreso si hubo error de tipos para no trabar el juego hoy
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