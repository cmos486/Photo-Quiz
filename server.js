const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3001;

// --- Database ---
const db = new Database(path.join(__dirname, 'data', 'quiz.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS session (
    id INTEGER PRIMARY KEY,
    state TEXT DEFAULT 'lobby',
    current_photo_index INTEGER DEFAULT 0,
    game_url TEXT DEFAULT '',
    auto_purge_days INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS authors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER,
    filename TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    FOREIGN KEY (author_id) REFERENCES authors(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT,
    photo_id INTEGER,
    voted_for_author_id INTEGER,
    is_correct INTEGER DEFAULT 0,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(player_id, photo_id)
  );

  CREATE TABLE IF NOT EXISTS game_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_photos INTEGER DEFAULT 0,
    total_players INTEGER DEFAULT 0,
    finished_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS game_history_players (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id INTEGER NOT NULL,
    player_name TEXT NOT NULL,
    score INTEGER DEFAULT 0,
    correct_votes INTEGER DEFAULT 0,
    total_votes INTEGER DEFAULT 0,
    position INTEGER DEFAULT 0,
    FOREIGN KEY (game_id) REFERENCES game_history(id) ON DELETE CASCADE
  );
`);

// Ensure session row exists
const sessionRow = db.prepare('SELECT id FROM session WHERE id = 1').get();
if (!sessionRow) {
  db.prepare('INSERT INTO session (id, state, current_photo_index, game_url, auto_purge_days) VALUES (1, ?, 0, ?, 0)').run('lobby', '');
}

// Migration: add auto_purge_days column if missing (existing DBs)
try {
  db.prepare('SELECT auto_purge_days FROM session LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE session ADD COLUMN auto_purge_days INTEGER DEFAULT 0');
}

// --- Helper: archive current game to history ---
function archiveGame() {
  const players = db.prepare('SELECT * FROM players ORDER BY score DESC, name').all();
  const photos = db.prepare('SELECT * FROM photos').all();

  // Only archive if there were players and photos (a real game happened)
  if (players.length === 0 || photos.length === 0) return null;

  // Check if any votes exist (game was actually played)
  const voteCount = db.prepare('SELECT COUNT(*) as cnt FROM votes').get().cnt;
  if (voteCount === 0) return null;

  const archiveTransaction = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO game_history (total_photos, total_players) VALUES (?, ?)'
    ).run(photos.length, players.length);

    const gameId = result.lastInsertRowid;

    const insertPlayer = db.prepare(
      'INSERT INTO game_history_players (game_id, player_name, score, correct_votes, total_votes, position) VALUES (?, ?, ?, ?, ?, ?)'
    );

    players.forEach((player, index) => {
      const correctVotes = db.prepare(
        'SELECT COUNT(*) as cnt FROM votes WHERE player_id = ? AND is_correct = 1'
      ).get(player.id).cnt;
      const totalVotes = db.prepare(
        'SELECT COUNT(*) as cnt FROM votes WHERE player_id = ?'
      ).get(player.id).cnt;

      insertPlayer.run(gameId, player.name, player.score, correctVotes, totalVotes, index + 1);
    });

    return gameId;
  });

  const gameId = archiveTransaction();
  if (gameId) {
    console.log(`[Archive] Game #${gameId} archived: ${players.length} players, ${photos.length} photos`);
  }
  return gameId;
}

// --- Helper: purge all data (photos on disk + DB) ---
// includeHistory: if true, also deletes game_history tables
function purgeAllData(includeHistory = false) {
  // Archive current game before purging (if there's data worth archiving)
  archiveGame();

  const photosDir = path.join(__dirname, 'photos');
  // Delete all photo files
  if (fs.existsSync(photosDir)) {
    for (const file of fs.readdirSync(photosDir)) {
      const filePath = path.join(photosDir, file);
      if (fs.statSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    }
  }
  // Clear DB tables
  const purgeTransaction = db.transaction(() => {
    db.prepare('DELETE FROM votes').run();
    db.prepare('DELETE FROM photos').run();
    db.prepare('DELETE FROM authors').run();
    db.prepare('DELETE FROM players').run();
    db.prepare('UPDATE session SET state = ?, current_photo_index = 0 WHERE id = 1').run('lobby');
    if (includeHistory) {
      db.prepare('DELETE FROM game_history_players').run();
      db.prepare('DELETE FROM game_history').run();
    }
  });
  purgeTransaction();
  console.log(`[Purge] All data purged successfully${includeHistory ? ' (including history)' : ' (history preserved)'}`);
}

// --- Auto-purge: periodic check (every hour + on startup) ---
function checkAutoPurge() {
  const session = db.prepare('SELECT auto_purge_days, created_at FROM session WHERE id = 1').get();
  if (session && session.auto_purge_days > 0) {
    const createdAt = new Date(session.created_at);
    const now = new Date();
    const diffDays = (now - createdAt) / (1000 * 60 * 60 * 24);
    if (diffDays >= session.auto_purge_days) {
      console.log(`[Auto-purge] Data is ${Math.floor(diffDays)} days old (limit: ${session.auto_purge_days}). Purging...`);
      purgeAllData();
      db.prepare('UPDATE session SET created_at = CURRENT_TIMESTAMP WHERE id = 1').run();
    }
  }
}
checkAutoPurge(); // Run on startup
setInterval(checkAutoPurge, 60 * 60 * 1000); // Check every hour

// --- Prepared statements ---
const stmts = {
  getSession: db.prepare('SELECT * FROM session WHERE id = 1'),
  updateState: db.prepare('UPDATE session SET state = ? WHERE id = 1'),
  updatePhotoIndex: db.prepare('UPDATE session SET current_photo_index = ? WHERE id = 1'),
  updateGameUrl: db.prepare('UPDATE session SET game_url = ? WHERE id = 1'),

  getAuthors: db.prepare('SELECT * FROM authors ORDER BY name'),
  addAuthor: db.prepare('INSERT INTO authors (name) VALUES (?)'),
  deleteAuthor: db.prepare('DELETE FROM authors WHERE id = ?'),

  getPhotos: db.prepare('SELECT * FROM photos ORDER BY display_order'),
  getPhotosByAuthor: db.prepare('SELECT * FROM photos WHERE author_id = ?'),
  addPhoto: db.prepare('INSERT INTO photos (author_id, filename, display_order) VALUES (?, ?, ?)'),
  deletePhoto: db.prepare('DELETE FROM photos WHERE id = ?'),
  getPhotoById: db.prepare('SELECT * FROM photos WHERE id = ?'),
  randomizePhotos: db.prepare('UPDATE photos SET display_order = ? WHERE id = ?'),

  getPlayers: db.prepare('SELECT * FROM players ORDER BY score DESC, name'),
  upsertPlayer: db.prepare('INSERT INTO players (id, name, score, last_seen) VALUES (?, ?, 0, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = CURRENT_TIMESTAMP'),
  updatePlayerScore: db.prepare('UPDATE players SET score = score + ? WHERE id = ?'),
  updatePlayerSeen: db.prepare('UPDATE players SET last_seen = CURRENT_TIMESTAMP WHERE id = ?'),
  deleteAllPlayers: db.prepare('DELETE FROM players'),

  addVote: db.prepare('INSERT INTO votes (player_id, photo_id, voted_for_author_id, is_correct, points) VALUES (?, ?, ?, ?, ?)'),
  getVotesForPhoto: db.prepare('SELECT * FROM votes WHERE photo_id = ?'),
  hasVoted: db.prepare('SELECT id FROM votes WHERE player_id = ? AND photo_id = ?'),
  deleteAllVotes: db.prepare('DELETE FROM votes'),

  resetSession: db.prepare('UPDATE session SET state = ?, current_photo_index = 0 WHERE id = 1'),
  deleteAllPhotos: db.prepare('DELETE FROM photos'),
  deleteAllAuthors: db.prepare('DELETE FROM authors'),
};

// --- Express + Socket.io ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6, // 1MB max for socket messages (no images!)
});

app.use(express.json());

// Serve frontend (in production nginx does this, but useful for local/Docker-only mode)
app.use(express.static(path.join(__dirname, 'public')));

// Static files for photos (fallback — nginx should serve these directly)
app.use('/photos', express.static(path.join(__dirname, 'photos')));

// --- Multer for photo uploads ---
const storage = multer.diskStorage({
  destination: path.join(__dirname, 'photos'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten imágenes (jpg, png, gif, webp)'));
    }
  },
});

// --- Helper: get full game state ---
function getFullState() {
  const session = stmts.getSession.get();
  const authors = stmts.getAuthors.all();
  const photos = stmts.getPhotos.all();
  const players = stmts.getPlayers.all();

  const currentPhoto = photos[session.current_photo_index] || null;
  let voteCounts = {};
  let totalVoters = 0;

  if (currentPhoto) {
    const votes = stmts.getVotesForPhoto.all(currentPhoto.id);
    totalVoters = votes.length;
    for (const v of votes) {
      voteCounts[v.voted_for_author_id] = (voteCounts[v.voted_for_author_id] || 0) + 1;
    }
  }

  return {
    session,
    authors,
    photos: photos.map(p => ({
      ...p,
      url: `/photos/${p.filename}`,
    })),
    players,
    currentPhoto: currentPhoto ? {
      ...currentPhoto,
      url: `/photos/${currentPhoto.filename}`,
    } : null,
    voteCounts,
    totalVoters,
    totalPhotos: photos.length,
  };
}

// --- Helper: broadcast state ---
function broadcastState() {
  const state = getFullState();
  const online = [...connectedPlayers.keys()];
  io.emit('state_update', {
    state: state.session.state,
    currentPhotoIndex: state.session.current_photo_index,
    photoUrl: state.currentPhoto ? state.currentPhoto.url : null,
    totalPhotos: state.totalPhotos,
    currentPhotoId: state.currentPhoto ? state.currentPhoto.id : null,
    currentPhotoAuthorId: state.session.state === 'revealed' && state.currentPhoto ? state.currentPhoto.author_id : undefined,
  });
  io.emit('players_update', { players: state.players });
  io.emit('players_online', { online });
  if (state.currentPhoto) {
    io.emit('vote_count', {
      photoId: state.currentPhoto.id,
      counts: state.voteCounts,
      totalVoters: state.totalVoters,
      totalPlayers: state.players.length,
    });
  }
}

// --- API Routes ---

// Get full state
app.get('/api/state', (req, res) => {
  const state = getFullState();
  res.json(state);
});

// Upload photo
app.post('/api/upload', upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se envió foto' });
  const authorId = req.body.author_id;
  if (!authorId) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Falta author_id' });
  }
  const maxOrder = db.prepare('SELECT MAX(display_order) as m FROM photos').get();
  const order = (maxOrder.m || 0) + 1;
  const result = stmts.addPhoto.run(authorId, req.file.filename, order);
  broadcastState();
  res.json({ id: result.lastInsertRowid, filename: req.file.filename, url: `/photos/${req.file.filename}` });
});

// Delete photo
app.delete('/api/photo/:id', (req, res) => {
  const photo = stmts.getPhotoById.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Foto no encontrada' });
  const filepath = path.join(__dirname, 'photos', photo.filename);
  stmts.deletePhoto.run(req.params.id);
  if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  broadcastState();
  res.json({ ok: true });
});

// Create author
app.post('/api/authors', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Falta nombre' });
  const result = stmts.addAuthor.run(name.trim());
  broadcastState();
  res.json({ id: result.lastInsertRowid, name: name.trim() });
});

// Delete author (cascade deletes photos)
app.delete('/api/authors/:id', (req, res) => {
  const photos = stmts.getPhotosByAuthor.all(req.params.id);
  for (const photo of photos) {
    const filepath = path.join(__dirname, 'photos', photo.filename);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
  }
  stmts.deleteAuthor.run(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

// Start game
app.post('/api/game/start', (req, res) => {
  const photos = stmts.getPhotos.all();
  if (photos.length === 0) return res.status(400).json({ error: 'No hay fotos' });

  // Randomize photo order (Fisher-Yates)
  const shuffled = [...photos];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const updateOrder = db.transaction(() => {
    for (let i = 0; i < shuffled.length; i++) {
      stmts.randomizePhotos.run(i, shuffled[i].id);
    }
  });
  updateOrder();

  // Reset scores and votes
  db.prepare('UPDATE players SET score = 0').run();
  stmts.deleteAllVotes.run();

  stmts.updatePhotoIndex.run(0);
  stmts.updateState.run('playing');
  broadcastState();
  res.json({ ok: true, totalPhotos: shuffled.length });
});

// Reveal author
app.post('/api/game/reveal', (req, res) => {
  const session = stmts.getSession.get();
  if (session.state !== 'playing') return res.status(400).json({ error: 'No está en juego' });

  const photos = stmts.getPhotos.all();
  const currentPhoto = photos[session.current_photo_index];
  if (!currentPhoto) return res.status(400).json({ error: 'No hay foto actual' });

  const author = db.prepare('SELECT * FROM authors WHERE id = ?').get(currentPhoto.author_id);

  stmts.updateState.run('revealed');

  // Calculate points for correct votes
  const votes = stmts.getVotesForPhoto.all(currentPhoto.id);
  const updatePoints = db.transaction(() => {
    for (const vote of votes) {
      if (vote.voted_for_author_id === currentPhoto.author_id) {
        db.prepare('UPDATE votes SET is_correct = 1, points = 3 WHERE id = ?').run(vote.id);
        stmts.updatePlayerScore.run(3, vote.player_id);
      }
    }
  });
  updatePoints();

  const ranking = stmts.getPlayers.all();

  // Send individual results to each voter
  for (const vote of votes) {
    const correct = vote.voted_for_author_id === currentPhoto.author_id;
    const playerSocket = [...io.sockets.sockets.values()].find(s => s.playerId === vote.player_id);
    if (playerSocket) {
      playerSocket.emit('vote_result', {
        correct,
        points: correct ? 3 : 0,
        authorName: author ? author.name : 'Desconocido',
      });
    }
  }

  io.emit('revealed', {
    authorId: currentPhoto.author_id,
    authorName: author ? author.name : 'Desconocido',
    ranking,
  });

  broadcastState();
  res.json({ ok: true, authorName: author ? author.name : 'Desconocido' });
});

// Next photo
app.post('/api/game/next', (req, res) => {
  const session = stmts.getSession.get();
  const photos = stmts.getPhotos.all();
  const nextIndex = session.current_photo_index + 1;

  if (nextIndex >= photos.length) {
    return res.status(400).json({ error: 'No hay más fotos' });
  }

  stmts.updatePhotoIndex.run(nextIndex);
  stmts.updateState.run('playing');
  broadcastState();
  res.json({ ok: true, photoIndex: nextIndex, totalPhotos: photos.length });
});

// Finish game
app.post('/api/game/finish', (req, res) => {
  // Archive game before finishing
  archiveGame();
  stmts.updateState.run('finished');
  const ranking = stmts.getPlayers.all();
  io.emit('game_finished', { ranking });
  broadcastState();
  res.json({ ok: true, ranking });
});

// Reset game
app.post('/api/game/reset', (req, res) => {
  // Archive game before resetting (if it was played)
  archiveGame();
  const resetAll = db.transaction(() => {
    stmts.resetSession.run('lobby');
    stmts.deleteAllVotes.run();
    db.prepare('UPDATE players SET score = 0').run();
  });
  resetAll();
  broadcastState();
  res.json({ ok: true });
});

// Update game URL
app.post('/api/game/url', (req, res) => {
  const { url } = req.body;
  if (url === undefined) return res.status(400).json({ error: 'Falta url' });
  stmts.updateGameUrl.run(url);
  broadcastState();
  res.json({ ok: true });
});

// --- Admin: Purge all data ---
app.post('/api/admin/purge', (req, res) => {
  const includeHistory = req.body && req.body.includeHistory === true;
  purgeAllData(includeHistory);
  connectedPlayers.clear();
  broadcastState();
  res.json({ ok: true });
});

// --- Admin: Get/Set auto-purge config ---
app.get('/api/admin/auto-purge', (req, res) => {
  const session = db.prepare('SELECT auto_purge_days FROM session WHERE id = 1').get();
  res.json({ autoPurgeDays: session ? session.auto_purge_days : 0 });
});

app.post('/api/admin/auto-purge', (req, res) => {
  const { days } = req.body;
  if (days === undefined || days < 0) return res.status(400).json({ error: 'Valor inválido' });
  db.prepare('UPDATE session SET auto_purge_days = ? WHERE id = 1').run(days);
  // Reset created_at to now when changing the setting so the countdown starts fresh
  if (days > 0) {
    db.prepare('UPDATE session SET created_at = CURRENT_TIMESTAMP WHERE id = 1').run();
  }
  res.json({ ok: true, autoPurgeDays: days });
});

// --- Admin: Game history ---
app.get('/api/admin/history', (req, res) => {
  const games = db.prepare('SELECT * FROM game_history ORDER BY finished_at DESC').all();
  const result = games.map(game => {
    const players = db.prepare(
      'SELECT * FROM game_history_players WHERE game_id = ? ORDER BY position ASC'
    ).all(game.id);
    return { ...game, players };
  });
  res.json({ games: result });
});

app.delete('/api/admin/history/:id', (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM game_history_players WHERE game_id = ?').run(id);
  db.prepare('DELETE FROM game_history WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.delete('/api/admin/history', (req, res) => {
  db.prepare('DELETE FROM game_history_players').run();
  db.prepare('DELETE FROM game_history').run();
  res.json({ ok: true });
});

// Catch-all: serve index.html for SPA routing (local/Docker-only mode)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Socket.io ---
const connectedPlayers = new Map(); // playerId -> socketId

io.on('connection', (socket) => {
  console.log(`Socket conectado: ${socket.id}`);

  // Send current state on connect
  const state = getFullState();
  socket.emit('state_update', {
    state: state.session.state,
    currentPhotoIndex: state.session.current_photo_index,
    photoUrl: state.currentPhoto ? state.currentPhoto.url : null,
    totalPhotos: state.totalPhotos,
    currentPhotoId: state.currentPhoto ? state.currentPhoto.id : null,
    currentPhotoAuthorId: state.session.state === 'revealed' && state.currentPhoto ? state.currentPhoto.author_id : undefined,
  });
  socket.emit('players_update', { players: state.players });

  socket.on('join', ({ playerId, name }) => {
    if (!playerId || !name) return;
    socket.playerId = playerId;
    connectedPlayers.set(playerId, socket.id);
    stmts.upsertPlayer.run(playerId, name.trim());

    // Tell the player if they already voted for the current photo
    const session = stmts.getSession.get();
    const photos = stmts.getPhotos.all();
    const currentPhoto = photos[session.current_photo_index];
    if (currentPhoto) {
      const existingVote = stmts.hasVoted.get(playerId, currentPhoto.id);
      socket.emit('vote_status', {
        photoId: currentPhoto.id,
        hasVoted: !!existingVote,
      });
    }

    broadcastState();
  });

  socket.on('vote', ({ playerId, authorId }) => {
    if (!playerId || !authorId) return;

    const session = stmts.getSession.get();
    if (session.state !== 'playing') return;

    const photos = stmts.getPhotos.all();
    const currentPhoto = photos[session.current_photo_index];
    if (!currentPhoto) return;

    // Check if already voted
    const existing = stmts.hasVoted.get(playerId, currentPhoto.id);
    if (existing) return;

    const isCorrect = currentPhoto.author_id === authorId ? 1 : 0;
    stmts.addVote.run(playerId, currentPhoto.id, authorId, isCorrect, 0); // Points assigned on reveal

    // Broadcast updated vote counts
    const votes = stmts.getVotesForPhoto.all(currentPhoto.id);
    const counts = {};
    for (const v of votes) {
      counts[v.voted_for_author_id] = (counts[v.voted_for_author_id] || 0) + 1;
    }
    const players = stmts.getPlayers.all();
    io.emit('vote_count', {
      photoId: currentPhoto.id,
      counts,
      totalVoters: votes.length,
      totalPlayers: players.length,
    });
  });

  socket.on('disconnect', () => {
    console.log(`Socket desconectado: ${socket.id}`);
    if (socket.playerId) {
      connectedPlayers.delete(socket.playerId);
      // Don't remove from DB, just update connected status on next players_update
      io.emit('players_online', { online: [...connectedPlayers.keys()] });
    }
  });
});

// Periodic broadcast of online players
setInterval(() => {
  io.emit('players_online', { online: [...connectedPlayers.keys()] });
}, 5000);

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Photo Quiz server running on port ${PORT}`);
});
