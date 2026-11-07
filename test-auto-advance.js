#!/usr/bin/env node
/**
 * Prueba del modo AUTOMÁTICO de avance (sockets + API) contra un servidor LOCAL con BD aislada.
 * Cubre: flujo feliz con tiempos, falta un voto (revelar a mano / timeout de seguridad), desconexión
 * que completa los votos, el admin se adelanta (sin doble avance), cambio de modo en caliente, timers
 * huérfanos tras reset/finish, y que cada foto se revela una sola vez.
 *
 * Uso (SOLO local; crea y BORRA datos):  ADMIN_PASSWORD=xxx node test-auto-advance.js http://localhost:3001
 */
const { io } = require('socket.io-client');

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const PASS = process.env.ADMIN_PASSWORD;
const UA = 'Mozilla/5.0 PhotoQuizAutoTest/1.0';
const failures = [];
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures.push(m); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uuid = () => require('crypto').randomUUID();
let token;
async function api(method, url, body, isForm) {
  const headers = { 'User-Agent': UA };
  if (token) headers['X-Admin-Token'] = token;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const state = async () => (await api('GET', '/api/state')).json;
const auto = body => api('POST', '/api/admin/auto', body);

function player(name) {
  const c = { id: uuid(), name };
  c.connect = () => new Promise(res => {
    c.socket = io(BASE, { transports: ['websocket'], extraHeaders: { 'User-Agent': UA }, reconnection: false });
    c.socket.on('connect', () => { c.socket.emit('join', { playerId: c.id, name }); setTimeout(res, 300); });
  });
  c.vote = async () => {
    const s = await state();
    return new Promise(res => c.socket.timeout(4000).emit('vote', { playerId: c.id, authorId: s.currentPhoto.author_id, photoId: s.currentPhoto.id }, (e, r) => res(!e && r && r.ok)));
  };
  c.drop = () => c.socket.disconnect();
  return c;
}

// An observer (like the TV): records every state transition with a timestamp
const log = [];
let revealedEvents = [];
function observer() {
  const s = io(BASE, { transports: ['websocket'], extraHeaders: { 'User-Agent': UA } });
  let last = '';
  s.on('state_update', d => {
    const k = `${d.state}:${d.currentPhotoIndex}`;
    if (k !== last) { last = k; log.push({ t: Date.now(), state: d.state, idx: d.currentPhotoIndex, pending: d.autoPending }); }
    observer.lastPayload = d;
  });
  s.on('revealed', () => revealedEvents.push({ t: Date.now() }));
  return s;
}
// Wait until the observed state matches, return elapsed ms (or -1 on timeout)
async function waitFor(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const e = log[log.length - 1];
    if (e && pred(e)) return Date.now() - t0;
    await sleep(25);
  }
  return -1;
}
const cur = () => log[log.length - 1];

(async () => {
  if (!PASS) { console.error('Falta ADMIN_PASSWORD'); process.exit(2); }
  token = (await api('POST', '/api/admin/login', { password: PASS })).json.token;
  const s0 = await state();
  if (s0.photos.length || s0.players.length || s0.session.state !== 'lobby') { console.error('ABORTADO: servidor no vacío'); process.exit(3); }
  check(s0.autoMode === 'manual' && s0.autoDelay === 3 && s0.autoTimeout === 60, `por defecto: manual, delay 3 s, timeout 60 s (${s0.autoMode}, ${s0.autoDelay}, ${s0.autoTimeout})`);

  console.log('\n[validación] /api/admin/auto');
  check((await fetch(BASE + '/api/admin/auto', { method: 'POST', headers: { 'User-Agent': UA, 'Content-Type': 'application/json' }, body: '{"mode":"auto"}' })).status === 401, 'sin token: 401');
  check((await auto({ mode: 'turbo' })).status === 400, 'modo inválido: 400');
  check((await auto({ delay: 0 })).status === 400 && (await auto({ delay: 11 })).status === 400 && (await auto({ delay: 2.5 })).status === 400, 'delay fuera de 1-10 o no entero: 400');
  check((await auto({ timeout: 5 })).status === 400 && (await auto({ timeout: 601 })).status === 400, 'timeout fuera de 10-600: 400');
  check((await state()).autoMode === 'manual', 'peticiones rechazadas no cambian nada');

  const aIds = [];
  for (const n of ['Ana', 'Bruno', 'Carla']) aIds.push((await api('POST', '/api/authors', { name: n })).json.id);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  async function photos(n) {
    for (let i = 0; i < n; i++) {
      const f = new FormData();
      f.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), `a${i}.jpg`);
      f.append('author_id', String(aIds[i % 3]));
      await api('POST', '/api/upload', f, true);
    }
  }
  await photos(3);
  const obs = observer();
  const P = [player('Uno'), player('Dos'), player('Tres')];
  for (const p of P) await p.connect();
  await sleep(300);
  const histCount = async () => (await api('GET', '/api/admin/history')).json.games.length;

  // ---------------------------------------------------------------------------
  console.log('\n[1] Automático, flujo feliz: 3 jugadores, delay 2 s');
  check((await auto({ mode: 'auto', delay: 2, timeout: 60 })).status === 200, 'modo automático activado (delay 2, timeout 60)');
  await api('POST', '/api/game/start');
  for (let k = 0; k < 3; k++) {
    await waitFor(e => e.state === 'playing' && e.idx === k, 5000);
    await sleep(200);
    for (const p of P) check(await p.vote(), `${p.name} vota foto ${k + 1}`);
    const tVote = Date.now();
    const tr = await waitFor(e => e.state === 'revealed' && e.idx === k, 3000);
    check(tr >= 0 && tr < 500, `foto ${k + 1}: auto-revela al votar el último (${tr} ms tras el voto)`);
    const tRev = Date.now();
    if (k < 2) {
      const tn = await waitFor(e => e.state === 'playing' && e.idx === k + 1, 5000);
      const d = Date.now() - tRev;
      check(tn >= 0 && d >= 1800 && d <= 2600, `pasa sola a la foto ${k + 2} tras el delay (${d} ms; esperado ~2000)`);
    } else {
      const tf = await waitFor(e => e.state === 'finished', 5000);
      const d = Date.now() - tRev;
      check(tf >= 0 && d >= 1800 && d <= 2600, `última foto: va al ranking final tras el delay (${d} ms), no a una foto inexistente`);
    }
    void tVote;
  }
  await sleep(2500);
  check(cur().state === 'finished', 'sigue en finished (nada sigue avanzando)');
  check(revealedEvents.length === 3, `cada foto se reveló exactamente una vez (${revealedEvents.length} eventos 'revealed' para 3 fotos)`);
  check(await histCount() === 1, 'la partida se archivó una sola vez en el historial');

  // ---------------------------------------------------------------------------
  console.log('\n[2a] Falta un voto -> no revela solo; el admin revela a mano');
  revealedEvents = [];
  await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  await P[0].vote(); await P[1].vote();
  await sleep(1500);
  check(cur().state === 'playing', 'con 2/3 votos NO revela (1,5 s después)');
  check(observer.lastPayload.autoPending && observer.lastPayload.autoPending.action === 'reveal', 'el estado expone la red de seguridad pendiente (autoPending: reveal)');
  check((await api('POST', '/api/game/reveal')).status === 200, 'el admin revela a mano');
  const tManual = Date.now();
  await waitFor(e => e.state === 'playing' && e.idx === 1, 4000);
  const dManual = Date.now() - tManual;
  check(cur().idx === 1 && dManual >= 1800 && dManual <= 2600, `el automático respeta la revelación manual y pasa a la foto 2 tras el delay (${dManual} ms)`);
  check(revealedEvents.length === 1, `una sola revelación de la foto 1 (${revealedEvents.length})`);

  console.log('\n[2b] Falta un voto -> salta el timeout de seguridad (10 s)');
  check((await auto({ timeout: 10 })).status === 200, 'timeout = 10 s (se aplica a la próxima foto)');
  await P[0].vote(); await P[1].vote();       // photo 2 still uses the old 60 s timer
  check((await api('POST', '/api/game/reveal')).status === 200, 'revelamos la foto 2 a mano para empezar la 3 con timeout 10 s');
  await waitFor(e => e.state === 'playing' && e.idx === 2, 4000);
  const tStart3 = Date.now();
  await P[0].vote(); await P[1].vote();
  revealedEvents = [];
  const tt = await waitFor(e => e.state === 'revealed' && e.idx === 2, 13000);
  const dTimeout = Date.now() - tStart3;
  check(tt >= 0 && dTimeout >= 9500 && dTimeout <= 10800, `revela por timeout aunque falte un voto (${dTimeout} ms desde que empezó la foto)`);
  check(revealedEvents.length === 1, 'una sola revelación');
  const tf2 = await waitFor(e => e.state === 'finished', 4000);
  check(tf2 >= 0, 'y al ser la última va a ranking final');

  // ---------------------------------------------------------------------------
  console.log('\n[3] Un jugador se desconecta y con eso ya votaron todos los conectados');
  await auto({ timeout: 60 });
  await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  await P[0].vote(); await P[1].vote();
  await sleep(800);
  check(cur().state === 'playing', 'con 2/3 votos sigue esperando');
  const tDrop = Date.now();
  P[2].drop();
  const td = await waitFor(e => e.state === 'revealed' && e.idx === 0, 5000);
  check(td >= 0, `al irse "Tres" se recalcula y auto-revela (${Date.now() - tDrop} ms; incluye 1,5 s de margen por si solo estaba recargando)`);
  await P[2].connect();

  console.log('\n[3b] Recarga rápida (desconexión < 1,5 s) NO cuenta como irse');
  await waitFor(e => e.state === 'playing' && e.idx === 1, 4000);
  await P[0].vote(); await P[1].vote();
  P[2].drop(); await sleep(300); await P[2].connect();
  await sleep(2200);
  check(cur().state === 'playing', 'tras reconectar en 0,3 s no revela: sigue faltando su voto');
  await P[2].vote();
  check(await waitFor(e => e.state === 'revealed' && e.idx === 1, 2000) >= 0, 'cuando vota, revela');

  // ---------------------------------------------------------------------------
  console.log('\n[4] El admin se adelanta: pasa a mano durante el delay -> sin doble avance');
  await auto({ delay: 3 });
  await waitFor(e => e.state === 'playing' && e.idx === 2, 5000);     // delay 2 still pending from photo 2
  await api('POST', '/api/game/reset'); await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  for (const p of P) await p.vote();
  await waitFor(e => e.state === 'revealed' && e.idx === 0, 2000);
  await sleep(1000);
  check((await api('POST', '/api/game/next')).status === 200, 'el admin pulsa "siguiente" 1 s después de revelar');
  await sleep(3000);
  check(cur().state === 'playing' && cur().idx === 1, `el timer automático se canceló: sigue en la foto 2 jugando (estado ${cur().state}:${cur().idx + 1})`);
  console.log('    admin revela a mano justo cuando vota el último (carrera)');
  revealedEvents = [];
  await P[0].vote(); await P[1].vote();
  const [, rv] = await Promise.all([P[2].vote(), api('POST', '/api/game/reveal')]);
  await sleep(500);
  check(revealedEvents.length === 1, `una sola revelación (eventos: ${revealedEvents.length}; respuesta admin ${rv.status})`);

  // ---------------------------------------------------------------------------
  console.log('\n[5] Cambio de modo en caliente');
  check(observer.lastPayload.autoPending && observer.lastPayload.autoPending.action === 'next', 'hay un "siguiente" automático pendiente');
  await auto({ mode: 'manual' });
  await sleep(4000);
  check(cur().state === 'revealed' && cur().idx === 1, 'auto -> manual: el avance pendiente se cancela (sigue revelada la foto 2)');
  check(observer.lastPayload.autoMode === 'manual' && !observer.lastPayload.autoPending, 'los clientes ven modo manual y nada pendiente');
  const tResume = Date.now();
  await auto({ mode: 'auto' });
  await waitFor(e => e.state === 'playing' && e.idx === 2, 5000);
  const dResume = Date.now() - tResume;
  check(cur().idx === 2 && dResume >= 2800 && dResume <= 3600, `manual -> auto: retoma y pasa a la foto 3 tras el delay (${dResume} ms)`);
  await auto({ mode: 'manual' });
  for (const p of P) await p.vote();
  await sleep(800);
  check(cur().state === 'playing', 'en manual, con todos votados, NO revela');
  await auto({ mode: 'auto' });
  check(await waitFor(e => e.state === 'revealed' && e.idx === 2, 1000) >= 0, 'al pasar a auto con todos votados, revela al momento');

  // ---------------------------------------------------------------------------
  console.log('\n[6] Timers huérfanos');
  check(observer.lastPayload.autoPending && observer.lastPayload.autoPending.action === 'next', 'pendiente: ranking final automático');
  await api('POST', '/api/game/reset');
  await sleep(3800);
  check(cur().state === 'lobby', 'reset durante el delay: el timer no termina una partida que ya no existe (sigue en lobby)');
  const h0 = await histCount();
  await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  for (const p of P) await p.vote();
  await waitFor(e => e.state === 'revealed', 2000);
  await api('POST', '/api/game/finish');
  await sleep(3800);
  check(cur().state === 'finished' && await histCount() === h0 + 1, 'terminar durante el delay: sigue en finished y archivada UNA vez');
  console.log('    la red de seguridad de una partida reseteada no salta en la siguiente');
  await auto({ timeout: 10 });
  await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  await sleep(6000);
  await api('POST', '/api/game/reset');
  const tNew = Date.now();
  await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  const early = await waitFor(e => e.state === 'revealed', 7000);  // old timer would fire at ~4 s
  check(early === -1, 'el timeout de la partida anterior NO revela la nueva');
  const tr2 = await waitFor(e => e.state === 'revealed', 5000);
  const dNew = Date.now() - tNew;
  check(tr2 >= 0 && dNew >= 9500 && dNew <= 10900, `la nueva revela a sus propios 10 s (${dNew} ms)`);
  await api('POST', '/api/game/reset');

  console.log('\n[7] Manual (por defecto) no cambia: con todos votados no avanza solo');
  await auto({ mode: 'manual', delay: 3, timeout: 60 });
  await api('POST', '/api/game/start');
  await waitFor(e => e.state === 'playing' && e.idx === 0, 3000);
  for (const p of P) await p.vote();
  await sleep(2500);
  check(cur().state === 'playing' && !observer.lastPayload.autoPending, 'manual: no revela ni programa nada');
  await api('POST', '/api/game/reveal');
  await sleep(3500);
  check(cur().state === 'revealed' && cur().idx === 0, 'manual: tras revelar no pasa sola');

  for (const p of P) p.drop();
  obs.disconnect();
  await api('POST', '/api/game/reset');
  console.log(failures.length ? `\n=== ${failures.length} FALLO(S) ===` : '\n=== OK ===');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
