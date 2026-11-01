#!/usr/bin/env node
/**
 * Ensayo general de Photo Quiz: partida completa con N jugadores simulados,
 * validando las garantías que importan en directo.
 *
 * Uso:
 *   ADMIN_PASSWORD=xxx node rehearsal.js <BASE_URL> [opciones]
 *
 * Opciones:
 *   --players N        jugadores simulados (default 18)
 *   --photos N         fotos a usar (default 6, subidas desde ./photos o generadas)
 *   --restart-at K     pausa tras revelar la foto K para que reinicies el contenedor
 *                      (docker compose restart) y comprueba que el estado sobrevive
 *   --cleanup          al terminar, purga los datos de juego (conserva historial)
 *   --force            permite ejecutar aunque ya haya fotos/partida en curso (¡cuidado!)
 *   --stagger MS       ms entre conexiones de jugadores (default 100 => ráfaga suave)
 *
 * Comprueba:
 *   - transport websocket (no se queda en polling)
 *   - joins casi simultáneos sin 403/429/challenge
 *   - cada voto confirmado por ack del servidor; voto doble = idempotente; voto tardío = rechazado
 *   - desconexión/reconexión a mitad de ronda: recupera hasVoted y resultado tras revelar
 *   - contador de votos coherente entre clientes y /api/state
 *   - puntuaciones finales = 3 x aciertos registrados por el cliente
 */
const fs = require('fs');
const path = require('path');
const { io } = require('socket.io-client');

const args = process.argv.slice(2);
const BASE = (args.find(a => !a.startsWith('--') && /^https?:/.test(a)) || 'http://localhost:3001').replace(/\/$/, '');
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name) => args.includes(`--${name}`);
const N_PLAYERS = parseInt(opt('players', 18), 10);
const N_PHOTOS = parseInt(opt('photos', 6), 10);
const RESTART_AT = parseInt(opt('restart-at', 0), 10);
const STAGGER = parseInt(opt('stagger', 100), 10);
const PASS = process.env.ADMIN_PASSWORD;

const failures = [];
const check = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { console.log(`  ✗ ${msg}`); failures.push(msg); } };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let token = '';

async function api(method, url, body, isForm) {
  const headers = { 'X-Admin-Token': token };
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  if (!json && res.status >= 400) {
    console.log(`  ! ${method} ${url} -> ${res.status} respuesta NO-JSON (¿WAF/proxy?): ${text.slice(0, 120).replace(/\s+/g, ' ')}`);
  }
  return { status: res.status, json };
}

function makePlayer(i) {
  const p = {
    i, id: `rehearsal-${Date.now().toString(36)}-${i}`, name: `Sim ${String(i + 1).padStart(2, '0')} ${['🎉', 'Ñandú', 'José', 'Zoë'][i % 4]}`,
    socket: null, state: null, photoId: null, voted: {}, results: {}, expectedScore: 0, counts: null, connectErrors: 0,
  };
  p.connect = () => new Promise((resolve) => {
    const s = io(BASE, { transports: ['polling', 'websocket'], reconnection: true, timeout: 10000 });
    p.socket = s;
    s.on('connect', () => { s.emit('join', { playerId: p.id, name: p.name }); resolve(); });
    s.on('connect_error', (e) => { p.connectErrors++; p.lastError = e.message; });
    s.on('state_update', (d) => { p.state = d.state; p.photoId = d.currentPhotoId; });
    s.on('vote_status', (d) => { p.lastStatus = d; if (d.result) p.results[d.photoId] = d.result; });
    s.on('vote_result', (d) => { p.results[d.photoId] = d; });
    s.on('vote_count', (d) => { p.counts = d; });
  });
  // Same retry policy as index.html: re-join on not_joined, retry on timeout, up to 5 times
  p.vote = async (authorId, photoId) => {
    let res;
    for (let attempt = 0; attempt <= 5; attempt++) {
      res = await new Promise((resolve) => {
        p.socket.timeout(4000).emit('vote', { playerId: p.id, authorId, photoId }, (err, r) => resolve(err ? { ok: false, reason: 'timeout' } : r));
      });
      if (res.ok || res.reason === 'closed' || res.reason === 'invalid') return res;
      if (res.reason === 'not_joined') p.socket.emit('join', { playerId: p.id, name: p.name });
      p.retries = (p.retries || 0) + 1;
      await sleep(1000);
    }
    return res;
  };
  return p;
}

async function main() {
  console.log(`=== Ensayo general contra ${BASE} (${N_PLAYERS} jugadores, ${N_PHOTOS} fotos) ===\n`);
  if (!PASS) { console.error('Falta ADMIN_PASSWORD en el entorno'); process.exit(2); }

  // --- Login + whoami
  const login = await api('POST', '/api/admin/login', { password: PASS });
  if (!login.json || !login.json.token) { console.error('Login fallido:', login.status, login.json); process.exit(2); }
  token = login.json.token;
  console.log('[1] Admin / trust proxy');
  const who = await api('GET', '/api/admin/whoami');
  if (who.status === 200) {
    console.log('  whoami:', JSON.stringify(who.json));
    const isLocal = /localhost|127\.0\.0\.1/.test(BASE);
    if (isLocal) console.log('  (BASE local: req.ip loopback es lo esperado)');
    else check(who.json.ip && !/^(127\.|::1|::ffff:127\.|172\.(1[6-9]|2\d|3[01])\.|::ffff:172\.)/.test(who.json.ip),
      `req.ip (${who.json.ip}) no es loopback ni la red docker`);
  } else console.log(`  (whoami no disponible: HTTP ${who.status} — versión antigua desplegada)`);

  // --- Safety guard
  const st0 = (await api('GET', '/api/state')).json;
  if (!flag('force') && (st0.session.state !== 'lobby' || st0.photos.length > 0)) {
    console.error(`\nABORTADO: el servidor tiene datos (estado=${st0.session.state}, ${st0.photos.length} fotos). Usa --force si es intencionado.`);
    process.exit(3);
  }

  // --- Authors + photos
  console.log('\n[2] Autores y fotos');
  const authorIds = [];
  for (let i = 0; i < Math.min(N_PHOTOS, 6); i++) {
    const r = await api('POST', '/api/authors', { name: `Autor Ensayo ${i + 1}` });
    authorIds.push(r.json.id);
  }
  const local = fs.existsSync(path.join(__dirname, 'photos'))
    ? fs.readdirSync(path.join(__dirname, 'photos')).filter(f => /\.(jpe?g|png|webp)$/i.test(f)) : [];
  let uploaded = 0;
  for (let i = 0; i < N_PHOTOS; i++) {
    const buf = local.length ? fs.readFileSync(path.join(__dirname, 'photos', local[i % local.length]))
      : Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
    const form = new FormData();
    form.append('photo', new Blob([buf], { type: 'image/jpeg' }), `ensayo${i}.jpg`);
    form.append('author_id', String(authorIds[i % authorIds.length]));
    const r = await api('POST', '/api/upload', form, true);
    if (r.status === 200) uploaded++; else console.log(`  ! upload ${i} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  check(uploaded === N_PHOTOS, `${uploaded}/${N_PHOTOS} fotos subidas`);

  // --- Players
  console.log(`\n[3] ${N_PLAYERS} joins casi simultáneos (stagger ${STAGGER}ms)`);
  const players = Array.from({ length: N_PLAYERS }, (_, i) => makePlayer(i));
  const t0 = Date.now();
  await Promise.all(players.map((p, i) => sleep(i * STAGGER).then(p.connect)));
  await sleep(1500);
  check(players.every(p => p.socket.connected), `todos conectados en ${Date.now() - t0}ms`);
  const transports = players.map(p => p.socket.io.engine.transport.name);
  check(transports.every(t => t === 'websocket'), `transport websocket en todos (${transports.filter(t => t === 'websocket').length}/${N_PLAYERS})`);
  check(players.every(p => p.connectErrors === 0), `sin connect_error (${players.filter(p => p.connectErrors).map(p => p.lastError).join(', ') || 'ninguno'})`);
  const st1 = (await api('GET', '/api/state')).json;
  check(players.every(p => st1.players.some(x => x.id === p.id && x.name === p.name)), 'todos registrados con su nombre (emoji/acentos intactos)');

  // --- Game
  const histBefore = (await api('GET', '/api/admin/history')).json.games.length;
  console.log('\n[4] Partida');
  const start = await api('POST', '/api/game/start');
  check(start.status === 200, 'start OK');
  await sleep(800);
  const photosOrdered = (await api('GET', '/api/state')).json.photos;

  for (let k = 0; k < N_PHOTOS; k++) {
    const st = (await api('GET', '/api/state')).json;
    const photo = st.currentPhoto;
    console.log(`  -- Foto ${k + 1}/${N_PHOTOS} (id ${photo.id})`);
    check(players.every(p => p.photoId === photo.id && p.state === 'playing'), 'todos los clientes ven la misma foto en playing');

    // Forced disconnect of 3 players before voting; they reconnect and vote
    const dropped = players.slice(0, 3);
    dropped.forEach(p => p.socket.io.engine.close());

    // Burst of votes (all in parallel)
    const choices = players.map(() => authorIds[Math.floor(Math.random() * authorIds.length)]);
    const acks = await Promise.all(players.map((p, i) => p.vote(choices[i], photo.id)));
    const ok = acks.filter(a => a && a.ok).length;
    check(ok === N_PLAYERS, `ráfaga de votos: ${ok}/${N_PLAYERS} confirmados (incl. 3 reconectando; reintentos: ${players.reduce((n, p) => n + (p.retries || 0), 0)})`);
    players.forEach(p => { p.retries = 0; });
    players.forEach((p, i) => { p.voted[photo.id] = choices[i]; });

    // Duplicate vote must be idempotent, not double-counted
    const dup = await players[5].vote(authorIds[0], photo.id);
    check(dup && dup.ok && dup.duplicate, 'voto doble = idempotente');
    await sleep(500);
    const stV = (await api('GET', '/api/state')).json;
    check(stV.totalVoters === N_PLAYERS, `servidor cuenta ${stV.totalVoters} votos (esperado ${N_PLAYERS})`);
    const seen = players.map(p => p.counts && p.counts.totalVoters);
    check(seen.every(v => v === N_PLAYERS), 'todos los clientes ven el mismo contador');
    check(players[0].counts && players[0].counts.totalPlayers === N_PLAYERS, `denominador TV = ${players[0].counts && players[0].counts.totalPlayers} (sin jugadores fantasma)`);

    // Player 4 drops right before reveal and comes back after
    players[3].socket.disconnect();
    const rev = await api('POST', '/api/game/reveal');
    check(rev.status === 200, `reveal OK (${rev.json && rev.json.authorName})`);
    await sleep(700);
    const late = await players[6].vote(authorIds[0], photo.id);
    check(late && !late.ok && late.reason === 'closed', 'voto tras revelar rechazado');
    players[3].socket.connect();
    await sleep(1500);
    const correctAuthor = photosOrdered.find(x => x.id === photo.id).author_id;
    check(players[3].results[photo.id] && players[3].results[photo.id].correct === (players[3].voted[photo.id] === correctAuthor),
      'jugador desconectado durante el reveal recupera su resultado al reconectar');
    players.forEach(p => { if (p.voted[photo.id] === correctAuthor) p.expectedScore += 3; });
    check(players.filter(p => p !== players[3]).every(p => p.results[photo.id]), 'resto recibió vote_result');

    if (RESTART_AT && k + 1 === RESTART_AT) {
      console.log('\n  >>> REINICIA EL CONTENEDOR AHORA (docker compose restart). Esperando a que vuelva...');
      await sleep(5000);
      for (let t = 0; t < 120; t++) {
        try { const r = await fetch(BASE + '/api/state'); if (r.ok) break; } catch {}
        await sleep(1000);
      }
      await sleep(6000); // let sockets reconnect
      const relog = await api('POST', '/api/admin/login', { password: PASS });
      token = relog.json.token;
      const after = (await api('GET', '/api/state')).json;
      check(after.session.state === 'revealed' && after.currentPhoto.id === photo.id, 'tras reinicio: misma foto y estado revealed');
      check(players.every(p => after.players.find(x => x.id === p.id).score === p.expectedScore), 'tras reinicio: puntuaciones intactas');
      check(players.every(p => p.socket.connected), 'tras reinicio: todos los sockets reconectados solos');
    }

    if (k < N_PHOTOS - 1) {
      const nx = await api('POST', '/api/game/next');
      check(nx.status === 200, 'next OK');
      const nx2 = await api('POST', '/api/game/next');
      check(nx2.status === 400, 'doble next bloqueado (no salta foto)');
      await sleep(800);
    }
  }

  // --- Finish
  console.log('\n[5] Final');
  const fin = await api('POST', '/api/game/finish');
  check(fin.status === 200, 'finish OK');
  const h1 = (await api('GET', '/api/admin/history')).json.games;
  const archivedVotes = h1[0].players.reduce((n, p) => n + p.total_votes, 0);
  check(h1.length === histBefore + 1, `finish archiva exactamente 1 partida (${histBefore} -> ${h1.length})`);
  check(archivedVotes === N_PLAYERS * N_PHOTOS, `partida archivada CON votos reales: ${archivedVotes} (esperado ${N_PLAYERS * N_PHOTOS})`);
  const fin2 = await api('POST', '/api/game/finish');
  const h2 = (await api('GET', '/api/admin/history')).json.games.length;
  check(h2 === h1.length, `doble finish no duplica historial (${h1.length} -> ${h2}, HTTP ${fin2.status})`);
  const rst = await api('POST', '/api/game/reset');
  const h3 = (await api('GET', '/api/admin/history')).json.games.length;
  check(rst.status === 200 && h3 === h1.length, `finish + reset no duplica historial (${h1.length} -> ${h3})`);

  // Reset mid-game (no finish) with votes: must archive exactly once, and a later reset must not archive again
  await api('POST', '/api/game/start');
  await sleep(800);
  const stR = (await api('GET', '/api/state')).json;
  await Promise.all(players.map(p => p.vote(authorIds[0], stR.currentPhoto.id)));
  await api('POST', '/api/game/reset');
  const h4 = (await api('GET', '/api/admin/history')).json.games.length;
  await api('POST', '/api/game/reset');
  const h5 = (await api('GET', '/api/admin/history')).json.games.length;
  check(h4 === h3 + 1 && h5 === h4, `reset a mitad de partida con votos archiva 1 vez y no repite (${h3} -> ${h4} -> ${h5})`);
  const finalPlayers = (await api('GET', '/api/admin/history')).json.games.find(g => g.id === h1[0].id).players;
  check(players.every(p => (finalPlayers.find(x => x.player_name === p.name) || {}).score === p.expectedScore), 'puntuación archivada = 3 x aciertos de cada jugador');

  players.forEach(p => p.socket.disconnect());
  if (flag('cleanup')) {
    await api('POST', '/api/admin/purge', { includeHistory: false });
    console.log('  (datos de ensayo purgados; historial conservado)');
  }

  console.log(`\n=== ${failures.length === 0 ? 'ENSAYO OK' : `${failures.length} FALLOS`} ===`);
  failures.forEach(f => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
