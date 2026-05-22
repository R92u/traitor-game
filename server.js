const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// ─── FIREBASE REST API ──────────────────────────────
const FIREBASE_DB_URL = 'https://shpion-fb6cc-default-rtdb.firebaseio.com';
// Optional: secret/token for added security (set via env)
const FIREBASE_AUTH = process.env.FIREBASE_AUTH || '';

async function fbGet(path) {
  try {
    const url = `${FIREBASE_DB_URL}/${path}.json${FIREBASE_AUTH ? '?auth='+FIREBASE_AUTH : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      console.error('FB GET error:', res.status, await res.text());
      return null;
    }
    return await res.json();
  } catch (e) {
    console.error('fbGet error:', e.message);
    return null;
  }
}

async function fbSet(path, data) {
  try {
    const url = `${FIREBASE_DB_URL}/${path}.json${FIREBASE_AUTH ? '?auth='+FIREBASE_AUTH : ''}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      console.error('FB SET error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('fbSet error:', e.message);
    return false;
  }
}

async function fbUpdate(path, updates) {
  try {
    const url = `${FIREBASE_DB_URL}/${path}.json${FIREBASE_AUTH ? '?auth='+FIREBASE_AUTH : ''}`;
    const res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!res.ok) {
      console.error('FB UPDATE error:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('fbUpdate error:', e.message);
    return false;
  }
}

console.log('🔥 Firebase REST API → ' + FIREBASE_DB_URL);

// ─── SESSIONS ───────────────────────────────────────
// Token-based sessions: when user logs in, we generate token and save it
// On reload, browser sends token, we verify it in Firebase
const sessions = {}; // in-memory cache: {token: username}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

// ─── ACCOUNTS ───────────────────────────────────────
function hashPassword(p) {
  return crypto.createHash('sha256').update(p + 'spy_salt_2024').digest('hex');
}

// Sanitize username for Firebase key (no . # $ / [ ])
function sanitizeKey(username) {
  return username.toLowerCase().replace(/[.#$/\[\]]/g, '_');
}

async function getAccount(username) {
  const acc = await fbGet(`accounts/${sanitizeKey(username)}`);
  return acc;
}

async function saveAccount(username, data) {
  return await fbSet(`accounts/${sanitizeKey(username)}`, data);
}

async function saveSession(token, username) {
  sessions[token] = username;
  return await fbSet(`sessions/${token}`, { username, createdAt: Date.now() });
}

async function getSession(token) {
  if (sessions[token]) return sessions[token];
  const data = await fbGet(`sessions/${token}`);
  if (data?.username) {
    sessions[token] = data.username;
    return data.username;
  }
  return null;
}

async function deleteSession(token) {
  delete sessions[token];
  return await fbSet(`sessions/${token}`, null);
}

// In-memory cache for active accounts
const accountCache = {};

async function getCachedAccount(username) {
  if (accountCache[username]) return accountCache[username];
  const acc = await getAccount(username);
  if (acc) accountCache[username] = acc;
  return acc;
}

async function updateCacheAndSave(username, account) {
  accountCache[username] = account;
  return await saveAccount(username, account);
}

// ─── CLASSES ────────────────────────────────────────
const CLASSES = {
  'default':       { id:'default',       name:'Обычный',  icon:'🕵️', desc:'Узнать первую букву слова',                price:0,    ability:'hint' },
  'gambler':       { id:'gambler',       name:'Лудотряс', icon:'🎰', desc:'Узнать случайную букву и её номер',         price:1000, ability:'random_letter' },
  'fortune_teller':{ id:'fortune_teller',name:'Гадалка',  icon:'🔮', desc:'Узнать количество букв в слове',            price:1200, ability:'letter_count' },
  'mellstroy':     { id:'mellstroy',     name:'Меллстрой',icon:'💰', desc:'Рулетка! 777 = первая и последняя буквы',   price:2000, ability:'roulette' },
};

const REWARDS = { spy_win: 250, civilian_win: 100 };

// ─── LOBBIES ────────────────────────────────────────
const lobbies = {};

function makeLobby(hostName, hostSocketId, hostUsername) {
  return {
    code: Math.random().toString(36).slice(2,7).toUpperCase(),
    hostId: hostSocketId,
    hostName, hostUsername,
    word: '', theme: '',
    spyId: null, spyClass: 'default',
    state: 'waiting',
    players: [],
    revealQueue: [], revealIndex: 0,
    turnOrder: [], currentTurnIndex: 0,
    round: 1, maxTurns: 3,
    turnsUsed: {},
    votes: {}, voteUsed: false, voteTimer: null, voteEndTime: null,
    guessing: false, guessText: '',
    rolesSeen: {},
    abilityUsed: false, abilityResult: null,
    createdAt: Date.now(),
  };
}

function playerList(lobby) {
  return lobby.players.map(p => ({
    id: p.id, socketId: p.socketId, name: p.name,
    username: p.username, score: p.score, alive: p.alive,
    isHost: p.socketId === lobby.hostId,
    turnsUsed: lobby.turnsUsed[p.socketId] || 0,
  }));
}

function broadcast(lobby) {
  const cr = lobby.revealQueue && lobby.revealQueue[lobby.revealIndex];
  io.to(lobby.code).emit('lobby:update', {
    code: lobby.code, hostName: lobby.hostName,
    state: lobby.state, players: playerList(lobby),
    turnOrder: lobby.turnOrder ? lobby.turnOrder.map(p => p.id) : [],
    currentTurnIndex: lobby.currentTurnIndex, round: lobby.round,
    spyId: lobby.spyId, spyClass: lobby.spyClass,
    secretWord: lobby.word, theme: lobby.theme,
    maxTurns: lobby.maxTurns,
    voteUsed: lobby.voteUsed,
    guessing: lobby.guessing, guessText: lobby.guessText,
    abilityUsed: lobby.abilityUsed,
    currentRevealId: cr?.socketId || null,
    currentRevealName: cr?.name || null,
    rolesSeen: lobby.rolesSeen || {},
  });
}

setInterval(() => {
  const cutoff = Date.now() - 3*60*60*1000;
  for (const code of Object.keys(lobbies)) {
    if (lobbies[code].createdAt < cutoff) delete lobbies[code];
  }
}, 30*60*1000);

// ─── HELPERS ────────────────────────────────────────
function shuffle(arr) {
  for (let i=arr.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[arr[i],arr[j]]=[arr[j],arr[i]];}
  return arr;
}
function weightedShuffle(arr, spyId) {
  const s = shuffle([...arr]);
  if (s[0]?.id === spyId && s.length > 1 && Math.random() < 0.8) {
    const spy = s.shift();
    s.splice(1 + Math.floor(Math.random()*s.length), 0, spy);
  }
  return s;
}
function advanceReveal(lobby) {
  const p = lobby.revealQueue[lobby.revealIndex];
  if (!p) return;
  const isSpy = p.id === lobby.spyId;
  io.to(p.socketId).emit('game:yourRole', {
    isSpy, word: isSpy ? null : lobby.word,
    spyClass: isSpy ? lobby.spyClass : null,
  });
  io.to(lobby.code).emit('reveal:nextPlayer', { name: p.name });
}
function getParticipants(lobby) {
  return lobby.players.filter(p => p.socketId !== lobby.hostId);
}
function allTurnsUsed(lobby) {
  return getParticipants(lobby).filter(p => p.alive)
    .every(p => (lobby.turnsUsed[p.socketId] || 0) >= lobby.maxTurns);
}
function startVoteTimer(lobby) {
  if (lobby.voteTimer) clearTimeout(lobby.voteTimer);
  lobby.voteEndTime = Date.now() + 30000;
  io.to(lobby.code).emit('vote:started', { endTime: lobby.voteEndTime });
  lobby.voteTimer = setTimeout(() => resolveVote(lobby), 30000);
}
async function awardCoins(lobby, winner) {
  const updates = [];
  for (const p of lobby.players) {
    if (!p.username || p.socketId === lobby.hostId) continue;
    const acc = await getCachedAccount(p.username);
    if (!acc) continue;
    if (winner === 'spy' && p.id === lobby.spyId) acc.coins += REWARDS.spy_win;
    else if (winner === 'civilians' && p.id !== lobby.spyId) acc.coins += REWARDS.civilian_win;
    else continue;
    updates.push(updateCacheAndSave(p.username, acc));
    io.to(p.socketId).emit('account:update', {
      coins: acc.coins,
      inventory: acc.inventory,
      equippedClass: acc.equippedClass,
    });
  }
  await Promise.all(updates);
}
function resolveVote(lobby) {
  if (lobby.voteTimer) { clearTimeout(lobby.voteTimer); lobby.voteTimer = null; }
  const tally = {};
  for (const t of Object.values(lobby.votes)) tally[t] = (tally[t]||0)+1;
  let max=0, elimId=null;
  for (const [id,c] of Object.entries(tally)) if (c > max) { max=c; elimId=id; }
  const correct = elimId === lobby.spyId;
  lobby.state = 'ended';
  if (correct) {
    lobby.players.forEach(p => { if (p.id !== lobby.spyId && p.socketId !== lobby.hostId) p.score++; });
    awardCoins(lobby, 'civilians');
    io.to(lobby.code).emit('vote:result', { correct:true, eliminatedId:elimId, tally, word:lobby.word });
    io.to(lobby.code).emit('game:end', { winner:'civilians', reason:'vote', word:lobby.word, spyId:lobby.spyId, players:playerList(lobby) });
  } else {
    const spy = lobby.players.find(p => p.id === lobby.spyId);
    if (spy) spy.score += 2;
    awardCoins(lobby, 'spy');
    io.to(lobby.code).emit('vote:result', { correct:false, eliminatedId:elimId, tally, word:lobby.word });
    io.to(lobby.code).emit('game:end', { winner:'spy', reason:'vote', word:lobby.word, spyId:lobby.spyId, players:playerList(lobby) });
  }
  broadcast(lobby);
  io.emit('lobbies:changed');
}

// ─── SOCKET ─────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('+ connect', socket.id);

  // ACCOUNTS
  socket.on('account:register', async ({ username, password }, cb) => {
    if (!username || !password) return cb({ ok:false, error:'Заполни поля' });
    if (username.length < 3) return cb({ ok:false, error:'Логин минимум 3 символа' });
    if (password.length < 4) return cb({ ok:false, error:'Пароль минимум 4 символа' });
    
    const existing = await getAccount(username);
    if (existing) return cb({ ok:false, error:'Логин занят' });
    
    const newAccount = {
      username,
      passwordHash: hashPassword(password),
      coins: 0,
      inventory: ['default'],
      equippedClass: 'default',
      createdAt: Date.now(),
    };
    
    const saved = await saveAccount(username, newAccount);
    if (!saved) return cb({ ok:false, error:'Ошибка сохранения. Проверь Firebase rules!' });
    
    accountCache[username] = newAccount;
    socket.data.username = username;
    
    // Create session token
    const token = generateToken();
    await saveSession(token, username);
    
    cb({ ok:true, token, account:{ username, coins:0, inventory:['default'], equippedClass:'default' } });
  });

  socket.on('account:login', async ({ username, password }, cb) => {
    const acc = await getAccount(username);
    if (!acc) return cb({ ok:false, error:'Аккаунт не найден' });
    if (acc.passwordHash !== hashPassword(password)) return cb({ ok:false, error:'Неверный пароль' });
    
    // Ensure all fields exist
    if (!acc.inventory) acc.inventory = ['default'];
    if (!acc.equippedClass) acc.equippedClass = 'default';
    if (typeof acc.coins !== 'number') acc.coins = 0;
    
    accountCache[username] = acc;
    socket.data.username = username;
    
    // Create session token
    const token = generateToken();
    await saveSession(token, username);
    
    cb({ ok:true, token, account:{ username, coins:acc.coins, inventory:acc.inventory, equippedClass:acc.equippedClass } });
  });

  // Auto-login by session token (used after page reload)
  socket.on('account:autoLogin', async ({ token }, cb) => {
    if (!token) return cb({ ok:false });
    const username = await getSession(token);
    if (!username) return cb({ ok:false, error:'Сессия истекла' });
    
    const acc = await getAccount(username);
    if (!acc) return cb({ ok:false, error:'Аккаунт не найден' });
    
    if (!acc.inventory) acc.inventory = ['default'];
    if (!acc.equippedClass) acc.equippedClass = 'default';
    if (typeof acc.coins !== 'number') acc.coins = 0;
    
    accountCache[username] = acc;
    socket.data.username = username;
    
    cb({ ok:true, account:{ username, coins:acc.coins, inventory:acc.inventory, equippedClass:acc.equippedClass } });
  });

  socket.on('account:logout', async ({ token }) => {
    if (token) await deleteSession(token);
    socket.data.username = null;
  });

  socket.on('account:buyClass', async ({ classId }, cb) => {
    const u = socket.data.username;
    if (!u) return cb({ ok:false, error:'Войди в аккаунт' });
    const acc = await getCachedAccount(u);
    if (!acc) return cb({ ok:false, error:'Аккаунт не найден' });
    const cls = CLASSES[classId];
    if (!cls) return cb({ ok:false, error:'Класс не найден' });
    if (acc.inventory.includes(classId)) return cb({ ok:false, error:'Уже куплен' });
    if (acc.coins < cls.price) return cb({ ok:false, error:'Не хватает монет' });
    
    acc.coins -= cls.price;
    acc.inventory.push(classId);
    await updateCacheAndSave(u, acc);
    
    cb({ ok:true, account:{ username:u, coins:acc.coins, inventory:acc.inventory, equippedClass:acc.equippedClass } });
  });

  socket.on('account:equipClass', async ({ classId }, cb) => {
    const u = socket.data.username;
    if (!u) return cb({ ok:false, error:'Войди в аккаунт' });
    const acc = await getCachedAccount(u);
    if (!acc) return cb({ ok:false, error:'Аккаунт не найден' });
    if (!acc.inventory.includes(classId)) return cb({ ok:false, error:'Класс не куплен' });
    
    acc.equippedClass = classId;
    await updateCacheAndSave(u, acc);
    
    cb({ ok:true, account:{ username:u, coins:acc.coins, inventory:acc.inventory, equippedClass:acc.equippedClass } });
  });

  // LOBBY
  socket.on('lobbies:list', (cb) => {
    cb({ lobbies: Object.values(lobbies).filter(l => l.state==='waiting').map(l => ({
      code:l.code, hostName:l.hostName, state:l.state, playerCount:l.players.length,
    })) });
  });

  socket.on('lobby:create', ({ name }, cb) => {
    const lobby = makeLobby(name, socket.id, socket.data.username);
    lobbies[lobby.code] = lobby;
    lobby.players.push({ id:socket.id, name, socketId:socket.id, username:socket.data.username, score:0, alive:true });
    socket.join(lobby.code);
    socket.data.lobbyCode = lobby.code;
    socket.data.name = name;
    cb({ ok:true, code:lobby.code, isHost:true });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  socket.on('lobby:join', ({ code, name }, cb) => {
    const lobby = lobbies[code?.toUpperCase()];
    if (!lobby) return cb({ ok:false, error:'Лобби не найдено' });
    if (lobby.state !== 'waiting') return cb({ ok:false, error:'Игра уже идёт' });
    if (lobby.players.find(p => p.name.toLowerCase()===name.toLowerCase())) return cb({ ok:false, error:'Имя занято' });
    lobby.players.push({ id:socket.id, name, socketId:socket.id, username:socket.data.username, score:0, alive:true });
    socket.join(lobby.code);
    socket.data.lobbyCode = code.toUpperCase();
    socket.data.name = name;
    cb({ ok:true, code:lobby.code, isHost:false });
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  socket.on('game:start', async ({ word, traitorId, maxTurns, theme }, cb) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return cb?.({ ok:false });
    if (!word) return cb?.({ ok:false, error:'Введи слово' });
    if (!traitorId) return cb?.({ ok:false, error:'Выбери шпиона' });
    const parts = lobby.players.filter(p => p.socketId !== lobby.hostId);
    if (parts.length < 2) return cb?.({ ok:false, error:'Минимум 2 игрока' });

    const spyPlayer = lobby.players.find(p => p.id === traitorId);
    let spyClass = 'default';
    if (spyPlayer?.username) {
      const spyAccount = await getCachedAccount(spyPlayer.username);
      if (spyAccount) {
        spyClass = spyAccount.equippedClass || 'default';
      }
    }

    lobby.word = word;
    lobby.theme = theme || '';
    lobby.spyId = traitorId;
    lobby.spyClass = spyClass;
    lobby.maxTurns = parseInt(maxTurns) || 3;
    lobby.state = 'revealing';
    lobby.revealQueue = shuffle([...parts]);
    lobby.turnOrder = weightedShuffle([...parts], traitorId);
    lobby.revealIndex = 0;
    lobby.currentTurnIndex = 0;
    lobby.round = 1;
    lobby.turnsUsed = {};
    lobby.votes = {};
    lobby.voteUsed = false;
    lobby.guessing = false;
    lobby.guessText = '';
    lobby.rolesSeen = {};
    lobby.abilityUsed = false;
    lobby.abilityResult = null;
    lobby.players.forEach(p => { p.alive = true; });

    cb?.({ ok:true });
    broadcast(lobby);
    io.emit('lobbies:changed');
    advanceReveal(lobby);
  });

  socket.on('game:roleSeen', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'revealing') return;
    const curr = lobby.revealQueue[lobby.revealIndex];
    if (!curr || curr.socketId !== socket.id) return;
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

  socket.on('game:nextTurn', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    const aliveOrder = lobby.turnOrder.filter(p => lobby.players.find(pp => pp.id===p.id)?.alive);
    if (aliveOrder.length === 0) return;
    const curr = aliveOrder[lobby.currentTurnIndex % aliveOrder.length];
    if (socket.id !== lobby.hostId && socket.id !== curr?.socketId) return;
    if (curr) lobby.turnsUsed[curr.socketId] = (lobby.turnsUsed[curr.socketId]||0)+1;
    if (allTurnsUsed(lobby)) {
      const spy = lobby.players.find(p => p.id === lobby.spyId);
      if (spy) spy.score += 2;
      awardCoins(lobby, 'spy');
      lobby.state = 'ended';
      io.to(lobby.code).emit('game:end', { winner:'spy', reason:'turns_ended', word:lobby.word, spyId:lobby.spyId, players:playerList(lobby) });
      broadcast(lobby);
      io.emit('lobbies:changed');
      return;
    }
    let nextIdx = (lobby.currentTurnIndex + 1) % aliveOrder.length;
    let tries = 0;
    while (tries < aliveOrder.length) {
      if ((lobby.turnsUsed[aliveOrder[nextIdx].socketId]||0) < lobby.maxTurns) break;
      nextIdx = (nextIdx + 1) % aliveOrder.length;
      tries++;
    }
    lobby.currentTurnIndex = nextIdx;
    if (lobby.currentTurnIndex === 0) lobby.round++;
    broadcast(lobby);
  });

  // PATCH: Spy can't start vote
  socket.on('game:startVote', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (lobby.voteUsed) return;
    // Spy can't start vote
    if (socket.id === lobby.spyId) return;
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
    if (socket.id === lobby.spyId) return;
    lobby.votes[socket.id] = targetId;
    const voters = lobby.players.filter(p => p.alive && p.socketId !== lobby.hostId && p.id !== lobby.spyId);
    const vc = Object.keys(lobby.votes).length;
    io.to(lobby.code).emit('vote:progress', { voted:vc, total:voters.length });
    if (vc >= voters.length) resolveVote(lobby);
  });

  // ABILITIES
  socket.on('game:useAbility', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (socket.id !== lobby.spyId) return;
    if (lobby.abilityUsed) return;
    const cls = CLASSES[lobby.spyClass || 'default'];
    if (!cls) return;
    lobby.abilityUsed = true;
    let result = {};
    if (cls.ability === 'hint') {
      result = { type:'hint', letter:lobby.word.charAt(0).toUpperCase() };
    } else if (cls.ability === 'random_letter') {
      const i = Math.floor(Math.random() * lobby.word.length);
      result = { type:'random_letter', letter:lobby.word.charAt(i).toUpperCase(), position:i+1, wordLength:lobby.word.length };
    } else if (cls.ability === 'letter_count') {
      result = { type:'letter_count', count:lobby.word.length };
    } else if (cls.ability === 'roulette') {
      const won = Math.random() < 0.5;
      const slots = [];
      if (won) { slots.push(7,7,7); }
      else {
        const syms = [1,2,3,4,5,6,7,'⭐','🍒','💎'];
        for (let i=0;i<3;i++) slots.push(syms[Math.floor(Math.random()*syms.length)]);
        if (slots[0]===7 && slots[1]===7 && slots[2]===7) slots[2]='⭐';
      }
      result = {
        type:'roulette', slots, won,
        firstLetter: won ? lobby.word.charAt(0).toUpperCase() : null,
        lastLetter: won ? lobby.word.charAt(lobby.word.length-1).toUpperCase() : null,
      };
    }
    lobby.abilityResult = result;
    io.to(socket.id).emit('game:abilityResult', result);
    broadcast(lobby);
  });

  socket.on('game:startGuessing', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'playing') return;
    if (socket.id !== lobby.spyId) return;
    lobby.guessing = true;
    lobby.guessText = '';
    lobby.state = 'guessing';
    broadcast(lobby);
    io.to(lobby.code).emit('guess:started', { spyName: lobby.players.find(p=>p.id===socket.id)?.name });
  });

  socket.on('game:guessTyping', ({ text }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'guessing') return;
    if (socket.id !== lobby.spyId) return;
    lobby.guessText = text;
    io.to(lobby.code).emit('guess:typing', { text });
  });

  socket.on('game:guessWord', ({ guess }) => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || lobby.state !== 'guessing') return;
    if (socket.id !== lobby.spyId) return;
    const correct = guess.toLowerCase().trim() === lobby.word.toLowerCase().trim();
    const spyName = lobby.players.find(p => p.id === socket.id)?.name;
    lobby.guessing = false;
    lobby.state = 'ended';
    if (correct) {
      const spy = lobby.players.find(p => p.id === lobby.spyId);
      if (spy) spy.score += 2;
      awardCoins(lobby, 'spy');
      io.to(lobby.code).emit('game:end', { winner:'spy', reason:'guess_correct', word:lobby.word, guess, spyName, spyId:lobby.spyId, players:playerList(lobby) });
    } else {
      lobby.players.forEach(p => { if (p.id !== lobby.spyId && p.socketId !== lobby.hostId) p.score++; });
      awardCoins(lobby, 'civilians');
      io.to(lobby.code).emit('game:end', { winner:'civilians', reason:'guess_wrong', word:lobby.word, guess, spyName, spyId:lobby.spyId, players:playerList(lobby) });
    }
    broadcast(lobby);
    io.emit('lobbies:changed');
  });

  socket.on('game:playAgain', () => {
    const lobby = lobbies[socket.data.lobbyCode];
    if (!lobby || socket.id !== lobby.hostId) return;
    lobby.state = 'waiting';
    lobby.word = ''; lobby.theme = '';
    lobby.spyId = null; lobby.spyClass = 'default';
    lobby.turnsUsed = {};
    lobby.votes = {}; lobby.voteUsed = false;
    lobby.guessing = false; lobby.guessText = '';
    lobby.abilityUsed = false; lobby.abilityResult = null;
    lobby.players.forEach(p => { p.alive = true; });
    broadcast(lobby);
    io.emit('lobbies:changed');
    io.to(lobby.code).emit('game:backToLobby');
  });

  socket.on('disconnect', () => {
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
  console.log(`🕵️  ШПИОН server → http://localhost:${PORT}`);
});
