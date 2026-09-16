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

// Gera credenciais TURN sob demanda usando a conta Metered.ca do usuário.
// METERED_DOMAIN e METERED_API_KEY são configurados como variáveis de
// ambiente no Render — nunca ficam no código. Sem elas configuradas,
// devolve só STUN (funciona apenas quando os dois lados estão na mesma
// rede ou com NAT simples).
app.get('/api/turn-credentials', async (req, res) => {
  // .trim() protege contra espaço/quebra de linha extra que o painel do
  // Render às vezes deixa ao colar um valor de variável de ambiente.
  const domain = process.env.METERED_DOMAIN?.trim();
  const apiKey = process.env.METERED_API_KEY?.trim();

  if (!domain || !apiKey) {
    return res.json([{ urls: 'stun:stun.l.google.com:19302' }]);
  }

  try {
    const url = `https://${domain}/api/v1/turn/credentials?apiKey=${apiKey}`;
    const response = await fetch(url);
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (err) {
    console.error('Erro ao buscar credenciais TURN:', err.message, err.cause?.message || '');
    res.json([{ urls: 'stun:stun.l.google.com:19302' }]);
  }
});

// roomId -> Set de socketIds
const rooms = new Map();

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on('join-room', ({ roomId, name, camOn, micOn }) => {
    currentRoom = roomId;
    currentName = name || 'Anônimo';
    socket.join(roomId);

    if (!rooms.has(roomId)) rooms.set(roomId, new Map());
    const peers = rooms.get(roomId);

    const state = { name: currentName, camOn: !!camOn, micOn: micOn !== false };

    // Avisa aos peers já presentes que alguém novo chegou
    peers.forEach((peer, peerId) => {
      io.to(peerId).emit('peer-joined', { peerId: socket.id, ...state });
    });

    peers.set(socket.id, state);

    // Manda ao novo peer a lista de quem já está na sala
    const existingPeers = Array.from(peers.entries())
      .filter(([id]) => id !== socket.id)
      .map(([id, peer]) => ({ peerId: id, ...peer }));
    socket.emit('existing-peers', existingPeers);

    io.to(roomId).emit('chat-message', { system: true, message: `${currentName} entrou na sala.` });
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media-state', ({ camOn, micOn }) => {
    if (!currentRoom) return;
    const peers = rooms.get(currentRoom);
    if (peers && peers.has(socket.id)) {
      const peer = peers.get(socket.id);
      if (camOn !== undefined) peer.camOn = camOn;
      if (micOn !== undefined) peer.micOn = micOn;
    }
    io.to(currentRoom).emit('media-state', { peerId: socket.id, camOn, micOn });
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
