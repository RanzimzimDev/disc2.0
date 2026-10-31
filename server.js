const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  },
  pingTimeout: 30000,
  pingInterval: 10000
});

const PORT = process.env.PORT || 3000;

// ==========================================
// SEGURANÇA HTTP & CABEÇALHOS (HELMET)
// ==========================================
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
        mediaSrc: ["'self'", "blob:"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: null // Permite testes locais http
      }
    },
    crossOriginEmbedderPolicy: false
  })
);

// Proteção contra DoS / Brute-Force HTTP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 120, // Limite por IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições deste IP. Aguarde um momento.' }
});
app.use(limiter);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// ESTRUTURA DE SALAS EM MEMÓRIA
// ==========================================
/**
 * rooms[roomId] = {
 *   id: string,
 *   name: string,
 *   passwordHash: string | null,
 *   hostSocketId: string,
 *   waitingRoom: boolean,
 *   members: Map<socketId, { username, isHost, isMuted, isDeafened, isScreenSharing }>,
 *   waitingQueue: Map<socketId, { username, socketId }>,
 *   bannedIps: Set<string>
 * }
 */
const rooms = new Map();

// Helper para gerar ID seguro e legível para a sala
function generateSecureRoomId() {
  return crypto.randomBytes(6).toString('hex'); // 12 caracteres hexadecimais aleatórios
}

// Sanitização estrita contra XSS
function sanitizeText(str) {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, 1000)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ==========================================
// ROTAS DE API
// ==========================================
app.get('/api/check-room/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms.get(roomId);
  if (!room) {
    return res.status(404).json({ exists: false });
  }
  return res.json({
    exists: true,
    name: room.name,
    hasPassword: !!room.passwordHash,
    memberCount: room.members.size,
    waitingRoom: room.waitingRoom
  });
});

// ==========================================
// GERENCIAMENTO WEBSOCKET / WEBRTC (SOCKET.IO)
// ==========================================
io.use((socket, next) => {
  // Limiter de pacotes por socket para evitar flood
  socket.messageCount = 0;
  socket.lastReset = Date.now();
  next();
});

io.on('connection', (socket) => {
  const clientIp = socket.handshake.address;

  // Rate limit de eventos por segundo no Socket
  const checkSocketRateLimit = () => {
    const now = Date.now();
    if (now - socket.lastReset > 1000) {
      socket.messageCount = 0;
      socket.lastReset = now;
    }
    socket.messageCount++;
    if (socket.messageCount > 25) {
      socket.emit('security-alert', 'Você foi desconectado por exceder o limite de mensagens por segundo.');
      socket.disconnect(true);
      return false;
    }
    return true;
  };

  // ------------------------------------------
  // 1. CRIAR SALA
  // ------------------------------------------
  socket.on('create-room', async (data, callback) => {
    if (!checkSocketRateLimit()) return;
    try {
      const roomName = sanitizeText(data.roomName || 'Sala dos Amigos');
      const password = data.password ? String(data.password).trim() : null;
      const waitingRoom = data.waitingRoom !== false; // Default: true (seguro)
      const username = sanitizeText(data.username || 'Anfitrião');

      const roomId = generateSecureRoomId();
      let passwordHash = null;
      if (password) {
        passwordHash = await bcrypt.hash(password, 10);
      }

      const newRoom = {
        id: roomId,
        name: roomName,
        passwordHash,
        hostSocketId: socket.id,
        waitingRoom,
        members: new Map(),
        waitingQueue: new Map(),
        bannedIps: new Set()
      };

      // Adiciona o host diretamente como membro
      newRoom.members.set(socket.id, {
        socketId: socket.id,
        username,
        isHost: true,
        isMuted: false,
        isDeafened: false,
        isScreenSharing: false
      });

      rooms.set(roomId, newRoom);
      socket.join(roomId);
      socket.currentRoomId = roomId;

      if (typeof callback === 'function') {
        callback({
          success: true,
          roomId,
          roomName,
          isHost: true,
          waitingRoom
        });
      }

      console.log(`[Disc 2.0] Sala criada: "${roomName}" (ID: ${roomId}) pelo host ${username}`);
    } catch (err) {
      console.error('Erro ao criar sala:', err);
      if (typeof callback === 'function') callback({ success: false, error: 'Erro no servidor ao criar sala.' });
    }
  });

  // ------------------------------------------
  // 2. ENTRAR EM SALA EXISTENTE
  // ------------------------------------------
  socket.on('join-room', async (data, callback) => {
    if (!checkSocketRateLimit()) return;
    try {
      const roomId = String(data.roomId || '').trim();
      const password = data.password ? String(data.password).trim() : '';
      const username = sanitizeText(data.username || 'Amigo');

      const room = rooms.get(roomId);
      if (!room) {
        return callback && callback({ success: false, error: 'Sala não encontrada. Verifique o código.' });
      }

      // Checa se o IP foi banido
      if (room.bannedIps.has(clientIp)) {
        return callback && callback({ success: false, error: 'Você foi banido desta sala pelo anfitrião.' });
      }

      // Checa senha se existir
      if (room.passwordHash) {
        if (!password) {
          return callback && callback({ success: false, needPassword: true, error: 'Esta sala requer senha.' });
        }
        const match = await bcrypt.compare(password, room.passwordHash);
        if (!match) {
          return callback && callback({ success: false, needPassword: true, error: 'Senha incorreta!' });
        }
      }

      // Se a sala de espera estiver ativa e quem está entrando não é o host
      if (room.waitingRoom && socket.id !== room.hostSocketId) {
        room.waitingQueue.set(socket.id, { username, socketId: socket.id });
        socket.pendingRoomId = roomId;

        // Notifica o anfitrião que há alguém na sala de espera
        io.to(room.hostSocketId).emit('guest-waiting', {
          socketId: socket.id,
          username
        });

        return callback && callback({
          success: true,
          waitingInLobby: true,
          message: 'Você está no Lobby. Aguardando o anfitrião aprovar sua entrada...'
        });
      }

      // Entrada direta autorizada
      admitUserToRoom(socket, room, username, callback);
    } catch (err) {
      console.error('Erro ao entrar na sala:', err);
      if (typeof callback === 'function') callback({ success: false, error: 'Erro interno ao entrar na sala.' });
    }
  });

  // Função auxiliar para admitir o usuário na sala
  function admitUserToRoom(targetSocket, room, username, callback) {
    const isHost = targetSocket.id === room.hostSocketId;
    room.members.set(targetSocket.id, {
      socketId: targetSocket.id,
      username,
      isHost,
      isMuted: false,
      isDeafened: false,
      isScreenSharing: false
    });

    targetSocket.join(room.id);
    targetSocket.currentRoomId = room.id;
    targetSocket.pendingRoomId = null;

    // Constrói lista de membros existentes para o novo membro
    const existingMembers = [];
    room.members.forEach((member, sid) => {
      if (sid !== targetSocket.id) {
        existingMembers.push(member);
      }
    });

    if (typeof callback === 'function') {
      callback({
        success: true,
        roomId: room.id,
        roomName: room.name,
        isHost,
        waitingRoom: room.waitingRoom,
        existingMembers
      });
    }

    // Avisa os outros membros da sala que um novo amigo entrou
    targetSocket.to(room.id).emit('user-joined', {
      socketId: targetSocket.id,
      username,
      isHost
    });

    console.log(`[Disc 2.0] ${username} entrou na sala ${room.name} (${room.id})`);
  }

  // ------------------------------------------
  // 3. APROVAÇÃO / RECUSA NO LOBBY (HOST ONLY)
  // ------------------------------------------
  socket.on('approve-guest', ({ guestSocketId }) => {
    if (!checkSocketRateLimit()) return;
    const room = rooms.get(socket.currentRoomId);
    if (!room || room.hostSocketId !== socket.id) return;

    const guestData = room.waitingQueue.get(guestSocketId);
    if (!guestData) return;

    room.waitingQueue.delete(guestSocketId);
    const guestSocket = io.sockets.sockets.get(guestSocketId);
    if (guestSocket) {
      admitUserToRoom(guestSocket, room, guestData.username, (response) => {
        guestSocket.emit('lobby-approved', response);
      });
    }
  });

  socket.on('reject-guest', ({ guestSocketId }) => {
    if (!checkSocketRateLimit()) return;
    const room = rooms.get(socket.currentRoomId);
    if (!room || room.hostSocketId !== socket.id) return;

    room.waitingQueue.delete(guestSocketId);
    const guestSocket = io.sockets.sockets.get(guestSocketId);
    if (guestSocket) {
      guestSocket.emit('lobby-rejected', 'O anfitrião recusou sua solicitação de entrada.');
      guestSocket.pendingRoomId = null;
    }
  });

  // ------------------------------------------
  // 4. MODERAÇÃO (KICK & MUTE)
  // ------------------------------------------
  socket.on('kick-member', ({ targetSocketId }) => {
    if (!checkSocketRateLimit()) return;
    const room = rooms.get(socket.currentRoomId);
    if (!room || room.hostSocketId !== socket.id) return;

    const targetSocket = io.sockets.sockets.get(targetSocketId);
    if (targetSocket) {
      targetSocket.emit('kicked', 'Você foi desconectado pelo anfitrião.');
      targetSocket.leave(room.id);
      targetSocket.currentRoomId = null;
      room.members.delete(targetSocketId);
      io.to(room.id).emit('user-left', { socketId: targetSocketId, username: 'Usuário' });
    }
  });

  // ------------------------------------------
  // 5. SINALIZAÇÃO WEBRTC (OFFER, ANSWER, ICE)
  // ------------------------------------------
  socket.on('webrtc-offer', ({ targetSocketId, offer, streamType }) => {
    if (!checkSocketRateLimit()) return;
    io.to(targetSocketId).emit('webrtc-offer', {
      senderSocketId: socket.id,
      offer,
      streamType // 'camera', 'mic' ou 'screen'
    });
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer, streamType }) => {
    if (!checkSocketRateLimit()) return;
    io.to(targetSocketId).emit('webrtc-answer', {
      senderSocketId: socket.id,
      answer,
      streamType
    });
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate, streamType }) => {
    if (!checkSocketRateLimit()) return;
    io.to(targetSocketId).emit('webrtc-ice-candidate', {
      senderSocketId: socket.id,
      candidate,
      streamType
    });
  });

  // ------------------------------------------
  // 6. ESTADO DE USUÁRIO (MUTE, DEAFEN, TELA, VOZ)
  // ------------------------------------------
  socket.on('update-user-state', (state) => {
    if (!checkSocketRateLimit()) return;
    const room = rooms.get(socket.currentRoomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    if (member) {
      if (typeof state.isMuted === 'boolean') member.isMuted = state.isMuted;
      if (typeof state.isDeafened === 'boolean') member.isDeafened = state.isDeafened;
      if (typeof state.isScreenSharing === 'boolean') member.isScreenSharing = state.isScreenSharing;
      if (typeof state.isSpeaking === 'boolean') member.isSpeaking = state.isSpeaking;

      socket.to(room.id).emit('user-state-changed', {
        socketId: socket.id,
        ...state
      });
    }
  });

  // ------------------------------------------
  // 7. CHAT DE TEXTO SEGURO
  // ------------------------------------------
  socket.on('send-chat-message', (data) => {
    if (!checkSocketRateLimit()) return;
    const room = rooms.get(socket.currentRoomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    if (!member) return;

    const rawText = String(data.text || '').trim();
    if (!rawText) return;

    const cleanText = sanitizeText(rawText);
    const messagePayload = {
      id: crypto.randomUUID(),
      senderSocketId: socket.id,
      senderUsername: member.username,
      text: cleanText,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    io.to(room.id).emit('chat-message', messagePayload);
  });

  // ------------------------------------------
  // 8. DESCONEXÃO
  // ------------------------------------------
  socket.on('disconnect', () => {
    const roomId = socket.currentRoomId;
    if (roomId && rooms.has(roomId)) {
      const room = rooms.get(roomId);
      const member = room.members.get(socket.id);
      room.members.delete(socket.id);

      io.to(roomId).emit('user-left', {
        socketId: socket.id,
        username: member ? member.username : 'Amigo'
      });

      // Se o anfitrião saiu e ainda há membros, transfere o cargo de host
      if (room.hostSocketId === socket.id && room.members.size > 0) {
        const nextHostId = room.members.keys().next().value;
        room.hostSocketId = nextHostId;
        const nextHost = room.members.get(nextHostId);
        nextHost.isHost = true;
        io.to(roomId).emit('host-changed', { newHostSocketId: nextHostId, username: nextHost.username });
        console.log(`[Disc 2.0] Anfitrião desconectou. Novo anfitrião da sala ${roomId}: ${nextHost.username}`);
      }

      // Se a sala esvaziou completamente, limpa a memória após 2 minutos
      if (room.members.size === 0) {
        setTimeout(() => {
          if (rooms.has(roomId) && rooms.get(roomId).members.size === 0) {
            rooms.delete(roomId);
            console.log(`[Disc 2.0] Sala vazia ${roomId} removida da memória.`);
          }
        }, 120000);
      }
    }

    // Se estava em fila de espera
    if (socket.pendingRoomId && rooms.has(socket.pendingRoomId)) {
      const room = rooms.get(socket.pendingRoomId);
      room.waitingQueue.delete(socket.id);
      io.to(room.hostSocketId).emit('guest-left-lobby', { socketId: socket.id });
    }
  });
});

server.listen(PORT, () => {
  console.log(`===============================================`);
  console.log(`🚀 Disc 2.0 Servidor Online na porta ${PORT}`);
  console.log(`🔒 Modo Seguro Ativo (Rate Limit + Helmet + Salas Criptografadas)`);
  console.log(`👉 Acesse no navegador: http://localhost:${PORT}`);
  console.log(`===============================================`);
});
