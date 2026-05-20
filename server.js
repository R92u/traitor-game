/**
 * ПРЕДАТЕЛЬ — Game Server
 * Node.js + Socket.io
 *
 * Run: node server.js
 * Or:  PORT=3000 node server.js
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

// ─── Serve static files ───────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// ─── In-memory store ─────────────────────────────────
// lobbies: { [code]: LobbyObject }
const lobbies = {};

function makeLobby(hostName, hostSocketId) {
  const code = Math.random().toString(36).slice(2,7).toUpperCase();
  return {
    code,
    hostId: hostSocketId,
    hostName,
    word: '',
    traitorId: null,
    state: 'waiting',    // waiting | revealing | playing | voting | ended
    players: [],         // [{id, name, socketId, score, alive, ready}]
    revealQueue: [],     // order for role reveal
    revealIndex: 0,
    currentTurnIndex: 0,
    round: 1,
    votes: {},           // {socketId: targetSocketId}
    createdAt: Date.now(),
  };
}

function lobbyPublic(lobby) {
  return {
    code:      lobby.code,
    hostName:  lobby.hostName,
    state:     lobby.state,
    playerCount: lobby.players.length,
  };
}

function playerList(lobby) {
  return lobby.players.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    alive: p.alive,
    isHost: p.socketId === lobby.hostId,
  }));
}

function broadcast(lobby) {
  io.to(lobby.code).emit('lobby:update', {
    code:      lobby.code,
    hostName:  lobby.hostName,
    state:     lobby.state,
    players:   playerList(lobby),
    currentTurnIndex: lobby.currentTurnIndex,
    round:     lobby.round,
    traitorId: lobby.traitorId,
    secretWord: lobby.word, // host sees this
  });
}

function cleanupOldLobbies() {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000; // 3 hours
  for (const code of Object.keys(lobbies)) {
    if (lobbies[code].createdAt < cutoff) delete lobbies[code];
  }
}
setInterval(cleanupOldLobbies, 30 * 60 * 1000);

// ─── Socket events ────────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ connect', socket.id);

  // ── List lobbies ─────────────────────────────────
  socket.on('lobbies:list', (cb) => {
    const list = Object.values(lobbies)
      .filter(l => l.state === 'waiting')
      .map(lobbyPublic);
    cb({ lobbies: list });
  });

  // ── Create lobby ─────────────────────────────────
  socket.on('lobby:create', ({ name }, cb) => {
    const lobby = makeLobby(name, socket.id);
    lobbies[lobby.code] = lobby;
    const me = { id: socket.id, name, socketId: socket.id, score: 0, alive: true, ready: false };
    lobby.players.push(me);
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;
    socket.data.name = name;
    cb({ ok: true, code: lobby.code, isHost: true });
    broadcast(lobby);
    io.emit('lobbies:changed');  // notify lobby list watchers
  });

  // ── Join lobby ───────────────────────────────────
  socket.on('lobby:join', ({ code, name }, cb) => {
    const lobby = lobbies[code?.toUpperCase()];
    if (!lobby) return cb({ ok: false, error: 'Лобби не найдено' });
    if (lobby.state !== 'waiting') return cb({ ok: false, error: 'Игра уже началась' });
    if (lobby.players.find(p => p.name.toLowerCase() === name.toLowerCase()))
      return cb({ ok: false, error: 'Имя занято, выбери другое' });

    const me = { id: socket.id, name, socketId: socket.id, score: 0, alive: true, ready: false };
    lobby.players.push(me);
    socket.join(lobby.code);
    socket.data.lobbyCode = code.toUpperCase();
    socket.data.name = name;
    cb({ ok: true, code: lobby.code, isHost: false });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  // ── Set word (host only) ─────────────────────────
  socket.on('lobby:setWord', ({ word }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    lobby.word = word.trim();
  });

  // ── Set traitor (host only) ──────────────────────
  socket.on('lobby:setTraitor', ({ traitorId }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    lobby.traitorId = traitorId;
  });

  // ── Start game (host only) ───────────────────────
  socket.on('game:start', ({ word, traitorId }, cb) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return cb?.({ ok: false });
    if (!word) return cb?.({ ok: false, error: 'Введи слово' });
    if (!traitorId) return cb?.({ ok: false, error: 'Выбери предателя' });
    if (lobby.players.length < 2) return cb?.({ ok: false, error: 'Нужно минимум 2 игрока' });

    lobby.word = word;
    lobby.traitorId = traitorId;
    lobby.state = 'revealing';
    lobby.revealQueue = shuffle([...lobby.players]);
    lobby.revealIndex = 0;
    lobby.currentTurnIndex = 0;
    lobby.round = 1;
    lobby.votes = {};
    lobby.players.forEach(p => { p.alive = true; });

    cb?.({ ok: true });
    broadcast(lobby);
    io.emit('lobbies:changed');

    // Send each player their role privately
    advanceReveal(lobby);
  });

  // ── Player seen role ─────────────────────────────
  socket.on('game:roleSeen', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'revealing') return;
    lobby.revealIndex++;
    if (lobby.revealIndex >= lobby.revealQueue.length) {
      // All revealed — start game
      lobby.state = 'playing';
      broadcast(lobby);
    } else {
      advanceReveal(lobby);
      broadcast(lobby);
    }
  });

  // ── Next turn (host or current player) ─────────────
  socket.on('game:nextTurn', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    // Either host or the current player can advance turn
    const alive = lobby.players.filter(p => p.alive);
    if (alive.length === 0) return;
    const curr = alive[lobby.currentTurnIndex % alive.length];
    // Allow host or current player to end their turn
    if (socket.id !== lobby.hostId && socket.id !== curr?.socketId) return;
    
    lobby.currentTurnIndex = (lobby.currentTurnIndex + 1) % alive.length;
    if (lobby.currentTurnIndex === 0) lobby.round++;
    broadcast(lobby);
  });

  // ── Traitor guess word ─────────────────────────────
  socket.on('game:guessWord', ({ guess }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (socket.id !== lobby.traitorId) return; // only traitor can guess

    const isCorrect = guess.toLowerCase().trim() === lobby.word.toLowerCase().trim();
    const traitorName = lobby.players.find(p => p.id === socket.id)?.name;
    
    // Broadcast to all
    io.to(lobby.code).emit('game:wordGuessed', {
      traitorName,
      guess,
      correct: isCorrect,
    });

    if (isCorrect) {
      const traitor = lobby.players.find(p => p.id === lobby.traitorId);
      if (traitor) traitor.score += 2;
      lobby.state = 'ended';
      io.to(lobby.code).emit('game:end', {
        winner: 'traitor',
        word: lobby.word,
        traitorId: lobby.traitorId,
        players: playerList(lobby),
      });
      broadcast(lobby);
      io.emit('lobbies:changed');
    }
  });

  // ── Start vote (any player, with host approval could be nice) ────────────────────────────
  socket.on('game:startVote', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    // Only host can start vote (or we could allow any player - your choice)
    if (socket.id !== lobby.hostId) return;
    lobby.state = 'voting';
    lobby.votes = {};
    broadcast(lobby);
  });

  // ── Submit vote ──────────────────────────────────
  socket.on('game:vote', ({ targetId }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'voting') return;
    lobby.votes[socket.id] = targetId;

    const alive = lobby.players.filter(p => p.alive);
    const voteCount = Object.keys(lobby.votes).length;

    // Notify everyone of vote progress
    io.to(lobby.code).emit('vote:progress', {
      voted: voteCount,
      total: alive.length,
    });

    // Auto-resolve when everyone voted
    if (voteCount >= alive.length) resolveVote(lobby);
  });

  // ── Host force-resolve vote ──────────────────────
  socket.on('game:resolveVote', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    resolveVote(lobby);
  });

  // ── Traitor wins (host) ──────────────────────────
  socket.on('game:traitorWins', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    const traitor = lobby.players.find(p => p.id === lobby.traitorId);
    if (traitor) traitor.score += 2;
    lobby.state = 'ended';
    io.to(lobby.code).emit('game:end', {
      winner: 'traitor',
      word: lobby.word,
      traitorId: lobby.traitorId,
      players: playerList(lobby),
    });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  // ── Players win (host confirms traitor caught) ───
  socket.on('game:playersWin', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    lobby.players.forEach(p => { if (p.id !== lobby.traitorId) p.score++; });
    lobby.state = 'ended';
    io.to(lobby.code).emit('game:end', {
      winner: 'players',
      word: lobby.word,
      traitorId: lobby.traitorId,
      players: playerList(lobby),
    });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  // ── Play again (host) ────────────────────────────
  socket.on('game:playAgain', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    lobby.state = 'waiting';
    lobby.word = '';
    lobby.traitorId = null;
    lobby.players.forEach(p => { p.alive = true; });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  // ── Disconnect ───────────────────────────────────
  socket.on('disconnect', () => {
    console.log('- disconnect', socket.id);
    const code = socket.data.lobbyCode;
    if (!code) return;
    const lobby = lobbies[code];
    if (!lobby) return;

    lobby.players = lobby.players.filter(p => p.socketId !== socket.id);

    if (lobby.players.length === 0) {
      delete lobbies[code];
      io.emit('lobbies:changed');
      return;
    }

    // Transfer host if needed
    if (socket.id === lobby.hostId) {
      lobby.hostId = lobby.players[0].socketId;
      lobby.hostName = lobby.players[0].name;
      io.to(lobby.hostId).emit('host:promoted');
    }

    broadcast(lobby);
    io.emit('lobbies:changed');
  });
});

// ─── Helpers ─────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function advanceReveal(lobby) {
  const p = lobby.revealQueue[lobby.revealIndex];
  if (!p) return;
  const isTraitor = p.id === lobby.traitorId;
  // Send role privately to that socket
  io.to(p.socketId).emit('game:yourRole', {
    isTraitor,
    word: isTraitor ? null : lobby.word,
    playerIndex: lobby.revealIndex,
    totalPlayers: lobby.players.length,
  });
  // Tell everyone whose turn to look at phone
  io.to(lobby.code).emit('reveal:nextPlayer', { name: p.name });
}

function resolveVote(lobby) {
  // Count votes
  const tally = {};
  for (const targetId of Object.values(lobby.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }
  let maxVotes = 0, eliminatedId = null;
  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; eliminatedId = id; }
  }

  const isCorrect = eliminatedId === lobby.traitorId;
  const eliminated = lobby.players.find(p => p.id === eliminatedId);

  if (isCorrect) {
    lobby.players.forEach(p => { if (p.id !== lobby.traitorId) p.score++; });
    lobby.state = 'ended';
    io.to(lobby.code).emit('vote:result', { correct: true, eliminatedId, tally, word: lobby.word });
    io.to(lobby.code).emit('game:end', {
      winner: 'players',
      word: lobby.word,
      traitorId: lobby.traitorId,
      players: playerList(lobby),
    });
  } else {
    if (eliminated) eliminated.alive = false;
    lobby.state = 'playing';
    lobby.currentTurnIndex = 0;
    io.to(lobby.code).emit('vote:result', { correct: false, eliminatedId, tally });
  }

  broadcast(lobby);
  io.emit('lobbies:changed');
}

// ─── Start ────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`🕵️  Предатель server running → http://localhost:${PORT}`);
});
