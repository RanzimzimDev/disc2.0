/**
 * DISC 2.0 — MULTI-SCREEN SHARING ENGINE (60 FPS NATIVO)
 * - Várias pessoas podem compartilhar tela ao mesmo tempo
 * - Modo Destaque (Spotlight) e Modo Grade (Side-by-side)
 * - Controle de volume individual por jogo transmitido
 * - Criptografia direta WebRTC P2P (DTLS/SRTP)
 * - Sem microfone (sem eco com o Discord)
 */

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ]
};

const state = {
  socket: null,
  roomId: null,
  roomName: null,
  username: null,
  isHost: false,
  isStreaming: false,
  selectedQuality: '1080p60',
  viewMode: 'spotlight', // 'spotlight' ou 'grid'
  selectedSpotlightId: null, // socketId da tela em destaque
  incomingGuest: null, // convidado solicitando entrada

  // Stream local de tela
  localScreenStream: null,

  // Mapa de todas as transmissões ativas: socketId -> { stream, username, isLocal, volume, isMuted }
  activeStreams: new Map(),

  // Conexões P2P e membros
  peers: new Map(), // socketId -> RTCPeerConnection
  members: new Map(), // socketId -> memberData
  waitingQueue: new Map() // socketId -> guestData
};

window.addEventListener('DOMContentLoaded', () => {
  initSocket();
  setupAuthTabs();
  setupURLQuery();
  setupEventListeners();
});

// ==========================================
// SOCKET.IO & EVENTOS
// ==========================================
function initSocket() {
  state.socket = io({ reconnectionAttempts: 5 });

  state.socket.on('connect', () => {
    console.log('[Disc 2.0] Conectado ao servidor:', state.socket.id);
  });

  state.socket.on('connect_error', () => {
    showToast('Erro de conexão com o servidor.', 'error');
  });

  // Novo amigo entrou na sala
  state.socket.on('user-joined', (user) => {
    state.members.set(user.socketId, user);
    updateViewersCount();
    showToast(`${user.username} entrou na sala!`, 'success');

    // Cria conexão P2P com o novo participante
    const pc = createPeerConnection(user.socketId, true);

    // Se o usuário local já estiver transmitindo, envia sua tela para o novo amigo
    if (state.isStreaming && state.localScreenStream) {
      state.localScreenStream.getTracks().forEach((track) => pc.addTrack(track, state.localScreenStream));
      createAndSendOffer(pc, user.socketId);
    }
  });

  // Amigo desconectou
  state.socket.on('user-left', ({ socketId, username }) => {
    closePeerConnection(socketId);
    state.members.delete(socketId);
    state.activeStreams.delete(socketId);

    if (state.selectedSpotlightId === socketId) {
      state.selectedSpotlightId = state.activeStreams.keys().next().value || null;
    }

    updateViewersCount();
    renderStreamsStage();
    showToast(`${username} saiu da sala.`, 'normal');
  });

  // Anfitrião mudou
  state.socket.on('host-changed', ({ newHostSocketId }) => {
    if (state.socket.id === newHostSocketId) {
      state.isHost = true;
      document.getElementById('btn-host-security').classList.remove('hidden');
      showToast('Você agora é o anfitrião da sala!', 'success');
    }
  });

  // Status de transmissão mudou
  state.socket.on('user-state-changed', (data) => {
    const member = state.members.get(data.socketId);
    if (member) {
      member.isScreenSharing = data.isScreenSharing;
    }

    if (data.isScreenSharing === false) {
      state.activeStreams.delete(data.socketId);
      if (state.selectedSpotlightId === data.socketId) {
        state.selectedSpotlightId = state.activeStreams.keys().next().value || null;
      }
      renderStreamsStage();
    }
  });

  // Fila de Espera (Lobby)
  state.socket.on('guest-waiting', (guest) => {
    state.waitingQueue.set(guest.socketId, guest);
    state.incomingGuest = guest;
    updateLobbyUI();

    // Exibe banner flutuante diretamente no topo da tela do anfitrião
    const alertBanner = document.getElementById('lobby-incoming-alert');
    const guestNameEl = document.getElementById('incoming-guest-name');
    if (alertBanner && guestNameEl) {
      guestNameEl.innerHTML = `<strong>${escapeHTML(guest.username)}</strong> pediu para assistir sua transmissão`;
      alertBanner.classList.remove('hidden');
    }

    showToast(`${guest.username} pediu permissão para entrar!`, 'normal');
  });

  state.socket.on('guest-left-lobby', ({ socketId }) => {
    state.waitingQueue.delete(socketId);
    if (state.incomingGuest && state.incomingGuest.socketId === socketId) {
      state.incomingGuest = null;
      const alertBanner = document.getElementById('lobby-incoming-alert');
      if (alertBanner) alertBanner.classList.add('hidden');
    }
    updateLobbyUI();
  });

  state.socket.on('lobby-approved', (roomData) => {
    document.getElementById('lobby-waiting-modal').classList.add('hidden');
    enterRoom(roomData);
  });

  state.socket.on('lobby-rejected', (msg) => {
    document.getElementById('lobby-waiting-modal').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    showToast(msg, 'error');
  });

  state.socket.on('kicked', (msg) => {
    leaveRoom();
    alert(`[Aviso]: ${msg}`);
  });

  // Atualizações em tempo real da lista de salas ao vivo
  state.socket.on('rooms-updated', (rooms) => {
    renderActiveRooms(rooms);
  });

  // Sinalização WebRTC
  state.socket.on('webrtc-offer', handleWebRTCOffer);
  state.socket.on('webrtc-answer', handleWebRTCAnswer);
  state.socket.on('webrtc-ice-candidate', handleWebRTCIceCandidate);
}

// ==========================================
// AUTH & SETUP
// ==========================================
function setupAuthTabs() {
  const tabCreate = document.getElementById('tab-create');
  const tabJoin = document.getElementById('tab-join');
  const formCreate = document.getElementById('form-create-room');
  const formJoin = document.getElementById('form-join-room');

  tabCreate.addEventListener('click', () => {
    tabCreate.classList.add('active');
    tabJoin.classList.remove('active');
    formCreate.classList.remove('hidden');
    formJoin.classList.add('hidden');
  });

  tabJoin.addEventListener('click', () => {
    tabJoin.classList.add('active');
    tabCreate.classList.remove('active');
    formJoin.classList.remove('hidden');
    formCreate.classList.add('hidden');
    fetchActiveRooms();
  });
}

function fetchActiveRooms() {
  if (!state.socket) return;
  state.socket.emit('get-active-rooms', (res) => {
    if (res && res.success) {
      renderActiveRooms(res.rooms);
    }
  });
}

function renderActiveRooms(rooms) {
  const container = document.getElementById('active-rooms-list');
  if (!container) return;

  container.innerHTML = '';
  if (!rooms || rooms.length === 0) {
    container.innerHTML = `
      <p class="no-rooms-msg">
        Nenhuma sala ao vivo no momento.<br>
        <small>Assim que alguém transmitir ela aparece aqui!</small>
      </p>
    `;
    return;
  }

  rooms.forEach((r) => {
    const card = document.createElement('div');
    card.className = 'active-room-card';
    card.innerHTML = `
      <div class="active-room-info">
        <div class="active-room-name">
          <span class="live-dot-pulse"></span>
          <span>${escapeHTML(r.roomName)}</span>
          ${r.hasPassword ? '<span title="Requer Senha">🔒</span>' : ''}
        </div>
        <div class="active-room-meta">
          Por <strong>${escapeHTML(r.hostName)}</strong> • 👥 ${r.membersCount} na sala
        </div>
      </div>
      <button class="btn btn-blurple btn-small btn-join-direct">Entrar</button>
    `;

    card.querySelector('.btn-join-direct').addEventListener('click', (e) => {
      e.stopPropagation();
      document.getElementById('join-room-id').value = r.roomId;
      const username = document.getElementById('join-username').value.trim();
      if (!username) {
        document.getElementById('join-username').focus();
        showToast('Digite seu nome/apelido primeiro!', 'normal');
        return;
      }
      document.getElementById('form-join-room').requestSubmit();
    });

    container.appendChild(card);
  });
}

function extractRoomId(input) {
  if (!input) return '';
  const str = String(input).trim();
  const paramMatch = str.match(/[?&]room=([a-zA-Z0-9_-]+)/i);
  if (paramMatch) return paramMatch[1].trim();
  const pathMatch = str.match(/\/([a-zA-Z0-9_-]{6,32})(?:\/|\?|$)/);
  if (pathMatch) return pathMatch[1].trim();
  return str.replace(/[^a-zA-Z0-9_-]/g, '');
}

function setupURLQuery() {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    document.getElementById('tab-join').click();
    document.getElementById('join-room-id').value = extractRoomId(roomParam);
  }
}

function setupEventListeners() {
  // Criar sala
  document.getElementById('form-create-room').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('create-username').value.trim();
    const roomName = document.getElementById('create-room-name').value.trim();
    const password = document.getElementById('create-password').value;
    const waitingRoom = document.getElementById('create-waiting-room').checked;

    state.username = username;
    state.socket.emit('create-room', { username, roomName, password, waitingRoom }, (res) => {
      if (!res.success) return showToast(res.error || 'Erro ao criar sala', 'error');
      enterRoom(res);
    });
  });

  // Entrar em sala
  document.getElementById('form-join-room').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('join-username').value.trim();
    const rawInput = document.getElementById('join-room-id').value;
    const roomId = extractRoomId(rawInput);
    const password = document.getElementById('join-password').value;

    if (!roomId) {
      return showToast('Por favor, informe o link ou código da sala.', 'error');
    }

    state.username = username;
    state.socket.emit('join-room', { username, roomId, password }, (res) => {
      if (!res.success) return showToast(res.error || 'Erro ao entrar na sala', 'error');

      if (res.waitingInLobby) {
        document.getElementById('auth-screen').classList.add('hidden');
        document.getElementById('lobby-waiting-modal').classList.remove('hidden');
        return;
      }
      enterRoom(res);
    });
  });

  document.getElementById('btn-cancel-lobby').addEventListener('click', () => {
    window.location.reload();
  });

  document.getElementById('btn-copy-invite').addEventListener('click', copyInviteLink);
  document.getElementById('btn-leave-room').addEventListener('click', leaveRoom);

  // Botão Transmitir Tela
  document.getElementById('btn-toggle-screen').addEventListener('click', () => {
    if (state.isStreaming) {
      stopScreenSharing();
    } else {
      document.getElementById('screen-picker-modal').classList.remove('hidden');
    }
  });

  document.getElementById('btn-start-stream-confirm').addEventListener('click', () => {
    const selected = document.querySelector('input[name="stream-quality"]:checked');
    if (selected) state.selectedQuality = selected.value;
    document.getElementById('screen-picker-modal').classList.add('hidden');
    startScreenSharing();
  });

  // Alternador de Modo de Visualização (Grade / Destaque)
  document.getElementById('btn-toggle-view-mode').addEventListener('click', () => {
    state.viewMode = state.viewMode === 'spotlight' ? 'grid' : 'spotlight';
    document.getElementById('view-mode-label').textContent =
      state.viewMode === 'spotlight' ? 'Modo Grade' : 'Modo Destaque';
    renderStreamsStage();
  });

  // Modal de Segurança (Lobby Host)
  document.getElementById('btn-host-security').addEventListener('click', openSecurityModal);

  // Fechar modais pelos botões [X]
  const btnCloseScreen = document.getElementById('btn-close-screen-modal');
  if (btnCloseScreen) {
    btnCloseScreen.addEventListener('click', () => {
      document.getElementById('screen-picker-modal').classList.add('hidden');
    });
  }

  const btnCloseSecurity = document.getElementById('btn-close-security-modal');
  if (btnCloseSecurity) {
    btnCloseSecurity.addEventListener('click', () => {
      document.getElementById('security-modal').classList.add('hidden');
    });
  }

  // Fechar qualquer modal ao clicar no fundo escuro (backdrop)
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.classList.add('hidden');
      }
    });
  });

  // Fechar qualquer modal ao pressionar a tecla ESC
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-overlay').forEach((m) => m.classList.add('hidden'));
    }
  });

  // Banner flutuante de aprovação rápida (Anfitrião)
  const btnAlertApprove = document.getElementById('btn-alert-approve');
  if (btnAlertApprove) {
    btnAlertApprove.addEventListener('click', () => {
      if (state.incomingGuest) {
        state.socket.emit('approve-guest', { guestSocketId: state.incomingGuest.socketId });
        state.waitingQueue.delete(state.incomingGuest.socketId);
        state.incomingGuest = null;
        document.getElementById('lobby-incoming-alert').classList.add('hidden');
        updateLobbyUI();
        showToast('Amigo aprovado na transmissão!', 'success');
      }
    });
  }

  const btnAlertReject = document.getElementById('btn-alert-reject');
  if (btnAlertReject) {
    btnAlertReject.addEventListener('click', () => {
      if (state.incomingGuest) {
        state.socket.emit('reject-guest', { guestSocketId: state.incomingGuest.socketId });
        state.waitingQueue.delete(state.incomingGuest.socketId);
        state.incomingGuest = null;
        document.getElementById('lobby-incoming-alert').classList.add('hidden');
        updateLobbyUI();
        showToast('Entrada recusada.', 'normal');
      }
    });
  }
}

// ==========================================
// ENTRADA NA SALA
// ==========================================
function enterRoom(data) {
  state.roomId = data.roomId;
  state.roomName = data.roomName;
  state.isHost = data.isHost;

  const newUrl = `${window.location.origin}${window.location.pathname}?room=${data.roomId}`;
  window.history.pushState({ path: newUrl }, '', newUrl);

  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app-container').classList.remove('hidden');
  document.getElementById('stream-title-display').textContent = state.roomName;

  if (state.isHost) {
    document.getElementById('btn-host-security').classList.remove('hidden');
  }

  if (data.existingMembers) {
    data.existingMembers.forEach((m) => {
      state.members.set(m.socketId, m);
      // Estabelece conexões P2P com todos já na sala
      createPeerConnection(m.socketId, true);
    });
  }

  updateViewersCount();
  renderStreamsStage();
  showToast(`Conectado à sala!`, 'success');
}

// ==========================================
// TRANSMISSÃO DE TELA A 60 FPS COM ÁUDIO
// ==========================================
async function startScreenSharing() {
  let videoConstraints = {
    frameRate: { ideal: 60, max: 60 }
  };

  if (state.selectedQuality === '4k60') {
    videoConstraints.width = { ideal: 3840 };
    videoConstraints.height = { ideal: 2160 };
  } else if (state.selectedQuality === '1080p60') {
    videoConstraints.width = { ideal: 1920 };
    videoConstraints.height = { ideal: 1080 };
  } else {
    videoConstraints.width = { ideal: 1280 };
    videoConstraints.height = { ideal: 720 };
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: videoConstraints,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    state.localScreenStream = stream;
    state.isStreaming = true;

    // Configura contentHint 'motion' para priorizar 60 FPS e detalhe máximo
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'motion';
    }

    // Registra a tela local no mapa de transmissões ativas
    state.activeStreams.set(state.socket.id, {
      stream,
      username: `${state.username} (Você)`,
      isLocal: true,
      volume: 1,
      isMuted: true // Mudo localmente para não dar eco para si mesmo
    });

    state.selectedSpotlightId = state.socket.id;

    // Atualiza botão do topo
    const btn = document.getElementById('btn-toggle-screen');
    btn.classList.remove('btn-green');
    btn.classList.add('btn-danger');
    document.getElementById('screen-btn-label').textContent = 'Parar Minha Tela';

    // Se o usuário parar pela barra nativa do navegador
    stream.getVideoTracks()[0].onended = () => {
      stopScreenSharing();
    };

    // Adiciona as faixas de vídeo e áudio a todas as conexões P2P
    state.peers.forEach((pc, targetSocketId) => {
      stream.getTracks().forEach((track) => pc.addTrack(track, stream));
      createAndSendOffer(pc, targetSocketId);
    });

    state.socket.emit('update-user-state', { isScreenSharing: true });
    renderStreamsStage();
    showToast('Você começou a transmitir a 60 FPS!', 'success');
  } catch (err) {
    console.error('Erro ao compartilhar tela:', err);
    showToast('Transmissão de tela cancelada.', 'normal');
  }
}

function stopScreenSharing() {
  if (state.localScreenStream) {
    state.localScreenStream.getTracks().forEach((track) => track.stop());
    state.localScreenStream = null;
  }
  state.isStreaming = false;

  state.activeStreams.delete(state.socket.id);
  if (state.selectedSpotlightId === state.socket.id) {
    state.selectedSpotlightId = state.activeStreams.keys().next().value || null;
  }

  const btn = document.getElementById('btn-toggle-screen');
  btn.classList.remove('btn-danger');
  btn.classList.add('btn-green');
  document.getElementById('screen-btn-label').textContent = 'Transmitir Minha Tela';

  state.socket.emit('update-user-state', { isScreenSharing: false });
  renderStreamsStage();
  showToast('Você encerrou sua transmissão.', 'normal');
}

// ==========================================
// RENDERIZAÇÃO MULTI-STREAM (DESTAQUE / GRADE)
// ==========================================
function renderStreamsStage() {
  const container = document.getElementById('streams-container');
  const placeholder = document.getElementById('no-stream-placeholder');
  const viewModeBtn = document.getElementById('btn-toggle-view-mode');
  const liveIndicator = document.getElementById('live-indicator');
  const liveText = document.getElementById('live-text');

  container.innerHTML = '';
  const totalStreams = state.activeStreams.size;

  if (totalStreams === 0) {
    placeholder.classList.remove('hidden');
    viewModeBtn.classList.add('hidden');
    liveIndicator.style.backgroundColor = '#4e5058';
    liveText.textContent = 'SEM TRANSMISSÃO';
    return;
  }

  placeholder.classList.add('hidden');
  liveIndicator.style.backgroundColor = 'var(--status-red)';
  liveText.textContent = 'AO VIVO';

  // Se houver 2 ou mais telas, libera o botão de alternar entre Grade e Destaque
  if (totalStreams >= 2) {
    viewModeBtn.classList.remove('hidden');
  } else {
    viewModeBtn.classList.add('hidden');
  }

  // 1. MODO GRADE (SIDE-BY-SIDE / GRID)
  if (state.viewMode === 'grid' && totalStreams >= 2) {
    container.className = 'streams-container mode-grid';
    state.activeStreams.forEach((streamData, socketId) => {
      container.appendChild(createStreamCard(streamData, socketId));
    });
    return;
  }

  // 2. MODO DESTAQUE (SPOTLIGHT COM MINIATURAS)
  container.className = 'streams-container mode-spotlight';

  // Se a tela selecionada não existir mais, pega a primeira disponível
  if (!state.selectedSpotlightId || !state.activeStreams.has(state.selectedSpotlightId)) {
    state.selectedSpotlightId = state.activeStreams.keys().next().value;
  }

  const activeSpotlight = state.activeStreams.get(state.selectedSpotlightId);

  // Palco principal da tela em destaque
  const spotlightMain = document.createElement('div');
  spotlightMain.className = 'spotlight-main';
  spotlightMain.appendChild(createStreamCard(activeSpotlight, state.selectedSpotlightId));
  container.appendChild(spotlightMain);

  // Se houver mais de 1 tela ativa, renderiza as miniaturas clicáveis abaixo
  if (totalStreams >= 2) {
    const thumbsStrip = document.createElement('div');
    thumbsStrip.className = 'spotlight-thumbnails';

    state.activeStreams.forEach((streamData, socketId) => {
      const thumb = document.createElement('div');
      thumb.className = `thumb-card ${socketId === state.selectedSpotlightId ? 'active' : ''}`;
      thumb.title = `Clique para colocar ${streamData.username} em destaque`;

      const thumbVideo = document.createElement('video');
      thumbVideo.srcObject = streamData.stream;
      thumbVideo.autoplay = true;
      thumbVideo.playsInline = true;
      thumbVideo.muted = true; // Miniaturas sempre mudas
      thumb.appendChild(thumbVideo);

      const label = document.createElement('span');
      label.className = 'thumb-label';
      label.textContent = streamData.username;
      thumb.appendChild(label);

      thumb.addEventListener('click', () => {
        state.selectedSpotlightId = socketId;
        renderStreamsStage();
      });

      thumbsStrip.appendChild(thumb);
    });

    container.appendChild(thumbsStrip);
  }
}

// Construtor do card de vídeo completo com controles independentes
function createStreamCard(data, socketId) {
  const card = document.createElement('div');
  card.className = 'stream-card';
  card.id = `stream-card-${socketId}`;

  // Indicador de carregamento suave
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'stream-loading-indicator';
  loadingIndicator.innerHTML = `
    <div class="stream-spinner"></div>
    <span>Conectando transmissão 60 FPS...</span>
  `;
  card.appendChild(loadingIndicator);

  const video = document.createElement('video');
  video.srcObject = data.stream;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', 'true');
  video.setAttribute('webkit-playsinline', 'true');
  video.setAttribute('autoplay', 'true');

  // Remove o carregamento assim que o primeiro frame renderizar
  const handlePlaying = () => {
    loadingIndicator.style.opacity = '0';
    setTimeout(() => {
      if (loadingIndicator.parentNode) loadingIndicator.remove();
    }, 250);
  };

  video.addEventListener('playing', handlePlaying);
  video.addEventListener('loadeddata', handlePlaying);

  // Inicialização segura de reprodução (Evita tela preta por restrição de autoplay)
  const attemptPlay = async () => {
    if (data.isLocal) {
      video.muted = true;
      try {
        await video.play();
      } catch (e) {
        console.warn('Erro ao reproduzir stream local:', e);
      }
      return;
    }

    try {
      // 1. Tenta reproduzir com áudio normalmente
      video.muted = !!data.isMuted;
      video.volume = data.volume !== undefined ? data.volume : 1;
      await video.play();
    } catch (err) {
      console.warn('[Limbo Tela] Autoplay com áudio bloqueado pela política do navegador. Iniciando com vídeo mudo...', err);
      // 2. Se o navegador bloqueou o áudio, forçamos mudo temporário para a imagem APARECER IMEDIATAMENTE (nunca fica preto!)
      try {
        video.muted = true;
        await video.play();
        showAudioUnlockOverlay(card, video, data);
      } catch (err2) {
        console.error('[Limbo Tela] Falha crítica ao iniciar vídeo:', err2);
      }
    }
  };

  video.addEventListener('loadedmetadata', attemptPlay);
  video.addEventListener('canplay', attemptPlay);
  attemptPlay();

  card.appendChild(video);

  // Overlay com controles
  const overlay = document.createElement('div');
  overlay.className = 'stream-overlay';
  overlay.innerHTML = `
    <div class="overlay-top">
      <div class="stream-author-badge">
        <strong>${data.username}</strong>
        <span class="badge-stream-fps">60 FPS</span>
      </div>
    </div>
    <div class="overlay-bottom">
      <div class="player-audio-controls ${data.isLocal ? 'hidden' : ''}">
        <button class="player-icon-btn btn-stream-mute" title="Mutar/Desmutar som do jogo">
          <svg class="icon-unmuted" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
          </svg>
        </button>
        <input type="range" class="player-volume-slider" min="0" max="100" value="${(data.volume !== undefined ? data.volume : 1) * 100}">
      </div>
      <div class="player-right-btns">
        <button class="player-action-btn btn-stream-pip" title="Janela Flutuante (PiP)">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 11h-8v6h8v-6zm4 8V4.98C23 3.88 22.1 3 21 3H3c-1.1 0-2 .88-2 1.98V19c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2zm-2 .02H3V4.97h18v14.05z"/>
          </svg>
        </button>
        <button class="player-action-btn btn-stream-fullscreen" title="Tela Cheia">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>
          </svg>
        </button>
      </div>
    </div>
  `;

  // Eventos de Áudio específicos desta transmissão
  const slider = overlay.querySelector('.player-volume-slider');
  const muteBtn = overlay.querySelector('.btn-stream-mute');

  if (slider && !data.isLocal) {
    slider.addEventListener('input', () => {
      video.volume = slider.value / 100;
      data.volume = video.volume;
      video.muted = video.volume === 0;
      data.isMuted = video.muted;
    });
  }

  if (muteBtn && !data.isLocal) {
    muteBtn.addEventListener('click', () => {
      video.muted = !video.muted;
      data.isMuted = video.muted;
    });
  }

  // Tela cheia e PiP
  const fsBtn = overlay.querySelector('.btn-stream-fullscreen');
  const pipBtn = overlay.querySelector('.btn-stream-pip');

  const toggleFs = () => {
    if (!document.fullscreenElement) {
      card.requestFullscreen().catch((err) => console.log(err));
    } else {
      document.exitFullscreen();
    }
  };

  fsBtn.addEventListener('click', toggleFs);
  card.addEventListener('dblclick', toggleFs);

  pipBtn.addEventListener('click', async () => {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      }
    } catch (e) {
      console.log('PiP indisponível:', e);
    }
  });

  card.appendChild(overlay);
  return card;
}

function showAudioUnlockOverlay(card, video, data) {
  if (card.querySelector('.audio-unlock-hint')) return;
  const hint = document.createElement('div');
  hint.className = 'audio-unlock-hint';
  hint.innerHTML = `
    <button class="btn-unlock-sound" title="Clique para ativar o áudio do jogo">
      <span>🔊 Clique para ativar som</span>
    </button>
  `;
  const btn = hint.querySelector('.btn-unlock-sound');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    video.muted = false;
    video.volume = data.volume !== undefined ? data.volume : 1;
    data.isMuted = false;
    hint.remove();
  });
  card.appendChild(hint);
}

// Ativar áudio automaticamente ao primeiro clique do usuário em qualquer lugar da tela
window.addEventListener('click', () => {
  document.querySelectorAll('.stream-card video').forEach((v) => {
    if (v.muted) {
      const card = v.closest('.stream-card');
      const socketId = card ? card.id.replace('stream-card-', '') : null;
      const streamData = socketId ? state.activeStreams.get(socketId) : null;
      if (streamData && !streamData.isLocal && !streamData.isMuted) {
        v.muted = false;
        v.volume = streamData.volume !== undefined ? streamData.volume : 1;
        const hint = card ? card.querySelector('.audio-unlock-hint') : null;
        if (hint) hint.remove();
      }
    }
  });
});

// ==========================================
// WEBRTC P2P BIDIRECIONAL
// ==========================================
function createPeerConnection(targetSocketId, isInitiator) {
  if (state.peers.has(targetSocketId)) return state.peers.get(targetSocketId);

  const pc = new RTCPeerConnection(RTC_CONFIG);
  state.peers.set(targetSocketId, pc);

  // Se o usuário local já estiver transmitindo tela, anexa as faixas
  if (state.localScreenStream) {
    state.localScreenStream.getTracks().forEach((track) => {
      pc.addTrack(track, state.localScreenStream);
    });
  }

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      state.socket.emit('webrtc-ice-candidate', {
        targetSocketId,
        candidate: event.candidate
      });
    }
  };

  // Quando receber tela de um amigo
  pc.ontrack = (event) => {
    let remoteStream = event.streams && event.streams[0];
    if (!remoteStream) {
      remoteStream = new MediaStream([event.track]);
    }

    const member = state.members.get(targetSocketId);
    const username = member ? member.username : 'Amigo';

    state.activeStreams.set(targetSocketId, {
      stream: remoteStream,
      username,
      isLocal: false,
      volume: 1,
      isMuted: false
    });

    if (!state.selectedSpotlightId) {
      state.selectedSpotlightId = targetSocketId;
    }

    renderStreamsStage();
    showToast(`${username} começou a transmitir tela!`, 'success');
  };

  if (isInitiator) {
    createAndSendOffer(pc, targetSocketId);
  }

  return pc;
}

// Injeção de bitrate no SDP para transmissões em 4K e 1080p a 60 FPS
function boostSdpBitrate(sdp, quality) {
  let bitrateKbps = 14000; // 14 Mbps padrão para 1080p60
  if (quality === '4k60') bitrateKbps = 32000; // 32 Mbps para 4K Ultra HD cristalino!
  else if (quality === '720p60') bitrateKbps = 6000;

  let modified = sdp;
  if (modified.indexOf('b=AS:') >= 0) {
    modified = modified.replace(/b=AS:\d+/g, `b=AS:${bitrateKbps}`);
  } else {
    modified = modified.replace(/m=video ([^\r\n]+)\r\n/g, `m=video $1\r\nb=AS:${bitrateKbps}\r\nb=TIAS:${bitrateKbps * 1000}\r\n`);
  }

  modified = modified.replace(
    /(a=fmtp:\d+ [^\r\n]+)/g,
    `$1;x-google-max-bitrate=${bitrateKbps};x-google-min-bitrate=6000;x-google-start-bitrate=${Math.floor(bitrateKbps / 2)}`
  );

  return modified;
}

function applyHighBitrateSettings(pc) {
  try {
    if (pc.setCodecPreferences && RTCRtpSender.getCapabilities) {
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps && caps.codecs) {
        const h264 = caps.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
        const others = caps.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');
        if (h264.length > 0) {
          pc.getTransceivers().forEach(t => {
            if (t.sender && t.sender.track && t.sender.track.kind === 'video') {
              t.setCodecPreferences([...h264, ...others]);
            }
          });
        }
      }
    }
  } catch (e) {
    console.warn('Codec preferences:', e);
  }

  try {
    let targetBitrate = 14000000;
    if (state.selectedQuality === '4k60') targetBitrate = 32000000;
    else if (state.selectedQuality === '720p60') targetBitrate = 6000000;

    pc.getSenders().forEach((sender) => {
      if (sender.track && sender.track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
          params.encodings = [{}];
        }
        params.encodings[0].maxBitrate = targetBitrate;
        params.encodings[0].maxFramerate = 60;
        params.encodings[0].networkPriority = 'high';
        params.encodings[0].priority = 'high';
        sender.setParameters(params).catch(() => {});
      }
    });
  } catch (e) {
    console.warn('SetParameters bitrate:', e);
  }
}

async function createAndSendOffer(pc, targetSocketId) {
  try {
    applyHighBitrateSettings(pc);
    const offer = await pc.createOffer();
    const boostedSdp = boostSdpBitrate(offer.sdp, state.selectedQuality);
    const boostedOffer = new RTCSessionDescription({ type: offer.type, sdp: boostedSdp });
    await pc.setLocalDescription(boostedOffer);
    state.socket.emit('webrtc-offer', {
      targetSocketId,
      offer: boostedOffer
    });
  } catch (err) {
    console.error('Erro na oferta:', err);
  }
}

async function handleWebRTCOffer({ senderSocketId, offer }) {
  const pc = createPeerConnection(senderSocketId, false);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    applyHighBitrateSettings(pc);
    const answer = await pc.createAnswer();
    const boostedSdp = boostSdpBitrate(answer.sdp, state.selectedQuality);
    const boostedAnswer = new RTCSessionDescription({ type: answer.type, sdp: boostedSdp });
    await pc.setLocalDescription(boostedAnswer);
    state.socket.emit('webrtc-answer', {
      targetSocketId: senderSocketId,
      answer: boostedAnswer
    });
  } catch (err) {
    console.error('Erro ao processar oferta:', err);
  }
}

async function handleWebRTCAnswer({ senderSocketId, answer }) {
  const pc = state.peers.get(senderSocketId);
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error('Erro na resposta:', err);
    }
  }
}

async function handleWebRTCIceCandidate({ senderSocketId, candidate }) {
  const pc = state.peers.get(senderSocketId);
  if (pc && candidate) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Erro no ICE candidate:', err);
    }
  }
}

function closePeerConnection(socketId) {
  const pc = state.peers.get(socketId);
  if (pc) {
    pc.close();
    state.peers.delete(socketId);
  }
}

// ==========================================
// MODAL DE SEGURANÇA E LOBBY (HOST)
// ==========================================
function openSecurityModal() {
  const modal = document.getElementById('security-modal');
  modal.classList.remove('hidden');
  updateLobbyUI();

  const membersList = document.getElementById('security-members-list');
  membersList.innerHTML = '';

  state.members.forEach((member) => {
    const item = document.createElement('div');
    item.className = 'security-member-item';
    item.innerHTML = `
      <span>${member.username}</span>
      <button class="btn btn-danger btn-small">Expulsar</button>
    `;
    item.querySelector('button').addEventListener('click', () => {
      state.socket.emit('kick-member', { targetSocketId: member.socketId });
      item.remove();
    });
    membersList.appendChild(item);
  });
}

function updateLobbyUI() {
  const queueList = document.getElementById('lobby-queue-list');
  if (!queueList) return;

  queueList.innerHTML = '';
  if (state.waitingQueue.size === 0) {
    queueList.innerHTML = '<p class="empty-notice">Nenhum convidado aguardando no momento.</p>';
  } else {
    state.waitingQueue.forEach((guest) => {
      const item = document.createElement('div');
      item.className = 'lobby-item';
      item.innerHTML = `
        <strong>${guest.username}</strong>
        <div class="lobby-item-actions">
          <button class="btn btn-green btn-small btn-approve">Permitir</button>
          <button class="btn btn-danger btn-small btn-reject">Recusar</button>
        </div>
      `;
      item.querySelector('.btn-approve').addEventListener('click', () => {
        state.socket.emit('approve-guest', { guestSocketId: guest.socketId });
        state.waitingQueue.delete(guest.socketId);
        updateLobbyUI();
      });
      item.querySelector('.btn-reject').addEventListener('click', () => {
        state.socket.emit('reject-guest', { guestSocketId: guest.socketId });
        state.waitingQueue.delete(guest.socketId);
        updateLobbyUI();
      });
      queueList.appendChild(item);
    });
  }
}

function updateViewersCount() {
  const total = state.members.size + 1;
  document.getElementById('viewers-count').textContent =
    total === 1 ? '1 conectado' : `${total} conectados`;
}

function copyInviteLink() {
  const link = `${window.location.origin}${window.location.pathname}?room=${state.roomId}`;
  navigator.clipboard.writeText(link).then(() => {
    showToast('Link da sala copiado!', 'success');
  }).catch(() => {
    prompt('Envie este link aos seus amigos:', link);
  });
}

function leaveRoom() {
  if (state.localScreenStream) stopScreenSharing();
  state.peers.forEach((pc) => pc.close());
  state.peers.clear();
  window.location.href = window.location.origin + window.location.pathname;
}

function showToast(text, type = 'normal') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'success' ? 'toast-success' : type === 'error' ? 'toast-error' : ''}`;
  toast.textContent = text;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
