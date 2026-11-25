const socket = io();

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
let pendingIceCandidates = [];
let hasRemoteDescription = false;

let rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

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
    // Si la cámara está en uso por otra pestaña del mismo PC, intenta solo audio
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
      localVideo.srcObject = localStream;
      addSystemMessage('Cámara ocupada en otro dispositivo/pestaña; conectado con micrófono.');
      return true;
    } catch (audioErr) {
      addSystemMessage('Permite cámara/micrófono o entra por HTTPS para usar video.');
      return false;
    }
  }
}

async function init() {
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
  closePeerConnection();
  hasRemoteDescription = false;
  pendingIceCandidates = [];

  peerConnection = new RTCPeerConnection(rtcConfig);

  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  peerConnection.ontrack = (event) => {
    if (event.streams && event.streams[0]) {
      remoteVideo.srcObject = event.streams[0];
    }
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', event.candidate);
    }
  };

  peerConnection.onconnectionstatechange = () => {
    if (!peerConnection) return;
    if (peerConnection.connectionState === 'failed') {
      addSystemMessage('La conexión de video falló por red/firewall. Intenta "Siguiente / Buscar" o configura TURN.');
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

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.ontrack = null;
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  hasRemoteDescription = false;
  pendingIceCandidates = [];
  remoteVideo.srcObject = null;
  partnerLabel.classList.add('hidden');
  msgInput.disabled = true;
  btnSend.disabled = true;
}

async function findPartner() {
  await initMedia();
  closePeerConnection();
  chatBox.innerHTML = '';
  addSystemMessage('Buscando un compañero disponible de la ficha...');
  statusOverlay.textContent = 'Buscando compañero...';
  statusOverlay.classList.remove('hidden');
  btnStop.disabled = false;
  socket.emit('find-partner');
}

function stopChat() {
  closePeerConnection();
  socket.emit('stop-chat');
  statusOverlay.textContent = 'Chat detenido. Presiona "Siguiente / Buscar" para volver.';
  statusOverlay.classList.remove('hidden');
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
  closePeerConnection();
  socket.emit('stop-chat');
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

socket.on('waiting', () => {
  statusOverlay.textContent = 'Esperando a que otro compañero de la ficha presione Buscar...';
});

socket.on('matched', async ({ partnerName, initiator }) => {
  currentPartner = partnerName;
  statusOverlay.classList.add('hidden');
  partnerLabel.textContent = partnerName;
  partnerLabel.classList.remove('hidden');
  msgInput.disabled = false;
  btnSend.disabled = false;

  chatBox.innerHTML = '';
  addSystemMessage(`¡Conectado con ${partnerName}! Ya pueden escribir y verse.`);

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
  closePeerConnection();
  statusOverlay.textContent = `${currentPartner || 'Tu compañero'} se desconectó. Presiona "Siguiente / Buscar".`;
  statusOverlay.classList.remove('hidden');
  addSystemMessage(`${currentPartner || 'Tu compañero'} abandonó la conversación.`);
});

document.getElementById('chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
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
  return str.replace(/[&<>"']/g, m => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[m]));
}

init();
