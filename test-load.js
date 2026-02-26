/**
 * Test de carga para Photo Quiz
 * Simula 30 jugadores conectándose, votando y midiendo latencia.
 *
 * Uso: node test-load.js [url] [numPlayers]
 *   url: URL del servidor Socket.io (default: http://localhost:3001)
 *   numPlayers: número de jugadores simulados (default: 30)
 */

const { io } = require('socket.io-client');

const SERVER_URL = process.argv[2] || 'http://localhost:3001';
const NUM_PLAYERS = parseInt(process.argv[3]) || 30;

const stats = {
  connected: 0,
  connectErrors: 0,
  disconnects: 0,
  votesSent: 0,
  voteResultsReceived: 0,
  connectTimes: [],
  voteTimes: [],
};

const sockets = [];
let authors = [];
let gameState = 'lobby';
let currentPhotoId = null;

function randomName() {
  const names = ['Ana', 'Bob', 'Carlos', 'Diana', 'Eva', 'Felix', 'Greta', 'Hugo', 'Irene', 'Juan',
    'Karla', 'Leo', 'Marta', 'Nico', 'Olga', 'Pablo', 'Rita', 'Sam', 'Tina', 'Uri',
    'Vera', 'Will', 'Xena', 'Yago', 'Zara', 'Alex', 'Bea', 'Cris', 'Dan', 'Eli'];
  return names[Math.floor(Math.random() * names.length)] + '_' + Math.floor(Math.random() * 1000);
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

async function fetchAuthors() {
  try {
    const res = await fetch(`${SERVER_URL}/api/state`);
    const data = await res.json();
    authors = data.authors;
    console.log(`Autores disponibles: ${authors.map(a => a.name).join(', ') || 'ninguno'}`);
  } catch (e) {
    console.error('Error obteniendo estado:', e.message);
  }
}

function connectPlayer(index) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const playerId = generateUUID();
    const name = randomName();

    const socket = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      timeout: 10000,
    });

    socket.playerId = playerId;
    socket.playerName = name;

    socket.on('connect', () => {
      const connectTime = Date.now() - startTime;
      stats.connected++;
      stats.connectTimes.push(connectTime);
      socket.emit('join', { playerId, name });
      resolve(socket);
    });

    socket.on('connect_error', (err) => {
      stats.connectErrors++;
      console.error(`  [${index}] Error de conexión: ${err.message}`);
      resolve(null);
    });

    socket.on('state_update', (data) => {
      gameState = data.state;
      currentPhotoId = data.currentPhotoId;
    });

    socket.on('vote_result', () => {
      stats.voteResultsReceived++;
    });

    socket.on('disconnect', () => {
      stats.disconnects++;
    });

    sockets.push(socket);
  });
}

function castVote(socket) {
  if (authors.length === 0 || !currentPhotoId) return;

  const randomAuthor = authors[Math.floor(Math.random() * authors.length)];
  const startTime = Date.now();

  socket.emit('vote', { playerId: socket.playerId, authorId: randomAuthor.id });
  stats.votesSent++;
  stats.voteTimes.push(Date.now() - startTime);
}

function avg(arr) {
  if (arr.length === 0) return 0;
  return (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1);
}

function p95(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.95)];
}

async function run() {
  console.log('='.repeat(50));
  console.log(`Photo Quiz - Test de Carga`);
  console.log(`Servidor: ${SERVER_URL}`);
  console.log(`Jugadores: ${NUM_PLAYERS}`);
  console.log('='.repeat(50));
  console.log('');

  // Fetch authors first
  await fetchAuthors();
  console.log('');

  // Phase 1: Connect all players
  console.log('--- Fase 1: Conectando jugadores ---');
  const connectStart = Date.now();

  const connections = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    connections.push(connectPlayer(i));
    // Stagger connections slightly to be realistic
    await new Promise(r => setTimeout(r, 50));
  }

  const connectedSockets = (await Promise.all(connections)).filter(Boolean);
  const connectDuration = Date.now() - connectStart;

  console.log(`  Conectados: ${stats.connected}/${NUM_PLAYERS} en ${connectDuration}ms`);
  console.log(`  Errores de conexión: ${stats.connectErrors}`);
  console.log(`  Tiempo medio de conexión: ${avg(stats.connectTimes)}ms`);
  console.log(`  P95 tiempo de conexión: ${p95(stats.connectTimes)}ms`);
  console.log('');

  // Phase 2: Wait for game to be in playing state, then vote
  console.log('--- Fase 2: Votación ---');
  if (gameState !== 'playing') {
    console.log('  Esperando a que el juego esté en estado "playing"...');
    console.log('  (Inicia el juego desde el panel Admin)');

    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (gameState === 'playing') {
          clearInterval(check);
          resolve();
        }
      }, 500);
      // Timeout after 2 minutes
      setTimeout(() => { clearInterval(check); resolve(); }, 120000);
    });
  }

  if (gameState === 'playing') {
    console.log('  Juego en curso. Votando...');
    await fetchAuthors(); // Refresh authors

    const voteStart = Date.now();
    for (const socket of connectedSockets) {
      castVote(socket);
      await new Promise(r => setTimeout(r, 20)); // Small delay between votes
    }
    const voteDuration = Date.now() - voteStart;

    // Wait for results
    await new Promise(r => setTimeout(r, 2000));

    console.log(`  Votos enviados: ${stats.votesSent} en ${voteDuration}ms`);
    console.log(`  Resultados recibidos: ${stats.voteResultsReceived}`);
    console.log(`  Tiempo medio de emisión de voto: ${avg(stats.voteTimes)}ms`);
  } else {
    console.log('  Timeout esperando juego. Saltando fase de votación.');
  }

  console.log('');

  // Phase 3: Stats
  console.log('--- Resumen ---');
  console.log(`  Conexiones exitosas:  ${stats.connected}/${NUM_PLAYERS}`);
  console.log(`  Errores de conexión:  ${stats.connectErrors}`);
  console.log(`  Desconexiones:        ${stats.disconnects}`);
  console.log(`  Tiempo medio conexión: ${avg(stats.connectTimes)}ms`);
  console.log(`  P95 conexión:          ${p95(stats.connectTimes)}ms`);
  console.log(`  Votos enviados:        ${stats.votesSent}`);
  console.log(`  Resultados recibidos:  ${stats.voteResultsReceived}`);
  console.log('');

  // Cleanup
  console.log('Desconectando jugadores...');
  for (const socket of sockets) {
    if (socket) socket.disconnect();
  }

  console.log('Test completado.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Error fatal:', err);
  process.exit(1);
});
