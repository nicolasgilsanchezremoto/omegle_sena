const socket = io({
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1000
});

const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const statusOverlay = document.getElementById('status-overlay');
const partnerLabel = document.getElementById('partner-label');
const chatBox = document.getElementById('chat-messages');
const msgInput = document.getElementById('msg-input');
const btnSend = document.getElementById('btn-send');
const btnStop = document.getElementById('btn-stop');

let localStream = null;
let peerConnection = null;
let myUsername = '';
let currentPartner = '';
let isMatched = false;
let pendingIceCandidates = [];
let hasRemoteDescription = false;

let rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

function setChatEnabled(enabled) {
  msgInput.disabled = !enabled;
  btnSend.disabled = !enabled;
  if (enabled) {
    msgInput.focus();
  }
}

async function initMedia() {
  if (localStream) return true;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: true
    });
    localVideo.srcObject = localStream;
    return true;
  } catch (err) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localVideo.srcObject = localStream;
      addSystemMessage('Cámara no disponible o en uso; conectado con micrófono.');
      return true;
    } catch (audioErr) {
      addSystemMessage('Permite cámara y micrófono en el navegador para usar el videochat.');
      return false;
    }
  }
}

async function init() {
  setChatEnabled(false);

  const meRes = await fetch('/api/me');
  if (!meRes.ok) {
    window.location.href = '/';
    return;
  }
  const meData = await meRes.json();
  myUsername = meData.user.username;
  document.getElementById('my-username').textContent = `👤 ${myUsername}`;

  const iceRes = await fetch('/api/ice-config');
  if (iceRes.ok) {
    const iceData = await iceRes.json();
    if (Array.isArray(iceData.iceServers) && iceData.iceServers.length > 0) {
      rtcConfig = { iceServers: iceData.iceServers };
    }
  }

  await initMedia();
}

function createPeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  hasRemoteDescription = false;
  pendingIceCandidates = [];

  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // --- REEMPLAZA DESDE AQUÍ ---
  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
      remoteVideo.play().catch(() => {});
      statusOverlay.classList.add('hidden');
    } else if (event.track) {
      const inboundStream = remoteVideo.srcObject instanceof MediaStream
        ? remoteVideo.srcObject
        : new MediaStream();
      inboundStream.addTrack(event.track);
      remoteVideo.srcObject = inboundStream;
      remoteVideo.play().catch(() => {});
      statusOverlay.classList.add('hidden');
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', event.candidate);
    }
  };

  peerConnection.oniceconnectionstatechange = () => {
    if (!peerConnection) return;
    const state = peerConnection.iceConnectionState;
    if (state === 'failed' || state === 'disconnected') {
      statusOverlay.textContent = `Sin ruta de video con ${currentPartner || 'el compañero'} (posible bloqueo de red). Prueba "Siguiente / Buscar".`;
      statusOverlay.classList.remove('hidden');
    }
  };
  // --- HASTA AQUÍ ---

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === 'failed') {
      addSystemMessage('No se pudo establecer el video con tu compañero. Prueba "Siguiente / Buscar".');
    }
  };
}

async function flushPendingIce() {
  if (!peerConnection || !hasRemoteDescription) return;
  while (pendingIceCandidates.length > 0) {
    const cand = pendingIceCandidates.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
    } catch (e) {
      console.error('Error aplicando ICE pendiente:', e);
    }
  }
}

function resetConnectionState(keepOverlayMessage = '') {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }

  isMatched = false;
  currentPartner = '';
  hasRemoteDescription = false;
  pendingIceCandidates = [];
  remoteVideo.srcObject = null;

  partnerLabel.textContent = 'Compañero';
  partnerLabel.classList.add('hidden');
  setChatEnabled(false);

  if (keepOverlayMessage) {
    statusOverlay.textContent = keepOverlayMessage;
    statusOverlay.classList.remove('hidden');
  }
}

async function findPartner() {
  await initMedia();
  resetConnectionState('Buscando compañero disponible de la ficha...');
  chatBox.innerHTML = '';
  addSystemMessage('Buscando compañero disponible...');
  btnStop.disabled = false;
  socket.emit('find-partner');
}

function stopChat() {
  resetConnectionState('Chat detenido. Presiona "Siguiente / Buscar" para volver.');
  socket.emit('stop-chat');
  btnStop.disabled = true;
  addSystemMessage('Has detenido la conexión.');
}

function toggleAudio() {
  if (!localStream) return;
  const audioTracks = localStream.getAudioTracks();
  if (!audioTracks.length) return;
  audioTracks[0].enabled = !audioTracks[0].enabled;
  document.getElementById('btn-mute').textContent = audioTracks[0].enabled ? '🎤 Mic: ON' : '🔇 Mic: OFF';
}

function toggleVideo() {
  if (!localStream) return;
  const videoTracks = localStream.getVideoTracks();
  if (!videoTracks.length) return;
  videoTracks[0].enabled = !videoTracks[0].enabled;
  document.getElementById('btn-cam').textContent = videoTracks[0].enabled ? '📷 Cam: ON' : '🚫 Cam: OFF';
}

async function logout() {
  resetConnectionState('');
  socket.emit('stop-chat');
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

socket.on('connect', () => {
  // Si ya había un match activo y el socket reconectó, reactiva el chat
  if (isMatched && currentPartner) {
    setChatEnabled(true);
  }
});

socket.on('waiting', () => {
  isMatched = false;
  setChatEnabled(false);
  statusOverlay.textContent = 'Esperando a que otro compañero de la ficha presione Buscar...';
  statusOverlay.classList.remove('hidden');
});

socket.on('matched', async ({ partnerName, initiator }) => {
  isMatched = true;
  currentPartner = partnerName || 'Compañero';

  partnerLabel.textContent = currentPartner;
  partnerLabel.classList.remove('hidden');

  statusOverlay.textContent = `Conectando video con ${currentPartner}...`;
  statusOverlay.classList.remove('hidden');

  setChatEnabled(true);
  btnStop.disabled = false;

  chatBox.innerHTML = '';
  addSystemMessage(`¡Conectado con ${currentPartner}! Ya pueden escribir.`);

  createPeerConnection();

  if (initiator) {
    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socket.emit('webrtc-offer', offer);
    } catch (err) {
      console.error('Error creando offer:', err);
    }
  }
});

socket.on('webrtc-offer', async (offer) => {
  if (!peerConnection) createPeerConnection();
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    hasRemoteDescription = true;
    await flushPendingIce();

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('webrtc-answer', answer);
  } catch (err) {
    console.error('Error manejando offer:', err);
  }
});

socket.on('webrtc-answer', async (answer) => {
  if (!peerConnection) return;
  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    hasRemoteDescription = true;
    await flushPendingIce();
  } catch (err) {
    console.error('Error manejando answer:', err);
  }
});

socket.on('webrtc-ice-candidate', async (candidate) => {
  if (!candidate) return;
  if (peerConnection && hasRemoteDescription) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error agregando ICE:', e);
    }
  } else {
    pendingIceCandidates.push(candidate);
  }
});

socket.on('partner-disconnected', () => {
  const disconnectedName = currentPartner || 'Tu compañero';
  resetConnectionState(`${disconnectedName} se desconectó. Presiona "Siguiente / Buscar".`);
  addSystemMessage(`${disconnectedName} abandonó la conversación.`);
});

document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isMatched || msgInput.disabled) return;

  const text = msgInput.value.trim();
  if (!text) return;

  socket.emit('chat-message', text);
  addChatMessage(myUsername, text, true);
  msgInput.value = '';
});

socket.on('chat-message', ({ sender, text }) => {
  addChatMessage(sender, text, false);
});

function addChatMessage(sender, text, isMine) {
  const div = document.createElement('div');
  div.className = `msg ${isMine ? 'mine' : 'theirs'}`;
  div.innerHTML = `<strong>${escapeHtml(sender)}</strong>${escapeHtml(text)}`;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement('div');
  div.className = 'sys-msg';
  div.textContent = text;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[m]));
}

init();
