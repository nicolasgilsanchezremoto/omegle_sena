const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const session = require('express-session');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 1. Base de Datos SQLite
const db = new sqlite3.Database('./database.sqlite', (err) => {
  if (err) console.error('Error abriendo BD:', err.message);
  else console.log('Base de datos SQLite conectada.');
});

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )
`);

// 2. Middlewares y Sesiones
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'clave-secreta-ficha-sena-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
});

app.use(sessionMiddleware);
app.use(express.static(path.join(__dirname, 'public')));
io.engine.use(sessionMiddleware);

// Configuración ICE (STUN + TURN desde variables de entorno)
app.get('/api/ice-config', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'No autenticado' });

  const iceServers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun.relay.metered.ca:80' }
  ];

  if (process.env.TURN_URLS && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
    const urls = process.env.TURN_URLS
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean);

    if (urls.length > 0) {
      iceServers.push({
        urls,
        username: process.env.TURN_USERNAME.trim(),
        credential: process.env.TURN_CREDENTIAL.trim()
      });
    }
  }

  res.json({ iceServers });
});

// 3. Autenticación
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password || username.trim().length < 3 || password.length < 4) {
    return res.status(400).json({ error: 'Usuario (mín. 3) y contraseña (mín. 4) requeridos.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    db.run(
      'INSERT INTO users (username, password) VALUES (?, ?)',
      [username.trim(), hashedPassword],
      function (err) {
        if (err) {
          return res.status(400).json({ error: 'Ese nombre de usuario ya está en uso.' });
        }
        req.session.user = { id: this.lastID, username: username.trim() };
        res.json({ ok: true, username: username.trim() });
      }
    );
  } catch (e) {
    res.status(500).json({ error: 'Error interno al registrar.' });
  }
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username?.trim()], async (err, user) => {
    if (err || !user) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
    }
    req.session.user = { id: user.id, username: user.username };
    res.json({ ok: true, username: user.username });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'No autenticado' });
  res.json({ user: req.session.user });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

app.get('/app.html', (req, res, next) => {
  if (!req.session.user) return res.redirect('/');
  next();
});

// 4. Emparejamiento Aleatorio (Cola FIFO para 18+ personas)
const waitingQueue = [];
const activePairs = new Map(); // socket.id -> partnerSocket.id

function removeFromQueue(socketId) {
  const idx = waitingQueue.indexOf(socketId);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function getNextValidPartner(currentSocketId) {
  while (waitingQueue.length > 0) {
    const candidateId = waitingQueue.shift();
    if (!candidateId || candidateId === currentSocketId) continue;
    if (activePairs.has(candidateId)) continue;

    const candidateSocket = io.sockets.sockets.get(candidateId);
    if (candidateSocket && candidateSocket.connected) {
      return candidateSocket;
    }
  }
  return null;
}

function disconnectPartner(socket, notifyPartner = true) {
  removeFromQueue(socket.id);

  const partnerId = activePairs.get(socket.id);
  if (partnerId) {
    activePairs.delete(socket.id);
    activePairs.delete(partnerId);

    if (notifyPartner) {
      const partnerSocket = io.sockets.sockets.get(partnerId);
      if (partnerSocket && partnerSocket.connected) {
        partnerSocket.emit('partner-disconnected');
      }
    }
  }
}

io.on('connection', (socket) => {
  const user = socket.request.session?.user;
  if (!user) {
    socket.disconnect();
    return;
  }

  socket.username = user.username;

  socket.on('find-partner', () => {
    disconnectPartner(socket, true);

    const partner = getNextValidPartner(socket.id);
    if (partner) {
      activePairs.set(socket.id, partner.id);
      activePairs.set(partner.id, socket.id);

      partner.emit('matched', { partnerName: socket.username, initiator: true });
      socket.emit('matched', { partnerName: partner.username, initiator: false });
    } else {
      if (!waitingQueue.includes(socket.id)) {
        waitingQueue.push(socket.id);
      }
      socket.emit('waiting', { queueSize: waitingQueue.length });
    }
  });

  socket.on('webrtc-offer', (offer) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-offer', offer);
  });

  socket.on('webrtc-answer', (answer) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-answer', answer);
  });

  socket.on('webrtc-ice-candidate', (candidate) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-ice-candidate', candidate);
  });

  socket.on('chat-message', (msg) => {
    const partnerId = activePairs.get(socket.id);
    if (partnerId && typeof msg === 'string' && msg.trim()) {
      io.to(partnerId).emit('chat-message', {
        sender: socket.username,
        text: msg.trim()
      });
    }
  });

  socket.on('stop-chat', () => {
    disconnectPartner(socket, true);
  });

  socket.on('disconnect', () => {
    disconnectPartner(socket, true);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
