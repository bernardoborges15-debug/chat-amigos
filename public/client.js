const socket = io();

const iceServers = [
  { urls: 'stun:stun.l.google.com:19302' },
  // Adicione um TURN aqui quando for testar fora da rede local:
  // { urls: 'turn:SEU_TURN:3478', username: 'user', credential: 'pass' },
];

let localStream = null;
let rawCameraStream = null; // stream original da webcam, antes da correção de espelhamento
let cameraTrack = null; // guardamos para poder voltar da tela pra câmera
let camOn = false; // câmera começa desligada por padrão
const peers = new Map(); // peerId -> { pc, name }
let myName = '';
let roomId = '';

const joinScreen = document.getElementById('join-screen');
const callScreen = document.getElementById('call-screen');
const videosGrid = document.getElementById('videos-grid');
const chatMessages = document.getElementById('chat-messages');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');
const micBtn = document.getElementById('mic-btn');
const camBtn = document.getElementById('cam-btn');
const screenBtn = document.getElementById('screen-btn');
const leaveBtn = document.getElementById('leave-btn');
const userAvatar = document.getElementById('user-avatar');
const userNameLabel = document.getElementById('user-name-label');
const roomNameLabel = document.getElementById('room-name-label');
const voiceMembers = document.getElementById('voice-members');
const headerTitle = document.getElementById('header-title');
const chatToggleBtn = document.getElementById('chat-toggle-btn');
const chatPanel = document.getElementById('chat-panel');
const channelText = document.getElementById('channel-text');
const channelVoice = document.getElementById('channel-voice');

let currentView = 'text';
let voiceChatOpen = false;

channelText.addEventListener('click', () => showView('text'));
channelVoice.addEventListener('click', () => showView('voice'));
chatToggleBtn.addEventListener('click', () => {
  voiceChatOpen = !voiceChatOpen;
  chatPanel.classList.toggle('collapsed', !voiceChatOpen);
  chatToggleBtn.classList.toggle('active', voiceChatOpen);
});

function showView(view) {
  currentView = view;
  const isVoice = view === 'voice';

  videosGrid.classList.toggle('hidden', !isVoice);
  chatToggleBtn.classList.toggle('hidden', !isVoice);
  channelText.classList.toggle('active', !isVoice);
  channelVoice.classList.toggle('active', isVoice);

  if (isVoice) {
    chatPanel.classList.remove('mode-full');
    chatPanel.classList.add('mode-sidebar');
    chatPanel.classList.toggle('collapsed', !voiceChatOpen);
    chatToggleBtn.classList.toggle('active', voiceChatOpen);
    headerTitle.innerHTML = `<span class="hash">🔊</span> Sala de voz`;
  } else {
    chatPanel.classList.add('mode-full');
    chatPanel.classList.remove('mode-sidebar', 'collapsed');
    headerTitle.innerHTML = `<span class="hash">#</span> geral`;
  }
}

document.getElementById('join-btn').addEventListener('click', joinRoom);

async function joinRoom() {
  myName = document.getElementById('name-input').value.trim() || 'Anônimo';
  roomId = document.getElementById('room-input').value.trim() || 'sala-padrao';

  try {
    rawCameraStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (err) {
    alert('Não foi possível acessar câmera/microfone: ' + err.message);
    return;
  }

  // A webcam entrega o quadro já espelhado (comum em câmeras de notebook).
  // Corrigimos isso aqui, ANTES de enviar, para que a imagem saia correta
  // tanto na sua prévia quanto no vídeo que os amigos recebem.
  localStream = unmirrorVideo(rawCameraStream);
  cameraTrack = localStream.getVideoTracks()[0];

  // Câmera começa desligada; o usuário liga quando quiser.
  cameraTrack.enabled = false;

  addVideoTile('local', myName + ' (você)', localStream, true, false);
  addVoiceMember('local', myName);
  camBtn.classList.add('active');

  userAvatar.textContent = myName[0].toUpperCase();
  userNameLabel.textContent = myName;
  roomNameLabel.textContent = roomId;

  joinScreen.classList.add('hidden');
  callScreen.classList.remove('hidden');

  socket.emit('join-room', { roomId, name: myName, camOn: false });
}

// Recebe o stream bruto da webcam e devolve um novo stream com o vídeo
// desespelhado (redesenhado num canvas), mantendo o áudio original.
function unmirrorVideo(rawStream) {
  const videoTrack = rawStream.getVideoTracks()[0];
  const { width = 640, height = 480 } = videoTrack.getSettings();

  const hiddenVideo = document.createElement('video');
  hiddenVideo.srcObject = rawStream;
  hiddenVideo.muted = true;
  hiddenVideo.playsInline = true;
  hiddenVideo.play();

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  function drawFrame() {
    ctx.save();
    ctx.translate(canvas.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(hiddenVideo, 0, 0, canvas.width, canvas.height);
    ctx.restore();
    requestAnimationFrame(drawFrame);
  }
  drawFrame();

  const canvasStream = canvas.captureStream(30);
  const fixedVideoTrack = canvasStream.getVideoTracks()[0];
  const audioTrack = rawStream.getAudioTracks()[0];

  return new MediaStream([fixedVideoTrack, audioTrack]);
}

// --- Sinalização ---

socket.on('existing-peers', (existingPeers) => {
  existingPeers.forEach(({ peerId, name, camOn }) => {
    createPeerConnection(peerId, name, true, camOn);
    addVoiceMember(peerId, name);
  });
});

socket.on('peer-joined', ({ peerId, name, camOn }) => {
  createPeerConnection(peerId, name, false, camOn);
  addVoiceMember(peerId, name);
});

socket.on('media-state', ({ peerId, camOn }) => {
  const tile = document.getElementById('tile-' + peerId);
  if (tile) tile.classList.toggle('cam-off', !camOn);
});

socket.on('signal', async ({ from, data }) => {
  const entry = peers.get(from);
  if (!entry) return;
  const { pc } = entry;

  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (e) {
      console.warn('Erro ao adicionar ICE candidate', e);
    }
  }
});

socket.on('peer-left', ({ peerId }) => {
  const entry = peers.get(peerId);
  if (entry) {
    entry.pc.close();
    peers.delete(peerId);
  }
  removeVideoTile(peerId);
  removeVoiceMember(peerId);
});

function createPeerConnection(peerId, name, isInitiator, peerCamOn) {
  const pc = new RTCPeerConnection({ iceServers });
  peers.set(peerId, { pc, name });

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('signal', { to: peerId, data: { candidate: e.candidate } });
    }
  };

  pc.ontrack = (e) => {
    addVideoTile(peerId, name, e.streams[0], false, peerCamOn);
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
    };
  }

  return pc;
}

// --- Vídeo UI ---

function addVideoTile(id, label, stream, isLocal, tileCamOn) {
  let tile = document.getElementById('tile-' + id);
  if (!tile) {
    tile = document.createElement('div');
    tile.className = 'video-tile';
    tile.id = 'tile-' + id;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    if (isLocal) video.muted = true;

    const avatar = document.createElement('div');
    avatar.className = 'avatar-placeholder';
    avatar.textContent = label[0].toUpperCase();

    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    labelEl.textContent = label;

    tile.appendChild(video);
    tile.appendChild(avatar);
    tile.appendChild(labelEl);
    videosGrid.appendChild(tile);
  }
  tile.classList.toggle('cam-off', !tileCamOn);
  const video = tile.querySelector('video');
  video.srcObject = stream;
}

function removeVideoTile(id) {
  const tile = document.getElementById('tile-' + id);
  if (tile) tile.remove();
}

// --- Lista de membros na sala de voz (sidebar) ---

function addVoiceMember(id, name) {
  if (document.getElementById('voice-member-' + id)) return;
  const row = document.createElement('div');
  row.className = 'voice-member';
  row.id = 'voice-member-' + id;
  row.innerHTML = `<span class="mini-avatar">${escapeHtml(name[0].toUpperCase())}</span><span>${escapeHtml(name)}</span>`;
  voiceMembers.appendChild(row);
}

function removeVoiceMember(id) {
  const row = document.getElementById('voice-member-' + id);
  if (row) row.remove();
}

// --- Chat ---

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  socket.emit('chat-message', { message });
  chatInput.value = '';
});

socket.on('chat-message', ({ name, message, system, audio, mime }) => {
  const div = document.createElement('div');

  if (system) {
    div.className = 'msg system';
    div.textContent = message;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    return;
  }

  const time = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  div.className = 'msg';
  div.innerHTML = `
    <div class="mini-avatar">${escapeHtml(name[0].toUpperCase())}</div>
    <div class="msg-body">
      <span class="who">${escapeHtml(name)}</span><span style="color:var(--text-muted);font-size:11px">${time}</span>
      <div class="msg-text"></div>
    </div>
  `;

  const textEl = div.querySelector('.msg-text');
  if (audio) {
    textEl.textContent = '🎙️ mensagem de voz';
    const audioEl = document.createElement('audio');
    audioEl.controls = true;
    audioEl.src = `data:${mime};base64,${audio}`;
    textEl.appendChild(audioEl);
  } else {
    textEl.textContent = message;
  }

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Emoji picker ---

const EMOJIS = ['😀','😂','😍','😎','🤔','😢','😡','👍','👎','🙏','🎉','🔥','❤️','😅','😭','🥳','👀','🙌','💀','✨'];

const emojiBtn = document.getElementById('emoji-btn');
const emojiPanel = document.getElementById('emoji-panel');

EMOJIS.forEach(emoji => {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = emoji;
  btn.addEventListener('click', () => {
    chatInput.value += emoji;
    chatInput.focus();
  });
  emojiPanel.appendChild(btn);
});

emojiBtn.addEventListener('click', () => {
  emojiPanel.classList.toggle('hidden');
});

// --- Gravação de áudio (mensagem de voz) ---

const audioBtn = document.getElementById('audio-btn');
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;

audioBtn.addEventListener('click', async () => {
  if (!isRecording) {
    let micStream;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      alert('Não foi possível acessar o microfone: ' + err.message);
      return;
    }
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(micStream);
    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = () => {
      micStream.getTracks().forEach(t => t.stop());
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      sendAudioMessage(blob);
    };
    mediaRecorder.start();
    isRecording = true;
    audioBtn.classList.add('recording');
  } else {
    mediaRecorder.stop();
    isRecording = false;
    audioBtn.classList.remove('recording');
  }
});

function sendAudioMessage(blob) {
  const reader = new FileReader();
  reader.onloadend = () => {
    const base64 = reader.result.split(',')[1];
    socket.emit('chat-message', { audio: base64, mime: blob.type });
  };
  reader.readAsDataURL(blob);
}

// --- Controles: mic, câmera, tela ---

micBtn.addEventListener('click', () => {
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  micBtn.classList.toggle('active', !track.enabled);
});

camBtn.addEventListener('click', () => {
  camOn = !camOn;
  cameraTrack.enabled = camOn;
  camBtn.classList.toggle('active', !camOn);

  const localTile = document.getElementById('tile-local');
  if (localTile) localTile.classList.toggle('cam-off', !camOn);

  socket.emit('media-state', { camOn });
});

let sharingScreen = false;

screenBtn.addEventListener('click', async () => {
  if (!sharingScreen) {
    let screenStream;
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    } catch (err) {
      return; // usuário cancelou
    }
    const screenTrack = screenStream.getVideoTracks()[0];
    replaceVideoTrackForAllPeers(screenTrack);
    document.querySelector('#tile-local video').srcObject = screenStream;
    document.getElementById('tile-local').classList.remove('cam-off');
    socket.emit('media-state', { camOn: true });

    screenTrack.onended = () => stopScreenShare();
    sharingScreen = true;
    screenBtn.classList.add('active');
  } else {
    stopScreenShare();
  }
});

function stopScreenShare() {
  replaceVideoTrackForAllPeers(cameraTrack);
  document.querySelector('#tile-local video').srcObject = localStream;
  document.getElementById('tile-local').classList.toggle('cam-off', !camOn);
  socket.emit('media-state', { camOn });
  sharingScreen = false;
  screenBtn.classList.remove('active');
}

function replaceVideoTrackForAllPeers(newTrack) {
  peers.forEach(({ pc }) => {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) sender.replaceTrack(newTrack);
  });
}

leaveBtn.addEventListener('click', () => {
  window.location.reload();
});
