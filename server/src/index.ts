import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { roomManager } from './roomManager';

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '../../client')));

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

  socket.on('player:confirm_fleet', (data) => {
    try {
      const { roomCode, ships, grid } = data;
      roomManager.confirmPlayerFleet(roomCode, socket.id, ships, grid);
      
      const view = roomManager.getPlayerView(roomCode, socket.id);
      io.to(roomCode).emit('game:state', view);
    } catch (err) {
      console.error('❌ Error al confirmar flota:', err);
    }
  });

  socket.on('game:spin_roulette', (data) => {
    try {
      const { roomCode } = data;
      const result = roomManager.spinRoulette(roomCode, socket.id);
      if (result) {
        io.to(roomCode).emit('game:roulette_result', {
          targetId: result.targetId,
          targetName: result.targetName,
          isFreeChoice: result.isFreeChoice
        });
      }
    } catch (err) {
      console.error('❌ Error girando ruleta:', err);
    }
  });

  socket.on('game:action', async (data) => {
    try {
      const { roomCode, action } = data;
      console.log(`🎯 Procesando acción en sala ${roomCode}:`, action);

      const result = await roomManager.applyAction(roomCode, action, socket.id, io);
      if (result && result.ok) {
        const view = roomManager.getPlayerView(roomCode, socket.id);
        io.to(roomCode).emit('game:state', view || result.state);
      }
    } catch (err) {
      console.error('❌ Error procesando acción:', err);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Jugador desconectado:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en http://localhost:${PORT}`);
});