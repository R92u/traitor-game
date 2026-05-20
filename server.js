const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ─── STATE ──────────────────────────────────────────
const lobbies = {};

function makeLobby(hostName, hostSocketId) {
  const code = Math.random().toString(36).slice(2,7).toUpperCase();
  return {
    code,
    hostId: hostSocketId,
    hostName,
    word: '',
    theme: '',
    traitorId: null,
    state: 'waiting',
    players: [],
    revealQueue: [],
    revealIndex: 0,
    turnOrder: [],          // PATCH: separate turn order for the game
    currentTurnIndex: 0,
    round: 1,
    maxTurns: 3,
    turnsUsed: {},
    votes: {},
    voteUsed: false,
    voteTimer: null,
    voteEndTime: null,
    guessing: false,
    guessText: '',
    rolesSeen: {},
    hintUsed: false,
    hintLetter: '',         // PATCH 2: store hint letter so traitor can see it again
    createdAt: Date.now(),
  };
}

function playerList(lobby) {
  return lobby.players.map(p => ({
    id: p.id,
    socketId: p.socketId,
    name: p.name,
    score: p.score,
    alive: p.alive,
    isHost: p.socketId === lobby.hostId,
    turnsUsed: lobby.turnsUsed[p.socketId] || 0,
  }));
}

function broadcast(lobby) {
  const currentReveal = lobby.revealQueue && lobby.revealQueue[lobby.revealIndex];
  io.to(lobby.code).emit('lobby:update', {
    code: lobby.code,
    hostName: lobby.hostName,
    state: lobby.state,
    players: playerList(lobby),
    turnOrder: lobby.turnOrder ? lobby.turnOrder.map(p => p.id) : [], // PATCH: send turn order IDs
    currentTurnIndex: lobby.currentTurnIndex,
    round: lobby.round,
    traitorId: lobby.traitorId,
    secretWord: lobby.word,
    theme: lobby.theme,
    maxTurns: lobby.maxTurns,
    voteUsed: lobby.voteUsed,
    guessing: lobby.guessing,
    guessText: lobby.guessText,
    hintUsed: lobby.hintUsed,
    currentRevealId: currentReveal?.socketId || null,
    currentRevealName: currentReveal?.name || null,
    revealIndex: lobby.revealIndex,
    revealTotal: lobby.revealQueue?.length || 0,
    rolesSeen: lobby.rolesSeen || {},
  });
}

function cleanupOldLobbies() {
  const cutoff = Date.now() - 3 * 60 * 60 * 1000;
  for (const code of Object.keys(lobbies)) {
    if (lobbies[code].createdAt < cutoff) delete lobbies[code];
  }
}
setInterval(cleanupOldLobbies, 30 * 60 * 1000);

// ─── HELPERS ────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// PATCH 2: Weighted shuffle - traitor much less likely to be first
function weightedShuffle(arr, traitorId) {
  // First, do normal shuffle
  const shuffled = shuffle([...arr]);
  
  // If traitor ended up in first position, with high probability swap them
  // Effectively reducing traitor's chance of going first to ~15-20%
  if (shuffled[0]?.id === traitorId && shuffled.length > 1) {
    // 80% chance to move traitor away from position 0
    if (Math.random() < 0.8) {
      // Move traitor to a random non-first position
      const traitor = shuffled.shift();
      const newPos = 1 + Math.floor(Math.random() * shuffled.length);
      shuffled.splice(newPos, 0, traitor);
    }
  }
  
  return shuffled;
}

function advanceReveal(lobby) {
  const p = lobby.revealQueue[lobby.revealIndex];
  if (!p) return;
  const isTraitor = p.id === lobby.traitorId;
  io.to(p.socketId).emit('game:yourRole', {
    isTraitor,
    word: isTraitor ? null : lobby.word,
    playerIndex: lobby.revealIndex,
    totalPlayers: lobby.revealQueue.length,
  });
  io.to(lobby.code).emit('reveal:nextPlayer', { name: p.name });
}

function getGameParticipants(lobby) {
  return lobby.players.filter(p => p.socketId !== lobby.hostId);
}

function checkAllTurnsUsed(lobby) {
  const participants = getGameParticipants(lobby).filter(p => p.alive);
  return participants.every(p => (lobby.turnsUsed[p.socketId] || 0) >= lobby.maxTurns);
}

// PATCH 3: 30-second vote timer
function startVoteTimer(lobby) {
  if (lobby.voteTimer) clearTimeout(lobby.voteTimer);
  lobby.voteEndTime = Date.now() + 30000;
  
  io.to(lobby.code).emit('vote:started', {
    endTime: lobby.voteEndTime,
  });
  
  lobby.voteTimer = setTimeout(() => {
    resolveVote(lobby);
  }, 30000);
}

function resolveVote(lobby) {
  if (lobby.voteTimer) {
    clearTimeout(lobby.voteTimer);
    lobby.voteTimer = null;
  }
  
  const tally = {};
  for (const targetId of Object.values(lobby.votes)) {
    tally[targetId] = (tally[targetId] || 0) + 1;
  }
  
  let maxVotes = 0, eliminatedId = null;
  for (const [id, count] of Object.entries(tally)) {
    if (count > maxVotes) { maxVotes = count; eliminatedId = id; }
  }

  const isCorrect = eliminatedId === lobby.traitorId;
  
  // PATCH 3: Game ends after vote regardless
  lobby.state = 'ended';
  
  if (isCorrect) {
    // Players win
    lobby.players.forEach(p => { 
      if (p.id !== lobby.traitorId && p.socketId !== lobby.hostId) p.score++; 
    });
    io.to(lobby.code).emit('vote:result', { correct: true, eliminatedId, tally, word: lobby.word });
    io.to(lobby.code).emit('game:end', {
      winner: 'players',
      reason: 'vote',
      word: lobby.word,
      traitorId: lobby.traitorId,
      players: playerList(lobby),
    });
  } else {
    // Traitor wins
    const traitor = lobby.players.find(p => p.id === lobby.traitorId);
    if (traitor) traitor.score += 2;
    io.to(lobby.code).emit('vote:result', { correct: false, eliminatedId, tally, word: lobby.word });
    io.to(lobby.code).emit('game:end', {
      winner: 'traitor',
      reason: 'vote',
      word: lobby.word,
      traitorId: lobby.traitorId,
      players: playerList(lobby),
    });
  }
  
  broadcast(lobby);
  io.emit('lobbies:changed');
}

// ─── SOCKET EVENTS ──────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ connect', socket.id);

  socket.on('lobbies:list', (cb) => {
    const list = Object.values(lobbies)
      .filter(l => l.state === 'waiting')
      .map(l => ({
        code: l.code,
        hostName: l.hostName,
        state: l.state,
        playerCount: l.players.length,
      }));
    cb({ lobbies: list });
  });

  socket.on('lobby:create', ({ name }, cb) => {
    const lobby = makeLobby(name, socket.id);
    lobbies[lobby.code] = lobby;
    const me = { id: socket.id, name, socketId: socket.id, score: 0, alive: true };
    lobby.players.push(me);
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;
    socket.data.name = name;
    cb({ ok: true, code: lobby.code, isHost: true });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  socket.on('lobby:join', ({ code, name }, cb) => {
    const lobby = lobbies[code?.toUpperCase()];
    if (!lobby) return cb({ ok: false, error: 'Лобби не найдено' });
    if (lobby.state !== 'waiting') return cb({ ok: false, error: 'Игра уже началась' });
    if (lobby.players.find(p => p.name.toLowerCase() === name.toLowerCase()))
      return cb({ ok: false, error: 'Имя занято' });

    const me = { id: socket.id, name, socketId: socket.id, score: 0, alive: true };
    lobby.players.push(me);
    socket.join(lobby.code);
    socket.data.lobbyCode = code.toUpperCase();
    socket.data.name = name;
    cb({ ok: true, code: lobby.code, isHost: false });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  // PATCH 1: Accept theme. PATCH 2: Weighted shuffle for traitor.
  socket.on('game:start', ({ word, traitorId, maxTurns, theme }, cb) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return cb?.({ ok: false });
    if (!word) return cb?.({ ok: false, error: 'Введи слово' });
    if (!traitorId) return cb?.({ ok: false, error: 'Выбери предателя' });
    
    const gameParticipants = lobby.players.filter(p => p.socketId !== lobby.hostId);
    if (gameParticipants.length < 2) return cb?.({ ok: false, error: 'Минимум 2 игрока (не считая ведущего)' });

    lobby.word = word;
    lobby.theme = theme || '';
    lobby.traitorId = traitorId;
    lobby.maxTurns = parseInt(maxTurns) || 3;
    lobby.state = 'revealing';
    
    // Reveal order - simple random shuffle
    lobby.revealQueue = shuffle([...gameParticipants]);
    
    // PATCH 2: Turn order - weighted shuffle so traitor less likely to go first
    lobby.turnOrder = weightedShuffle([...gameParticipants], traitorId);
    console.log('Turn order:', lobby.turnOrder.map(p => p.name + (p.id===traitorId?' (TRAITOR)':'')));
    
    lobby.revealIndex = 0;
    lobby.currentTurnIndex = 0;
    lobby.round = 1;
    lobby.turnsUsed = {};
    lobby.votes = {};
    lobby.voteUsed = false;
    lobby.guessing = false;
    lobby.guessText = '';
    lobby.rolesSeen = {};
    lobby.hintUsed = false;
    lobby.hintLetter = '';
    lobby.players.forEach(p => { p.alive = true; });

    cb?.({ ok: true });
    broadcast(lobby);
    io.emit('lobbies:changed');
    advanceReveal(lobby);
  });

  socket.on('game:roleSeen', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'revealing') return;
    
    // BUG FIX: Only the current player in queue can confirm
    const currentRevealPlayer = lobby.revealQueue[lobby.revealIndex];
    if (!currentRevealPlayer || currentRevealPlayer.socketId !== socket.id) {
      console.log('Wrong player trying to confirm role');
      return;
    }
    
    // Mark as seen
    if (!lobby.rolesSeen) lobby.rolesSeen = {};
    lobby.rolesSeen[socket.id] = true;
    
    lobby.revealIndex++;
    if (lobby.revealIndex >= lobby.revealQueue.length) {
      lobby.state = 'playing';
      broadcast(lobby);
    } else {
      advanceReveal(lobby);
      broadcast(lobby);
    }
  });

  // PATCH 1: Next turn with turn counting (uses turnOrder)
  socket.on('game:nextTurn', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    
    // Use saved turnOrder, filter to alive only
    const aliveTurnOrder = lobby.turnOrder.filter(p => {
      const player = lobby.players.find(pp => pp.id === p.id);
      return player && player.alive;
    });
    if (aliveTurnOrder.length === 0) return;
    
    const curr = aliveTurnOrder[lobby.currentTurnIndex % aliveTurnOrder.length];
    
    if (socket.id !== lobby.hostId && socket.id !== curr?.socketId) return;
    
    // Increment turn count for current player
    if (curr) {
      lobby.turnsUsed[curr.socketId] = (lobby.turnsUsed[curr.socketId] || 0) + 1;
    }
    
    // Check if all turns are used
    if (checkAllTurnsUsed(lobby)) {
      const traitor = lobby.players.find(p => p.id === lobby.traitorId);
      if (traitor) traitor.score += 2;
      lobby.state = 'ended';
      io.to(lobby.code).emit('game:end', {
        winner: 'traitor',
        reason: 'turns_ended',
        word: lobby.word,
        traitorId: lobby.traitorId,
        players: playerList(lobby),
      });
      broadcast(lobby);
      io.emit('lobbies:changed');
      return;
    }
    
    // Move to next player who still has turns
    let nextIndex = (lobby.currentTurnIndex + 1) % aliveTurnOrder.length;
    let attempts = 0;
    while (attempts < aliveTurnOrder.length) {
      const nextPlayer = aliveTurnOrder[nextIndex];
      if ((lobby.turnsUsed[nextPlayer.socketId] || 0) < lobby.maxTurns) {
        break;
      }
      nextIndex = (nextIndex + 1) % aliveTurnOrder.length;
      attempts++;
    }
    
    lobby.currentTurnIndex = nextIndex;
    if (lobby.currentTurnIndex === 0) lobby.round++;
    broadcast(lobby);
  });

  // PATCH 3: Start vote (only once per game)
  socket.on('game:startVote', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (lobby.voteUsed) return; // already used
    
    lobby.voteUsed = true;
    lobby.state = 'voting';
    lobby.votes = {};
    
    broadcast(lobby);
    startVoteTimer(lobby);
  });

  socket.on('game:vote', ({ targetId }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'voting') return;
    if (socket.id === lobby.hostId) return;
    // BUG FIX: Traitor can't vote
    if (socket.id === lobby.traitorId) return;
    
    lobby.votes[socket.id] = targetId;

    // Voters = alive players, not host, not traitor
    const voters = lobby.players.filter(p => 
      p.alive && 
      p.socketId !== lobby.hostId && 
      p.id !== lobby.traitorId
    );
    const voteCount = Object.keys(lobby.votes).length;

    io.to(lobby.code).emit('vote:progress', {
      voted: voteCount,
      total: voters.length,
    });

    if (voteCount >= voters.length) {
      resolveVote(lobby);
    }
  });

  // PATCH 3: Traitor uses hint to see first letter
  socket.on('game:useHint', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (socket.id !== lobby.traitorId) return;
    if (lobby.hintUsed) return;
    
    lobby.hintUsed = true;
    const firstLetter = lobby.word.charAt(0).toUpperCase();
    lobby.hintLetter = firstLetter;  // PATCH 2: store letter
    
    // Send hint only to traitor
    io.to(socket.id).emit('game:hintReceived', {
      firstLetter,
    });
    
    broadcast(lobby);
  });

  // PATCH 3: Traitor starts guessing - all players see it live
  socket.on('game:startGuessing', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (socket.id !== lobby.traitorId) return;
    
    lobby.guessing = true;
    lobby.guessText = '';
    lobby.state = 'guessing';
    broadcast(lobby);
    
    io.to(lobby.code).emit('guess:started', {
      traitorName: lobby.players.find(p => p.id === socket.id)?.name,
    });
  });

  // PATCH 4: Traitor typing - broadcast to all
  socket.on('game:guessTyping', ({ text }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'guessing') return;
    if (socket.id !== lobby.traitorId) return;
    
    lobby.guessText = text;
    io.to(lobby.code).emit('guess:typing', { text });
  });

  // PATCH 4: Traitor submits guess
  socket.on('game:guessWord', ({ guess }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'guessing') return;
    if (socket.id !== lobby.traitorId) return;

    const isCorrect = guess.toLowerCase().trim() === lobby.word.toLowerCase().trim();
    const traitorName = lobby.players.find(p => p.id === socket.id)?.name;
    
    lobby.guessing = false;
    lobby.state = 'ended';
    
    if (isCorrect) {
      const traitor = lobby.players.find(p => p.id === lobby.traitorId);
      if (traitor) traitor.score += 2;
      io.to(lobby.code).emit('game:end', {
        winner: 'traitor',
        reason: 'guess_correct',
        word: lobby.word,
        guess,
        traitorName,
        traitorId: lobby.traitorId,
        players: playerList(lobby),
      });
    } else {
      lobby.players.forEach(p => { 
        if (p.id !== lobby.traitorId && p.socketId !== lobby.hostId) p.score++; 
      });
      io.to(lobby.code).emit('game:end', {
        winner: 'players',
        reason: 'guess_wrong',
        word: lobby.word,
        guess,
        traitorName,
        traitorId: lobby.traitorId,
        players: playerList(lobby),
      });
    }
    
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  // PATCH 5: Play again - keep scores, back to lobby
  socket.on('game:playAgain', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    
    // Reset game state but keep scores
    lobby.state = 'waiting';
    lobby.word = '';
    lobby.theme = '';
    lobby.traitorId = null;
    lobby.turnsUsed = {};
    lobby.votes = {};
    lobby.voteUsed = false;
    lobby.guessing = false;
    lobby.guessText = '';
    lobby.hintUsed = false;
    lobby.players.forEach(p => { p.alive = true; });
    
    broadcast(lobby);
    io.emit('lobbies:changed');
    io.to(lobby.code).emit('game:backToLobby');
  });

  socket.on('disconnect', () => {
    console.log('- disconnect', socket.id);
    const code = socket.data.lobbyCode;
    if (!code) return;
    const lobby = lobbies[code];
    if (!lobby) return;

    lobby.players = lobby.players.filter(p => p.socketId !== socket.id);

    if (lobby.players.length === 0) {
      if (lobby.voteTimer) clearTimeout(lobby.voteTimer);
      delete lobbies[code];
      io.emit('lobbies:changed');
      return;
    }

    if (socket.id === lobby.hostId) {
      lobby.hostId = lobby.players[0].socketId;
      lobby.hostName = lobby.players[0].name;
      io.to(lobby.hostId).emit('host:promoted');
    }

    broadcast(lobby);
    io.emit('lobbies:changed');
  });
});

server.listen(PORT, () => {
  console.log(`🕵️  Предатель server running → http://localhost:${PORT}`);
});
