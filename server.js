const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // permite áudios curtos em base64 no chat
});

app.use(express.static(path.join(__dirname, 'public')));

// roomId -> Set de socketIds
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join-room', ({ roomId, name, camOn }) => {
    currentRoom = roomId;
    currentName = name || 'Anônimo';
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const peers = rooms.get(roomId);

    // Avisa aos peers já presentes que alguém novo chegou
    peers.forEach((peer, peerId) => {
      io.to(peerId).emit('peer-joined', { peerId: socket.id, name: currentName, camOn: !!camOn });
    });

    peers.set(socket.id, { name: currentName, camOn: !!camOn });

    // Manda ao novo peer a lista de quem já está na sala
    const existingPeers = Array.from(peers.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, peer]) => ({ peerId: id, name: peer.name, camOn: peer.camOn }));
    socket.emit('existing-peers', existingPeers);

    io.to(roomId).emit('chat-message', { system: true, message: `${currentName} entrou na sala.` });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media-state', ({ camOn }) => {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers && peers.has(socket.id)) peers.get(socket.id).camOn = camOn;
    io.to(currentRoom).emit('media-state', { peerId: socket.id, camOn });
  });

  socket.on('chat-message', ({ message, audio, mime }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit('chat-message', { name: currentName, message, audio, mime });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers) {
      peers.delete(socket.id);
      if (peers.size === 0) rooms.delete(currentRoom);
    }
    io.to(currentRoom).emit('peer-left', { peerId: socket.id });
    io.to(currentRoom).emit('chat-message', { system: true, message: `${currentName} saiu da sala.` });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
