const socket = io();

// Elementos del DOM
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

// Servidores STUN gratuitos de Google para atravesar routers/NAT
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 1. Inicializar usuario y cámara al cargar
async function init() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = '/';
    return;
  }
  const data = await res.json();
  myUsername = data.user.username;
  document.getElementById('my-username').textContent = `👤 ${myUsername}`;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localVideo.srcObject = localStream;
  } catch (err) {
    alert('Debes permitir el acceso a la cámara y micrófono para usar el videochat.');
  }
}

// 2. Crear conexión Peer-to-Peer (WebRTC)
function createPeerConnection() {
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Añadir pistas locales (audio y video)
  if (localStream) {
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  }

  // Recibir video/audio del compañero
  peerConnection.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  // Enviar candidatos de red (ICE) al compañero vía Socket.io
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', event.candidate);
    }
  };
}

function closePeerConnection() {
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  remoteVideo.srcObject = null;
  partnerLabel.classList.add('hidden');
  msgInput.disabled = true;
  btnSend.disabled = true;
}

// 3. Acciones de Botones
function findPartner() {
  closePeerConnection();
  chatBox.innerHTML = '';
  addSystemMessage('Buscando un compañero de la ficha conectado...');
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
  const audioTrack = localStream.getAudioTracks()[0];
  audioTrack.enabled = !audioTrack.enabled;
  document.getElementById('btn-mute').textContent = audioTrack.enabled ? '🎤 Mic: ON' : '🔇 Mic: OFF';
}

function toggleVideo() {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  videoTrack.enabled = !videoTrack.enabled;
  document.getElementById('btn-cam').textContent = videoTrack.enabled ? '📷 Cam: ON' : '🚫 Cam: OFF';
}

async function logout() {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/';
}

// 4. Eventos de Socket.io (Emparejamiento y Señalización)
socket.on('waiting', () => {
  statusOverlay.textContent = 'Esperando a que otro aprendiz de la ficha presione Buscar...';
});

socket.on('matched', async ({ partnerName, initiator }) => {
  currentPartner = partnerName;
  statusOverlay.classList.add('hidden');
  partnerLabel.textContent = partnerName;
  partnerLabel.classList.remove('hidden');
  msgInput.disabled = false;
  btnSend.disabled = false;

  chatBox.innerHTML = '';
  addSystemMessage(`¡Conectado con ${partnerName}! Saluda en el chat.`);

  createPeerConnection();

  if (initiator) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', offer);
  }
});

socket.on('webrtc-offer', async (offer) => {
  if (!peerConnection) createPeerConnection();
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  socket.emit('webrtc-answer', answer);
});

socket.on('webrtc-answer', async (answer) => {
  if (peerConnection) {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
  }
});

socket.on('webrtc-ice-candidate', async (candidate) => {
  if (peerConnection) {
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (e) {
      console.error('Error agregando ICE candidate', e);
    }
  }
});

socket.on('partner-disconnected', () => {
  closePeerConnection();
  statusOverlay.textContent = `${currentPartner} se desconectó. Presiona "Siguiente / Buscar".`;
  statusOverlay.classList.remove('hidden');
  addSystemMessage(`${currentPartner} abandonó la conversación.`);
});

// 5. Lógica del Chat Interno
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
  div.innerHTML = `<strong>${sender}</strong>${escapeHtml(text)}`;
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
  return str.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

init();