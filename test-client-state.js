#!/usr/bin/env node
/**
 * Prueba del estado del CLIENTE (index.html) con eventos reales del servidor.
 * Ejecuta el app() real de index.html en Node (socket.io-client real) contra un servidor
 * LOCAL y reproduce el escenario del bug "authors vacía":
 *   - TV y jugador conectan ANTES de que existan autores
 *   - el admin crea autores/fotos y empieza: TV y jugador reciben autores sin recargar
 *   - un jugador que entra a mitad de partida ve autores y puede votar (ack real)
 *   - al revelar: nombre del autor en TV, en el jugador que NO votó y en el que SÍ votó
 *   - TV que recarga durante la revelación recupera el nombre desde /api/state
 *
 * Uso (SOLO local; crea datos):  ADMIN_PASSWORD=xxx node test-client-state.js http://localhost:3001
 */
const fs = require('fs');
const path = require('path');
const { io: realIo } = require('socket.io-client');

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const PASS = process.env.ADMIN_PASSWORD;
const failures = [];
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures.push(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const UA = 'Mozilla/5.0 PhotoQuizClientTest/1.0';

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const start = html.indexOf('function app()');
const APP_CODE = html.slice(start, html.indexOf('</script>', start));

// Markup sanity: vote buttons and TV bars are driven by `authors`
check(/x-for="a in authors"[\s\S]{0,200}@click="vote\(a\.id\)"/.test(html), 'markup: botones de voto del jugador iteran sobre authors');
check(/<!-- TV: Playing -->[\s\S]*?x-for="a in authors"/.test(html), 'markup: barras de la TV iteran sobre authors');
check(/'📸 ' \+ revealedAuthorName/.test(html) && /'Autor: ' \+ revealedAuthorName/.test(html), 'markup: TV y jugador-sin-voto pintan revealedAuthorName');

function makeClient(view, playerName) {
  const store = {};
  const ls = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  if (playerName) ls.setItem('pq_playerName', playerName);
  const sockets = [];
  const ioShim = (opts) => { const s = realIo(BASE, { ...opts, extraHeaders: { 'User-Agent': UA } }); sockets.push(s); return s; };
  const fetchShim = (url, opts = {}) => fetch(url.startsWith('http') ? url : BASE + url, { ...opts, headers: { ...(opts.headers || {}), 'User-Agent': UA } });
  const app = new Function('localStorage', 'sessionStorage', 'window', 'io', 'fetch', 'document', 'QRCode', 'alert', 'confirm',
    `${APP_CODE}; return app();`)(
    ls, { getItem: () => '', setItem() {}, removeItem() {} },
    { location: { search: `?view=${view}`, href: `${BASE}/?view=${view}` }, history: { replaceState() {} } },
    ioShim, fetchShim, { getElementById: () => null }, { toCanvas() {} }, () => {}, () => true);
  app.$watch = () => {};
  app.$nextTick = (f) => f && setTimeout(f, 0);
  app.init();
  app.close = () => sockets.forEach(s => s.disconnect());
  return app;
}

async function admin(method, url, body, isForm) {
  const headers = { 'User-Agent': UA };
  if (admin.token) headers['X-Admin-Token'] = admin.token;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  if (!PASS) { console.error('Falta ADMIN_PASSWORD'); process.exit(2); }
  admin.token = (await admin('POST', '/api/admin/login', { password: PASS })).json.token;
  const st0 = (await admin('GET', '/api/state')).json;
  if (st0.authors.length || st0.photos.length || st0.session.state !== 'lobby') {
    console.error('ABORTADO: el servidor debe estar vacío y en lobby (prueba solo para local)'); process.exit(3);
  }

  console.log('\n[1] TV y jugador conectan con authors vacía');
  const tv = makeClient('tv');
  const early = makeClient('player', 'Temprano 📱');
  const passive = makeClient('player', 'Mirón');
  await sleep(1200);
  check(tv.authors.length === 0 && early.authors.length === 0, 'al conectar no hay autores (escenario del bug)');

  console.log('\n[2] El admin crea autores y fotos, y empieza (sin recargar clientes)');
  const names = ['Ana Fotógrafa', 'Bruno 📷', 'Carla'];
  const ids = [];
  for (const n of names) ids.push((await admin('POST', '/api/authors', { name: n })).json.id);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  for (let i = 0; i < 2; i++) {
    const f = new FormData();
    f.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), `t${i}.jpg`);
    f.append('author_id', String(ids[i]));
    await admin('POST', '/api/upload', f, true);
  }
  await sleep(500);
  check(tv.authors.length === 3 && early.authors.length === 3, `TV y jugador temprano reciben ${early.authors.length} autores por state_update (botones/barras)`);
  check(early.authors.every(a => names.includes(a.name)), 'nombres intactos (acentos/emoji)');
  check((await admin('POST', '/api/game/start')).status === 200, 'start OK');
  await sleep(600);
  check(early.gameState === 'playing' && tv.gameState === 'playing', 'TV y jugador en playing');

  console.log('\n[3] Jugador que entra a mitad de partida');
  const late = makeClient('player', 'Tardío');
  await sleep(1200);
  check(late.authors.length === 3, `jugador tardío ve ${late.authors.length} autores`);
  const stP = (await admin('GET', '/api/state')).json;
  const correct = stP.currentPhoto.author_id;
  const wrong = ids.find(i => i !== correct);
  early.vote(correct);
  late.vote(wrong);
  await sleep(1500);
  check(early.hasVotedCurrent && !early.voteError, 'jugador temprano vota por la UI (ack del servidor)');
  check(late.hasVotedCurrent && !late.voteError, 'jugador tardío vota por la UI (ack del servidor)');
  check(tv.totalVoters === 2, `TV: contador de votos = ${tv.totalVoters}`);

  console.log('\n[4] Revelación');
  const rev = await admin('POST', '/api/game/reveal');
  const authorName = rev.json.authorName;
  await sleep(800);
  check(tv.revealedAuthorName === authorName, `TV muestra "📸 ${tv.revealedAuthorName}" (esperado ${authorName})`);
  check(passive.lastVoteResult === null && passive.revealedAuthorName === authorName, `jugador que NO votó: "Autor: ${passive.revealedAuthorName}"`);
  check(early.lastVoteResult && early.lastVoteResult.correct && early.lastVoteResult.authorName === authorName, 'jugador que acertó: "¡Acertaste!" + nombre');
  check(late.lastVoteResult && !late.lastVoteResult.correct && late.lastVoteResult.authorName === authorName, 'jugador que falló: "Fallaste" + nombre');
  check(tv.ranking.length >= 2 && tv.ranking[0].score === 3, `ranking TV correcto (líder ${tv.ranking[0] && tv.ranking[0].name} con ${tv.ranking[0] && tv.ranking[0].score})`);
  const stR = (await admin('GET', '/api/state')).json;
  check(stR.currentPhotoAuthorName === authorName, '/api/state incluye currentPhotoAuthorName durante la revelación');

  console.log('\n[5] La TV recarga durante la revelación');
  tv.close();
  const tv2 = makeClient('tv');
  await sleep(1200);
  check(tv2.gameState === 'revealed' && tv2.revealedAuthorName === authorName, `TV recargada muestra "📸 ${tv2.revealedAuthorName}"`);

  console.log('\n[6] No se filtra la respuesta antes de revelar');
  await admin('POST', '/api/game/next');
  await sleep(600);
  const stN = (await admin('GET', '/api/state')).json;
  check(stN.session.state === 'playing' && stN.currentPhotoAuthorName === undefined, '/api/state en playing NO lleva el nombre del autor');
  const leak = await new Promise((resolve) => {
    const s = realIo(BASE, { transports: ['websocket'], extraHeaders: { 'User-Agent': UA } });
    s.once('state_update', d => { s.disconnect(); resolve(d); });
  });
  check(leak.state === 'playing' && leak.currentPhotoAuthorName === undefined && leak.currentPhotoAuthorId === undefined, 'state_update en playing NO lleva autor de la foto');

  [tv2, early, passive, late].forEach(c => c.close());
  await admin('POST', '/api/admin/purge', { includeHistory: true });
  console.log(`\n=== ${failures.length ? failures.length + ' FALLOS' : 'OK'} ===`);
  failures.forEach(f => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error('Error fatal:', e); process.exit(1); });
