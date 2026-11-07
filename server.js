const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3001;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'photoquiz';
const MAX_UPLOAD_MB = parseInt(process.env.MAX_UPLOAD_MB, 10) || 5; // per-file upload limit (env-overridable)
// Proxies in front of Express (reverse proxy / load balancer, optional host nginx, docker bridge) live on
// private/loopback ranges. Trusting those ranges makes req.ip = first public hop in X-Forwarded-For.
// Override with TRUST_PROXY (e.g. "1", "2", or a comma list of IPs/CIDRs) if topology changes.
const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal';
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : null; // null = allow all

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

// Migration: archived flag (prevents archiving the same game twice, e.g. finish + reset)
try {
  db.prepare('SELECT archived FROM session LIMIT 1').get();
} catch {
  db.exec('ALTER TABLE session ADD COLUMN archived INTEGER DEFAULT 0');
}

// Migration: visual theme (purely cosmetic)
try {
  db.prepare('SELECT theme FROM session LIMIT 1').get();
} catch {
  db.exec("ALTER TABLE session ADD COLUMN theme TEXT DEFAULT 'none'");
}
// Migration: automatic advance settings (auto_mode 0 = manual, the default)
for (const [col, def] of [['auto_mode', 0], ['auto_delay_s', 3], ['auto_timeout_s', 60]]) {
  try { db.prepare(`SELECT ${col} FROM session LIMIT 1`).get(); }
  catch { db.exec(`ALTER TABLE session ADD COLUMN ${col} INTEGER DEFAULT ${def}`); }
}
const AUTO_DELAY_RANGE = [1, 10];     // seconds between reveal and next photo
const AUTO_TIMEOUT_RANGE = [10, 600]; // safety net: max seconds per photo before forced reveal

// Merged players: a browser that still holds a merged (deleted) playerId is redirected to
// the player it was merged into, so the duplicate never comes back on reconnect.
db.exec(`CREATE TABLE IF NOT EXISTS player_aliases (
  old_id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL
)`);
const THEMES = ['none', 'halloween', 'navidad'];
// Background music for the TV view only. MP3s are dropped by the operator in ./audio
// (bind-mounted in docker-compose); none are shipped with the repo.
const AUDIO_DIR = path.join(__dirname, 'audio');
const THEME_TRACK = { none: 'ambient.mp3', halloween: 'halloween.mp3', navidad: 'navidad.mp3' };
// URL of the track for a theme: the theme's own MP3 if present, otherwise ambient.mp3 as the
// common fallback, otherwise null (client then requests nothing).
function trackExists(file) {
  try { return fs.statSync(path.join(AUDIO_DIR, file)).isFile(); } catch { return false; }
}
function musicUrl(theme) {
  const candidates = [THEME_TRACK[theme] || THEME_TRACK.none, THEME_TRACK.none];
  const file = candidates.find(trackExists);
  return file ? `/audio/${file}` : null;
}

// --- Helper: archive current game to history ---
function archiveGame() {
  const flag = db.prepare('SELECT archived FROM session WHERE id = 1').get();
  if (flag && flag.archived) return null;

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
    db.prepare('UPDATE session SET archived = 1 WHERE id = 1').run();

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
    db.prepare('DELETE FROM player_aliases').run();
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
      const st = db.prepare('SELECT state FROM session WHERE id = 1').get().state;
      if (st === 'playing' || st === 'revealed') {
        console.warn(`[Auto-purge] SKIPPED: data is ${Math.floor(diffDays)} days old but a game is in progress (state=${st}).`);
        return;
      }
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM photos) p, (SELECT COUNT(*) FROM authors) a, (SELECT COUNT(*) FROM players) pl').get();
      console.warn(`[Auto-purge] *** ABOUT TO DELETE ALL GAME DATA *** age=${Math.floor(diffDays)}d limit=${session.auto_purge_days}d -> ${counts.p} photos, ${counts.a} authors, ${counts.pl} players (history kept). Disable in Admin > Ajustes.`);
      purgeAllData();
      db.prepare('UPDATE session SET created_at = CURRENT_TIMESTAMP WHERE id = 1').run();
    }
  }
}
{
  const ap = db.prepare('SELECT auto_purge_days FROM session WHERE id = 1').get().auto_purge_days;
  console.log(ap > 0 ? `[Auto-purge] ENABLED: data older than ${ap} days will be deleted (checked hourly)` : '[Auto-purge] disabled');
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
app.set('trust proxy', TRUST_PROXY);
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGINS || '*' },
  maxHttpBufferSize: 1e6, // 1MB max for socket messages (no images!)
});

// --- Security Headers ---
app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'SAMEORIGIN',
    'X-Content-Type-Options': 'nosniff',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});

app.use(express.json({ limit: '1mb' }));

// --- Rate Limiter (in-memory) ---
const rateLimitStore = new Map();
function rateLimit(key, maxRequests, windowMs) {
  const now = Date.now();
  const entry = rateLimitStore.get(key) || [];
  const filtered = entry.filter(t => now - t < windowMs);
  if (filtered.length >= maxRequests) return false;
  filtered.push(now);
  rateLimitStore.set(key, filtered);
  return true;
}
// Cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, times] of rateLimitStore) {
    const filtered = times.filter(t => now - t < 3600000);
    if (filtered.length === 0) rateLimitStore.delete(key);
    else rateLimitStore.set(key, filtered);
  }
}, 600000);

function rateLimitMiddleware(prefix, maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    if (!rateLimit(`${prefix}:${ip}`, maxRequests, windowMs)) {
      return res.status(429).json({ error: 'Demasiadas peticiones. Inténtalo más tarde.' });
    }
    next();
  };
}

// --- Admin Auth ---
const adminTokens = new Set();

function generateAdminToken() {
  const token = crypto.randomBytes(32).toString('hex');
  adminTokens.add(token);
  return token;
}

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// --- Input sanitization ---
function sanitize(str, maxLen = 100) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/<[^>]*>/g, '').substring(0, maxLen);
}

// Serve frontend (in production nginx does this, but useful for local/Docker-only mode)
app.use(express.static(path.join(__dirname, 'public')));

// Static files for photos (fallback — nginx should serve these directly)
app.use('/photos', express.static(path.join(__dirname, 'photos')));

// Background music (TV). Missing files get a plain 404, never the SPA index.html.
app.use('/audio', express.static(AUDIO_DIR));
app.use('/audio', (req, res) => res.status(404).end());

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
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
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

// Expected voters for the current photo = joined players online now ∪ players who already voted.
// (Using every player ever registered made the TV show phantom missing votes.)
function expectedVoters(votes) {
  const ids = new Set(connectedPlayers.keys());
  for (const v of votes) ids.add(v.player_id);
  return ids.size;
}

// Name of the current photo's author, only once revealed (never leaks the answer while playing)
function revealedAuthorName(state) {
  if (state.session.state !== 'revealed' || !state.currentPhoto) return undefined;
  const author = state.authors.find(a => a.id === state.currentPhoto.author_id);
  return author ? author.name : 'Desconocido';
}

// Single source for the state_update payload. Includes the author list so every client
// (TV/player that connected before authors existed) always has it up to date.
function statePayload(state) {
  return {
    state: state.session.state,
    currentPhotoIndex: state.session.current_photo_index,
    photoUrl: state.currentPhoto ? state.currentPhoto.url : null,
    totalPhotos: state.totalPhotos,
    currentPhotoId: state.currentPhoto ? state.currentPhoto.id : null,
    currentPhotoAuthorId: state.session.state === 'revealed' && state.currentPhoto ? state.currentPhoto.author_id : undefined,
    currentPhotoAuthorName: revealedAuthorName(state),
    authors: state.authors.map(a => ({ id: a.id, name: a.name })),
    theme: state.session.theme || 'none',
    musicUrl: musicUrl(state.session.theme || 'none'),
    ...autoInfo(state.session),
  };
}

// --- Helper: broadcast state ---
function broadcastState() {
  const state = getFullState();
  const online = [...connectedPlayers.keys()];
  io.emit('state_update', statePayload(state));
  io.emit('players_update', { players: state.players });
  io.emit('players_online', { online });
  if (state.currentPhoto) {
    io.emit('vote_count', {
      photoId: state.currentPhoto.id,
      counts: state.voteCounts,
      totalVoters: state.totalVoters,
      totalPlayers: expectedVoters(stmts.getVotesForPhoto.all(state.currentPhoto.id)),
    });
  }
}

// --- API Routes ---

// Public: admin login
app.post('/api/admin/login', rateLimitMiddleware('login', 5, 60000), (req, res) => {
  const { password } = req.body;
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  const token = generateAdminToken();
  res.json({ ok: true, token });
});

// Public: verify token
app.get('/api/admin/verify', (req, res) => {
  const token = req.headers['x-admin-token'];
  res.json({ valid: !!(token && adminTokens.has(token)) });
});

// Admin: show how the server sees the client IP (validates trust proxy / X-Forwarded-For)
app.get('/api/admin/whoami', requireAdmin, (req, res) => {
  res.json({
    ip: req.ip,
    ips: req.ips,
    xForwardedFor: req.headers['x-forwarded-for'] || null,
    xRealIp: req.headers['x-real-ip'] || null,
    socketRemote: req.socket.remoteAddress,
    trustProxy: TRUST_PROXY,
  });
});

// Public: get state (players/TV need this without auth)
app.get('/api/state', (req, res) => {
  const state = getFullState();
  const theme = state.session.theme || 'none';
  res.json({ ...state, currentPhotoAuthorName: revealedAuthorName(state), maxUploadMB: MAX_UPLOAD_MB, theme, musicUrl: musicUrl(theme), ...autoInfo(state.session) });
});

// ---- All routes below require admin auth ----

// Upload photo
function uploadSingle(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    // multer removes the partially written file itself when it aborts on a limit
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: `La foto supera el máximo de ${MAX_UPLOAD_MB} MB`, code: 'FILE_TOO_LARGE', maxUploadMB: MAX_UPLOAD_MB });
    }
    return res.status(400).json({ error: err.message || 'Subida no válida', code: err.code || 'INVALID_UPLOAD' });
  });
}

app.post('/api/upload', requireAdmin, uploadSingle, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se envió foto' });
  const authorId = parseInt(req.body.author_id, 10);
  const author = Number.isInteger(authorId) ? db.prepare('SELECT id FROM authors WHERE id = ?').get(authorId) : null;
  if (!author) {
    try { fs.unlinkSync(req.file.path); } catch {}
    return res.status(400).json({ error: 'Autor no válido' });
  }
  const maxOrder = db.prepare('SELECT MAX(display_order) as m FROM photos').get();
  const order = (maxOrder.m || 0) + 1;
  const result = stmts.addPhoto.run(authorId, req.file.filename, order);
  broadcastState();
  res.json({ id: result.lastInsertRowid, filename: req.file.filename, url: `/photos/${req.file.filename}` });
});

// Delete photo
app.delete('/api/photo/:id', requireAdmin, (req, res) => {
  if (stmts.getSession.get().state !== 'lobby') return res.status(409).json({ error: 'No se puede borrar durante la partida. Resetea primero.' });
  const photo = stmts.getPhotoById.get(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Foto no encontrada' });
  const filepath = path.join(__dirname, 'photos', photo.filename);
  stmts.deletePhoto.run(req.params.id);
  try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {}
  broadcastState();
  res.json({ ok: true });
});

// Create author
app.post('/api/authors', requireAdmin, (req, res) => {
  const name = sanitize(req.body.name, 50);
  if (!name) return res.status(400).json({ error: 'Falta nombre' });
  const result = stmts.addAuthor.run(name);
  broadcastState();
  res.json({ id: result.lastInsertRowid, name });
});

// Delete author (cascade deletes photos)
app.delete('/api/authors/:id', requireAdmin, (req, res) => {
  if (stmts.getSession.get().state !== 'lobby') return res.status(409).json({ error: 'No se puede borrar durante la partida. Resetea primero.' });
  const photos = stmts.getPhotosByAuthor.all(req.params.id);
  for (const photo of photos) {
    const filepath = path.join(__dirname, 'photos', photo.filename);
    try { if (fs.existsSync(filepath)) fs.unlinkSync(filepath); } catch {}
  }
  stmts.deleteAuthor.run(req.params.id);
  broadcastState();
  res.json({ ok: true });
});

// Start game
app.post('/api/game/start', requireAdmin, (req, res) => {
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
  db.prepare('UPDATE session SET archived = 0 WHERE id = 1').run();
  stmts.updateState.run('playing');
  autoTick();
  broadcastState();
  res.json({ ok: true, totalPhotos: shuffled.length });
});

// Reveal author
function doReveal() {
  const session = stmts.getSession.get();
  if (session.state !== 'playing') return { status: 400, error: 'No está en juego' };

  const photos = stmts.getPhotos.all();
  const currentPhoto = photos[session.current_photo_index];
  if (!currentPhoto) return { status: 400, error: 'No hay foto actual' };

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
    io.to(`player:${vote.player_id}`).emit('vote_result', {
      photoId: currentPhoto.id,
      correct,
      points: correct ? 3 : 0,
      authorName: author ? author.name : 'Desconocido',
    });
  }

  io.emit('revealed', {
    authorId: currentPhoto.author_id,
    authorName: author ? author.name : 'Desconocido',
    ranking,
  });

  autoTick();
  broadcastState();
  return { ok: true, authorName: author ? author.name : 'Desconocido' };
}
const sendResult = (res, r) => (r.ok ? res.json(r) : res.status(r.status).json({ error: r.error }));
app.post('/api/game/reveal', requireAdmin, (req, res) => sendResult(res, doReveal()));

// Next photo
function doNext() {
  const session = stmts.getSession.get();
  if (session.state !== 'revealed') return { status: 400, error: 'Revela la foto actual antes de pasar a la siguiente' };
  const photos = stmts.getPhotos.all();
  const nextIndex = session.current_photo_index + 1;

  if (nextIndex >= photos.length) {
    return { status: 400, error: 'No hay más fotos' };
  }

  stmts.updatePhotoIndex.run(nextIndex);
  stmts.updateState.run('playing');
  autoTick();
  broadcastState();
  return { ok: true, photoIndex: nextIndex, totalPhotos: photos.length };
}
app.post('/api/game/next', requireAdmin, (req, res) => sendResult(res, doNext()));

// Finish game
function doFinish() {
  const current = stmts.getSession.get();
  if (current.state === 'lobby') return { status: 400, error: 'No hay partida en curso' };
  if (current.state !== 'finished') archiveGame();
  stmts.updateState.run('finished');
  autoTick(); // clears any pending automatic timer
  const ranking = stmts.getPlayers.all();
  io.emit('game_finished', { ranking });
  broadcastState();
  return { ok: true, ranking };
}
app.post('/api/game/finish', requireAdmin, (req, res) => sendResult(res, doFinish()));

// Reset game
app.post('/api/game/reset', requireAdmin, (req, res) => {
  archiveGame();
  const resetAll = db.transaction(() => {
    stmts.resetSession.run('lobby');
    stmts.deleteAllVotes.run();
    db.prepare('UPDATE players SET score = 0').run();
  });
  resetAll();
  autoTick(); // lobby: clears any pending automatic timer
  broadcastState();
  res.json({ ok: true });
});

// Update game URL
app.post('/api/game/url', requireAdmin, (req, res) => {
  const url = sanitize(req.body.url, 500);
  if (url === undefined) return res.status(400).json({ error: 'Falta url' });
  stmts.updateGameUrl.run(url);
  broadcastState();
  res.json({ ok: true });
});

// --- Admin: Purge all data ---
app.post('/api/admin/purge', requireAdmin, (req, res) => {
  const includeHistory = req.body && req.body.includeHistory === true;
  purgeAllData(includeHistory);
  connectedPlayers.clear();
  autoTick();
  broadcastState();
  res.json({ ok: true });
});

// --- Admin: Get/Set auto-purge config ---
app.get('/api/admin/auto-purge', requireAdmin, (req, res) => {
  const session = db.prepare('SELECT auto_purge_days FROM session WHERE id = 1').get();
  res.json({ autoPurgeDays: session ? session.auto_purge_days : 0 });
});

// --- Admin: automatic advance (mode can be switched in the middle of a game) ---
app.post('/api/admin/auto', requireAdmin, (req, res) => {
  const b = req.body || {};
  const cur = stmts.getSession.get();
  let mode = cur.auto_mode, delay = cur.auto_delay_s, timeout = cur.auto_timeout_s;
  if (b.mode !== undefined) {
    if (b.mode !== 'manual' && b.mode !== 'auto') return res.status(400).json({ error: 'Modo no válido (manual, auto)' });
    mode = b.mode === 'auto' ? 1 : 0;
  }
  if (b.delay !== undefined) {
    if (!Number.isInteger(b.delay) || b.delay < AUTO_DELAY_RANGE[0] || b.delay > AUTO_DELAY_RANGE[1]) {
      return res.status(400).json({ error: `Delay entre ${AUTO_DELAY_RANGE[0]} y ${AUTO_DELAY_RANGE[1]} s` });
    }
    delay = b.delay;
  }
  if (b.timeout !== undefined) {
    if (!Number.isInteger(b.timeout) || b.timeout < AUTO_TIMEOUT_RANGE[0] || b.timeout > AUTO_TIMEOUT_RANGE[1]) {
      return res.status(400).json({ error: `Timeout entre ${AUTO_TIMEOUT_RANGE[0]} y ${AUTO_TIMEOUT_RANGE[1]} s` });
    }
    timeout = b.timeout;
  }
  db.prepare('UPDATE session SET auto_mode = ?, auto_delay_s = ?, auto_timeout_s = ? WHERE id = 1').run(mode, delay, timeout);
  // New delay/timeout apply to the next timer; a mode change acts now (cancel, or resume)
  if (mode !== cur.auto_mode) clearAutoTimer();
  autoTick();
  broadcastState();
  res.json({ ok: true, ...autoInfo(stmts.getSession.get()) });
});

// --- Admin: visual theme (cosmetic; broadcast so TV/players update without reloading)
app.post('/api/admin/theme', requireAdmin, (req, res) => {
  const theme = req.body && req.body.theme;
  if (!THEMES.includes(theme)) return res.status(400).json({ error: `Temática no válida (${THEMES.join(', ')})` });
  db.prepare('UPDATE session SET theme = ? WHERE id = 1').run(theme);
  broadcastState();
  res.json({ ok: true, theme });
});

app.post('/api/admin/auto-purge', requireAdmin, (req, res) => {
  const { days } = req.body;
  const d = parseInt(days);
  if (isNaN(d) || d < 0 || d > 365) return res.status(400).json({ error: 'Valor inválido (0-365)' });
  db.prepare('UPDATE session SET auto_purge_days = ? WHERE id = 1').run(d);
  if (d > 0) {
    db.prepare('UPDATE session SET created_at = CURRENT_TIMESTAMP WHERE id = 1').run();
  }
  res.json({ ok: true, autoPurgeDays: d });
});

// --- Admin: Game history ---
app.get('/api/admin/history', requireAdmin, (req, res) => {
  const games = db.prepare('SELECT * FROM game_history ORDER BY finished_at DESC').all();
  const result = games.map(game => {
    const players = db.prepare(
      'SELECT * FROM game_history_players WHERE game_id = ? ORDER BY position ASC'
    ).all(game.id);
    return { ...game, players };
  });
  res.json({ games: result });
});

app.delete('/api/admin/history/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  db.prepare('DELETE FROM game_history_players WHERE game_id = ?').run(id);
  db.prepare('DELETE FROM game_history WHERE id = ?').run(id);
  res.json({ ok: true });
});

app.delete('/api/admin/history', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM game_history_players').run();
  db.prepare('DELETE FROM game_history').run();
  res.json({ ok: true });
});

// Catch-all: serve index.html for SPA routing (local/Docker-only mode)
// --- Admin: merge duplicate players (e.g. same person joined from two browsers) ---
// Votes of the merged players move to the target; when target and a merged player voted
// the same photo, the target's vote is kept (otherwise the first merged player's), and the
// points of the discarded vote are not added. Merged players disappear; their old ids
// become aliases of the target so their browsers reconnect as the target.
function mergePlayers(targetId, sourceIds) {
  const getPlayer = db.prepare('SELECT * FROM players WHERE id = ?');
  return db.transaction(() => {
    const target = getPlayer.get(targetId);
    if (!target) throw Object.assign(new Error('El jugador destino no existe'), { status: 400 });
    const sources = sourceIds.map(id => getPlayer.get(id));
    if (sources.some(p => !p)) throw Object.assign(new Error('Algún jugador a fusionar no existe'), { status: 400 });

    let score = target.score;
    let movedVotes = 0;
    let droppedVotes = 0;
    for (const src of sources) {
      score += src.score;
      for (const v of db.prepare('SELECT * FROM votes WHERE player_id = ?').all(src.id)) {
        if (stmts.hasVoted.get(targetId, v.photo_id)) {
          db.prepare('DELETE FROM votes WHERE id = ?').run(v.id);
          score -= v.points; // that photo already counts once for the target
          droppedVotes++;
        } else {
          db.prepare('UPDATE votes SET player_id = ? WHERE id = ?').run(targetId, v.id);
          movedVotes++;
        }
      }
      db.prepare('DELETE FROM players WHERE id = ?').run(src.id);
      db.prepare('UPDATE player_aliases SET target_id = ? WHERE target_id = ?').run(targetId, src.id);
      db.prepare('INSERT OR REPLACE INTO player_aliases (old_id, target_id) VALUES (?, ?)').run(src.id, targetId);
    }
    db.prepare('UPDATE players SET score = ? WHERE id = ?').run(Math.max(0, score), targetId);
    return { target: getPlayer.get(targetId), movedVotes, droppedVotes };
  })();
}

app.post('/api/admin/players/merge', requireAdmin, (req, res) => {
  const { targetId, sourceIds } = req.body || {};
  if (!isValidPlayerId(targetId) || !Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 50
      || !sourceIds.every(isValidPlayerId)) {
    return res.status(400).json({ error: 'Selecciona un jugador destino y al menos uno a fusionar' });
  }
  const unique = [...new Set(sourceIds)];
  if (unique.includes(targetId)) return res.status(400).json({ error: 'El destino no puede fusionarse consigo mismo' });

  let result;
  try { result = mergePlayers(targetId, unique); }
  catch (err) { return res.status(err.status || 500).json({ error: err.status ? err.message : 'Error al fusionar' }); }

  // Live sockets of merged players now act as the target (same room, same online entry)
  for (const srcId of unique) {
    const set = connectedPlayers.get(srcId);
    connectedPlayers.delete(srcId);
    for (const sid of set || []) {
      const s = io.sockets.sockets.get(sid);
      if (!s) continue;
      s.leave(`player:${srcId}`);
      s.playerId = targetId;
      s.join(`player:${targetId}`);
      if (!connectedPlayers.has(targetId)) connectedPlayers.set(targetId, new Set());
      connectedPlayers.get(targetId).add(sid);
      s.emit('joined', { playerId: targetId, name: result.target.name });
    }
  }
  // Everyone playing as the target re-learns whether they've voted the current photo
  for (const sid of connectedPlayers.get(targetId) || []) {
    const s = io.sockets.sockets.get(sid);
    if (s) sendVoteStatus(s, targetId);
  }
  autoTick(); // merged votes can complete "everyone voted"
  console.log(`[Merge] ${unique.length} player(s) merged into ${result.target.name}: ${result.movedVotes} votes moved, ${result.droppedVotes} duplicate(s) dropped`);
  broadcastState();
  res.json({ ok: true, player: result.target, movedVotes: result.movedVotes, droppedVotes: result.droppedVotes });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Socket.io ---
function removeConnection(socket) {
  const set = connectedPlayers.get(socket.playerId);
  if (!set) return;
  set.delete(socket.id);
  if (set.size === 0) connectedPlayers.delete(socket.playerId);
}

function isValidPlayerId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 64;
}
// Wrap socket handlers: a malformed message must never crash the whole server
function safeHandler(name, fn) {
  return (...args) => {
    try { fn(...args); } catch (err) { console.error(`[Socket:${name}]`, err.message); }
  };
}

// --- Automatic advance engine (server-side, so TV/admin/players stay consistent) ---
// One pending timer at most, tagged with the phase and photo it belongs to:
//   playing  -> 'reveal:<photoId>' safety timeout (reveal even if votes are missing)
//   revealed -> 'next:<photoId>'   delay, then next photo (or finish after the last one)
// autoTick() is called after anything that can change the outcome (votes, joins, disconnects,
// manual actions, mode changes). Timers re-validate the state when they fire, so a stale timer
// can never act on a photo/game it wasn't created for (no double advance).
let autoTimer = null; // { key, handle, deadline }
function clearAutoTimer() {
  if (autoTimer) clearTimeout(autoTimer.handle);
  autoTimer = null;
}
function setAutoTimer(key, ms, fn) {
  if (autoTimer && autoTimer.key === key) return; // already scheduled for this photo/phase
  clearAutoTimer();
  const t = { key, deadline: Date.now() + ms };
  t.handle = setTimeout(() => {
    if (autoTimer !== t) return;
    autoTimer = null;
    try { fn(); } catch (err) { console.error('[Auto]', err.message); }
  }, ms);
  autoTimer = t;
}
function autoInfo(session) {
  return {
    autoMode: session.auto_mode ? 'auto' : 'manual',
    autoDelay: session.auto_delay_s,
    autoTimeout: session.auto_timeout_s,
    // What the automatic mode will do next and in how many ms (for countdowns in the UI)
    autoPending: autoTimer ? { action: autoTimer.key.split(':')[0], inMs: Math.max(0, autoTimer.deadline - Date.now()) } : null,
  };
}
function autoTick() {
  const session = stmts.getSession.get();
  if (!session.auto_mode || (session.state !== 'playing' && session.state !== 'revealed')) { clearAutoTimer(); return; }
  const photos = stmts.getPhotos.all();
  const photo = photos[session.current_photo_index];
  if (!photo) { clearAutoTimer(); return; }

  if (session.state === 'playing') {
    // "Everyone" = players connected right now (same notion as the TV vote counter). With nobody
    // connected (server restart, total wifi drop) we don't guess: the safety timeout covers it.
    const voters = new Set(stmts.getVotesForPhoto.all(photo.id).map(v => v.player_id));
    const online = [...connectedPlayers.keys()];
    if (online.length > 0 && online.every(id => voters.has(id))) {
      clearAutoTimer();
      console.log(`[Auto] all ${online.length} connected player(s) voted photo ${session.current_photo_index + 1}: reveal`);
      doReveal();
      return;
    }
    setAutoTimer(`reveal:${photo.id}`, session.auto_timeout_s * 1000, () => {
      const s = stmts.getSession.get();
      const cur = stmts.getPhotos.all()[s.current_photo_index];
      if (!s.auto_mode || s.state !== 'playing' || !cur || cur.id !== photo.id) return autoTick();
      console.log(`[Auto] safety timeout (${s.auto_timeout_s}s) on photo ${s.current_photo_index + 1}: reveal`);
      doReveal();
    });
  } else {
    setAutoTimer(`next:${photo.id}`, session.auto_delay_s * 1000, () => {
      const s = stmts.getSession.get();
      const all = stmts.getPhotos.all();
      const cur = all[s.current_photo_index];
      if (!s.auto_mode || s.state !== 'revealed' || !cur || cur.id !== photo.id) return autoTick();
      if (s.current_photo_index + 1 >= all.length) { console.log('[Auto] last photo: finish'); doFinish(); }
      else doNext();
    });
  }
}
// A disconnect can complete "everyone voted"; wait briefly so a page reload isn't counted as leaving
function autoTickSoon() { setTimeout(() => { try { autoTick(); broadcastState(); } catch (e) { console.error('[Auto]', e.message); } }, 1500); }

// Tell a player's socket if it already voted for the current photo, and the result if revealed
function sendVoteStatus(socket, playerId) {
  const session = stmts.getSession.get();
  const photos = stmts.getPhotos.all();
  const currentPhoto = photos[session.current_photo_index];
  if (!currentPhoto) return;
  const existingVote = db.prepare('SELECT * FROM votes WHERE player_id = ? AND photo_id = ?').get(playerId, currentPhoto.id);
  let result = null;
  if (existingVote && session.state === 'revealed') {
    const author = db.prepare('SELECT name FROM authors WHERE id = ?').get(currentPhoto.author_id);
    const correct = existingVote.voted_for_author_id === currentPhoto.author_id;
    result = { photoId: currentPhoto.id, correct, points: correct ? 3 : 0, authorName: author ? author.name : 'Desconocido' };
  }
  socket.emit('vote_status', { photoId: currentPhoto.id, hasVoted: !!existingVote, result });
}

const connectedPlayers = new Map(); // playerId -> Set<socketId> (a player may have several tabs)

io.on('connection', (socket) => {
  console.log(`Socket conectado: ${socket.id}`);

  // Send current state on connect
  const state = getFullState();
  socket.emit('state_update', statePayload(state));
  socket.emit('players_update', { players: state.players });

  socket.on('join', safeHandler('join', (payload) => {
    const { playerId, name } = payload || {};
    if (!isValidPlayerId(playerId) || typeof name !== 'string') return;
    const safeName = sanitize(name, 30);
    if (!safeName) { socket.emit('join_error', { error: 'Nombre no válido' }); return; }

    // Identity: a playerId that exists in the current game reconnects to that player (name,
    // votes and points kept). An id that was merged into another player reconnects as that
    // player. Any other id (unknown, or wiped by a purge) simply starts a new player.
    let finalId = playerId;
    let finalName = safeName;
    const alias = db.prepare('SELECT target_id FROM player_aliases WHERE old_id = ?').get(playerId);
    const aliasTarget = alias && db.prepare('SELECT * FROM players WHERE id = ?').get(alias.target_id);
    if (aliasTarget) { finalId = aliasTarget.id; finalName = aliasTarget.name; }

    if (socket.playerId && socket.playerId !== finalId) {
      removeConnection(socket);
      socket.leave(`player:${socket.playerId}`);
    }
    socket.playerId = finalId;
    socket.join(`player:${finalId}`);
    if (!connectedPlayers.has(finalId)) connectedPlayers.set(finalId, new Set());
    connectedPlayers.get(finalId).add(socket.id);
    if (aliasTarget) stmts.updatePlayerSeen.run(finalId);
    else stmts.upsertPlayer.run(finalId, finalName);
    socket.emit('joined', { playerId: finalId, name: finalName });

    sendVoteStatus(socket, finalId);
    autoTick();
    broadcastState();
  }));

  socket.on('vote', safeHandler('vote', (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const { playerId, authorId, photoId } = payload || {};
    if (!isValidPlayerId(playerId) || !Number.isInteger(authorId)) return reply({ ok: false, reason: 'invalid' });
    // Socket must have joined, and can only vote with its own playerId
    if (!socket.playerId || socket.playerId !== playerId) return reply({ ok: false, reason: 'not_joined' });

    const session = stmts.getSession.get();
    if (session.state !== 'playing') return reply({ ok: false, reason: 'closed' });

    const photos = stmts.getPhotos.all();
    const currentPhoto = photos[session.current_photo_index];
    if (!currentPhoto) return reply({ ok: false, reason: 'closed' });
    // Vote was meant for a previous photo (e.g. retried after reconnect): reject, don't misassign
    if (photoId !== undefined && photoId !== currentPhoto.id) return reply({ ok: false, reason: 'closed' });
    if (!db.prepare('SELECT id FROM authors WHERE id = ?').get(authorId)) return reply({ ok: false, reason: 'invalid' });

    // Already voted: idempotent success (safe for client retries)
    const existing = stmts.hasVoted.get(playerId, currentPhoto.id);
    if (existing) return reply({ ok: true, photoId: currentPhoto.id, duplicate: true });

    const isCorrect = currentPhoto.author_id === authorId ? 1 : 0;
    stmts.addVote.run(playerId, currentPhoto.id, authorId, isCorrect, 0); // Points assigned on reveal
    reply({ ok: true, photoId: currentPhoto.id });

    // Broadcast updated vote counts
    const votes = stmts.getVotesForPhoto.all(currentPhoto.id);
    const counts = {};
    for (const v of votes) {
      counts[v.voted_for_author_id] = (counts[v.voted_for_author_id] || 0) + 1;
    }
    io.emit('vote_count', {
      photoId: currentPhoto.id,
      counts,
      totalVoters: votes.length,
      totalPlayers: expectedVoters(votes),
    });
    if (session.auto_mode) autoTick();
  }));

  socket.on('disconnect', () => {
    console.log(`Socket desconectado: ${socket.id}`);
    if (socket.playerId) {
      removeConnection(socket);
      io.emit('players_online', { online: [...connectedPlayers.keys()] });
      if (stmts.getSession.get().auto_mode) autoTickSoon();
    }
  });
});

// Periodic broadcast of online players
setInterval(() => {
  io.emit('players_online', { online: [...connectedPlayers.keys()] });
}, 5000);

// --- Error handler (no stack traces in production) ---
app.use((err, req, res, _next) => {
  console.error('[Error]', err.message);
  res.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Error interno' : err.message });
});

process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Photo Quiz server running on port ${PORT}`);
  autoTick(); // resume automatic mode after a restart (arms the safety timeout)
  console.log(`Admin password: ${ADMIN_PASSWORD === 'photoquiz' ? 'DEFAULT (photoquiz) — change ADMIN_PASSWORD env var!' : 'custom (set via env)'}`);
});
