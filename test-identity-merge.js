#!/usr/bin/env node
/**
 * Prueba de identidad persistente del jugador (Mejora 1) y fusión de jugadores (Mejora 2),
 * en Chrome real (Playwright) contra un servidor LOCAL con BD aislada.
 *
 *  M1  mismo navegador: el jugador cierra/recarga la página y vuelve -> mismo jugador, mismos puntos
 *  M1  localStorage bloqueado (incógnito estricto): el juego funciona igual
 *  M1  playerId desconocido / de una partida borrada -> jugador nuevo, sin error
 *  M2  caso cámara->navegador: dos "Sonia" (34 y 12 pts, fotos distintas) -> una Sonia con 46,
 *      fusionada desde el panel admin real; TV y jugadores actualizados sin recargar
 *  M2  mismo voto en la misma foto -> se queda uno, puntos correctos
 *  M2  la vista "cámara" que vuelve con el id fusionado reconecta como el destino (no reaparece)
 *
 * Uso (SOLO local; crea y BORRA datos):
 *   ADMIN_PASSWORD=xxx DB=/ruta/a/data/quiz.db node test-identity-merge.js http://localhost:3001 [--headed]
 */
const { chromium, devices } = require('playwright');
const Database = require('better-sqlite3');

const BASE = (process.argv[2] || 'http://localhost:3001').replace(/\/$/, '');
const PASS = process.env.ADMIN_PASSWORD;
const DB_FILE = process.env.DB; // only used to set the 34/12 scores of the user's example
const failures = [];
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures.push(m); };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(method, url, body, isForm) {
  const headers = {};
  if (api.token) headers['X-Admin-Token'] = api.token;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}
const state = async () => (await api('GET', '/api/state')).json;
const byName = async (name) => (await state()).players.filter(p => p.name === name);
let _db; const db = () => (_db ||= new Database(DB_FILE));
const alpine = (page) => page.evaluate(() => {
  const d = document.body._x_dataStack[0];
  return { playerId: d.playerId, playerName: d.playerName, ranking: d.ranking.map(p => ({ id: p.id, name: p.name, score: p.score })), hasVoted: d.hasVotedCurrent };
});
const stored = (page) => page.evaluate(() => { try { return localStorage.getItem('pq_playerId'); } catch { return 'BLOCKED'; } });

(async () => {
  if (!PASS || !DB_FILE) { console.error('Faltan ADMIN_PASSWORD y DB'); process.exit(2); }
  api.token = (await api('POST', '/api/admin/login', { password: PASS })).json.token;
  const st0 = await state();
  if (st0.authors.length || st0.photos.length || st0.players.length || st0.session.state !== 'lobby') {
    console.error('ABORTADO: el servidor debe estar vacío (prueba solo para local)'); process.exit(3);
  }

  // Setup: 3 authors, 3 photos
  const authorIds = [];
  for (const n of ['Ana', 'Bruno', 'Carla']) authorIds.push((await api('POST', '/api/authors', { name: n })).json.id);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9]);
  for (let i = 0; i < 3; i++) {
    const f = new FormData();
    f.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), `t${i}.jpg`);
    f.append('author_id', String(authorIds[i]));
    await api('POST', '/api/upload', f, true);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
  const pageErrors = [];
  const contexts = [];
  async function newPlayerCtx(init) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    contexts.push(ctx);
    if (init) await ctx.addInitScript(init);
    return ctx;
  }
  async function openPlayer(ctx, name) {
    const page = await ctx.newPage();
    page.on('pageerror', e => pageErrors.push(`${name}: ${e.message}`));
    page.on('dialog', d => d.accept());
    await page.goto(`${BASE}/?view=player`, { waitUntil: 'domcontentloaded' });
    if (name) {
      await page.getByPlaceholder('Tu nombre').fill(name);
      await page.getByRole('button', { name: 'Entrar' }).click();
    }
    await page.waitForFunction(() => document.body._x_dataStack && document.body._x_dataStack[0].connected);
    await sleep(300);
    return page;
  }
  const correctAuthor = async () => { const s = await state(); return s.authors.find(a => a.id === s.currentPhoto.author_id).name; };
  async function vote(page, authorName) {
    await page.getByRole('button', { name: authorName }).first().click();
    await page.getByText('Voto registrado').waitFor({ timeout: 10000 });
  }

  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvCtx.newPage();
  tv.on('pageerror', e => pageErrors.push(`tv: ${e.message}`));
  await tv.goto(`${BASE}/?view=tv`, { waitUntil: 'domcontentloaded' });

  // Players
  const pedroCtx = await newPlayerCtx();
  let pedro = await openPlayer(pedroCtx, 'Pedro');
  const soniaCamCtx = await newPlayerCtx();           // the ephemeral camera-app view
  const soniaCam = await openPlayer(soniaCamCtx, 'Sonia');
  const luisACtx = await newPlayerCtx();
  const luisA = await openPlayer(luisACtx, 'Luis');
  const luisBCtx = await newPlayerCtx();
  let luisB = await openPlayer(luisBCtx, 'Luis');
  await api('POST', '/api/game/start');
  await sleep(500);

  // ---------- Photo 1 ----------
  console.log('\n[Foto 1] votan Pedro, Sonia(cámara), Luis A y Luis B (los dos Luis la MISMA foto)');
  let ok = await correctAuthor();
  for (const p of [pedro, soniaCam, luisA, luisB]) await vote(p, ok);
  await api('POST', '/api/game/reveal');
  await sleep(500);
  const pedroId = (await alpine(pedro)).playerId;
  const soniaCamId = (await alpine(soniaCam)).playerId;
  const luisAId = (await alpine(luisA)).playerId;
  const luisBId = (await alpine(luisB)).playerId;

  console.log('\n[M1] Pedro pierde la vista (cierra la pestaña) y vuelve por el MISMO navegador');
  await pedro.close();
  await sleep(300);
  pedro = await openPlayer(pedroCtx, null); // no name typed: identity comes from localStorage
  let a = await alpine(pedro);
  check(a.playerId === pedroId && a.playerName === 'Pedro', `recupera su identidad sin escribir el nombre (${a.playerName}, mismo playerId)`);
  check((await byName('Pedro')).length === 1, 'NO se crea un Pedro duplicado');
  check((await byName('Pedro'))[0].score === 3, 'mantiene sus puntos (3)');
  check(await pedro.getByText('Pedro (tú)').first().isVisible(), 'ranking del móvil le marca "(tú)"');

  // The camera view dies: Sonia comes back from the normal browser = another browser -> new player
  await soniaCamCtx.close();
  await api('POST', '/api/game/next');
  await sleep(400);

  // ---------- Photo 2 ----------
  console.log('\n[Foto 2] Sonia vuelve por OTRO navegador (límite conocido de la Mejora 1)');
  const soniaBrCtx = await newPlayerCtx();
  const soniaBr = await openPlayer(soniaBrCtx, 'Sonia');
  const soniaBrId = (await alpine(soniaBr)).playerId;
  check((await byName('Sonia')).length === 2 && soniaBrId !== soniaCamId, 'otro navegador = otro jugador: ahora hay DOS "Sonia" (el caso del evento)');
  ok = await correctAuthor();
  await vote(soniaBr, ok);
  await vote(luisB, ok);

  console.log('\n[M1] Pedro vota y se le recarga la página antes de revelar');
  await vote(pedro, ok);
  await pedro.reload({ waitUntil: 'domcontentloaded' });
  await pedro.waitForFunction(() => document.body._x_dataStack && document.body._x_dataStack[0].connected);
  await sleep(500);
  a = await alpine(pedro);
  check(a.playerId === pedroId && a.hasVoted, 'tras recargar: mismo jugador y sigue constando "Voto registrado"');
  check((await byName('Pedro')).length === 1, 'sin duplicado tras recargar');
  await api('POST', '/api/game/reveal');
  await sleep(500);
  check((await byName('Pedro'))[0].score === 6, 'Pedro suma correctamente tras recargar (6)');

  // ---------- M2: Sonia 34 + 12 via the real admin panel ----------
  console.log('\n[M2] Dos "Sonia" con 34 y 12 pts y votos en fotos distintas -> fusionar desde el panel admin');
  db().prepare('UPDATE players SET score = ? WHERE id = ?').run(34, soniaCamId);
  db().prepare('UPDATE players SET score = ? WHERE id = ?').run(12, soniaBrId);
  await api('POST', '/api/game/url', { url: '' }); // any admin action -> broadcast the new scores
  await sleep(400);
  const votesBefore = db().prepare('SELECT photo_id FROM votes WHERE player_id IN (?, ?)').all(soniaCamId, soniaBrId).map(v => v.photo_id).sort();

  const adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const adm = await adminCtx.newPage();
  adm.on('pageerror', e => pageErrors.push(`admin: ${e.message}`));
  let dialogText = '';
  adm.on('dialog', d => { dialogText = d.message(); d.accept(); });
  await adm.goto(`${BASE}/?view=admin`, { waitUntil: 'domcontentloaded' });
  await adm.getByPlaceholder('Contraseña').fill(PASS);
  await adm.getByPlaceholder('Contraseña').press('Enter');
  await adm.getByText('Fusionar jugadores duplicados').click();
  const row = (pts) => adm.locator('div:has(> label > input[name=mergeTarget])', { hasText: 'Sonia' }).filter({ hasText: `${pts} pts` });
  await row(12).locator('input[type=radio]').check();      // destino: la Sonia del navegador normal
  await row(34).locator('input[type=checkbox]').check();   // fusionar: la de la vista de cámara
  await adm.getByRole('button', { name: 'Fusionar', exact: true }).click();
  await adm.getByText('ahora tiene 46 pts').waitFor({ timeout: 5000 });
  check(/Sonia \(34 pts\).*Sonia \(12 pts\)/s.test(dialogText), 'pide confirmación indicando quién se fusiona en quién');
  const sonias = await byName('Sonia');
  check(sonias.length === 1 && sonias[0].id === soniaBrId && sonias[0].score === 46, `un solo "Sonia" con ${sonias.map(s => s.score).join(',')} pts (esperado 46)`);
  const votesAfter = db().prepare('SELECT photo_id FROM votes WHERE player_id = ?').all(soniaBrId).map(v => v.photo_id).sort();
  check(JSON.stringify(votesAfter) === JSON.stringify(votesBefore), `todos sus votos (${votesAfter.length}) pasan a la Sonia destino`);
  await sleep(300);
  const tvRank = (await alpine(tv)).ranking;
  check(tvRank.filter(p => p.name === 'Sonia').length === 1 && tvRank[0].name === 'Sonia' && tvRank[0].score === 46, 'TV (sin recargar): ranking con una sola Sonia, líder con 46');
  const tvText = await tv.locator('body').innerText();
  check((tvText.match(/Sonia/g) || []).length === 1 && tvText.includes('46'), 'TV pinta "Sonia" una sola vez y 46 pts');
  const pedroRank = (await alpine(pedro)).ranking;
  check(pedroRank.filter(p => p.name === 'Sonia').length === 1 && pedroRank.find(p => p.name === 'Sonia').score === 46, 'jugadores (sin recargar): ranking actualizado');
  check((await adm.locator('div:has(> label > input[name=mergeTarget])', { hasText: 'Sonia' }).count()) === 1, 'panel admin: la lista ya solo tiene una Sonia');

  // ---------- M2: same-photo vote ----------
  console.log('\n[M2] Luis A (3 pts) y Luis B (6 pts) votaron la MISMA foto 1; Luis B además la 2');
  const r = await api('POST', '/api/admin/players/merge', { targetId: luisAId, sourceIds: [luisBId] });
  const luis = await byName('Luis');
  const lv = db().prepare('SELECT photo_id, points FROM votes WHERE player_id = ?').all(luisAId);
  check(r.status === 200 && r.json.droppedVotes === 1 && r.json.movedVotes === 1, `voto repetido descartado (movidos ${r.json.movedVotes}, descartados ${r.json.droppedVotes})`);
  check(luis.length === 1 && luis[0].score === 6, `un solo Luis con ${luis.map(l => l.score)} pts (esperado 6 = foto1 una vez + foto2, no 9)`);
  check(lv.length === 2 && new Set(lv.map(v => v.photo_id)).size === 2, 'un único voto por foto (2 votos, 2 fotos)');
  check(lv.reduce((s, v) => s + v.points, 0) === luis[0].score, 'puntos = suma de sus votos (recuento coherente)');
  await sleep(300);
  a = await alpine(luisB);
  check(a.playerId === luisAId && (await stored(luisB)) === luisAId, 'el móvil de Luis B pasa a ser Luis A al momento (id y localStorage)');

  // Luis B (now Luis A) keeps playing from that phone, and after a reload
  await api('POST', '/api/game/next');
  await sleep(400);
  ok = await correctAuthor();
  await luisB.reload({ waitUntil: 'domcontentloaded' });
  await luisB.waitForFunction(() => document.body._x_dataStack && document.body._x_dataStack[0].connected);
  await sleep(400);
  await vote(luisB, ok);
  await api('POST', '/api/game/reveal');
  await sleep(400);
  check((await byName('Luis')).length === 1 && (await byName('Luis'))[0].score === 9, 'Luis vota desde el móvil fusionado (tras recargar) y suma al destino: 9, sin duplicado');

  console.log('\n[M2] La vista de cámara de Sonia "vuelve" con su id antiguo (fusionado)');
  const camBackCtx = await newPlayerCtx(`localStorage.setItem('pq_playerId', ${JSON.stringify(soniaCamId)}); localStorage.setItem('pq_playerName', 'Sonia');`);
  const camBack = await openPlayer(camBackCtx, null);
  a = await alpine(camBack);
  check(a.playerId === soniaBrId && (await byName('Sonia')).length === 1, 'reconecta como la Sonia fusionada: el duplicado NO reaparece');
  check((await byName('Sonia'))[0].score === 46, 'Sonia sigue con 46');

  // ---------- M1 edge cases ----------
  console.log('\n[M1] localStorage/sessionStorage bloqueados (modo privado estricto)');
  const blockInit = `
    for (const k of ['localStorage', 'sessionStorage'])
      Object.defineProperty(window, k, { get() { throw new DOMException('blocked', 'SecurityError'); } });`;
  const incCtx = await newPlayerCtx(blockInit);
  const errBefore = pageErrors.length;
  const inc = await openPlayer(incCtx, 'Incognito');
  check((await stored(inc)) === 'BLOCKED', 'el almacenamiento realmente lanza excepción en esta pestaña');
  await vote(inc, await correctAuthor()).then(() => check(false, 'no debería poder votar en revealed'), () => {});
  await api('POST', '/api/game/reset');      // back to lobby, same players
  await api('POST', '/api/game/start');
  await sleep(500);
  await vote(inc, await correctAuthor());
  check(pageErrors.length === errBefore, 'sin errores JS; entra y vota ("Voto registrado")');
  check((await byName('Incognito')).length === 1, 'aparece como jugador normal');
  const admBlockedCtx = await browser.newContext();
  await admBlockedCtx.addInitScript(blockInit);
  const admB = await admBlockedCtx.newPage();
  admB.on('pageerror', e => pageErrors.push(`adminBlocked: ${e.message}`));
  await admB.goto(`${BASE}/?view=admin`, { waitUntil: 'domcontentloaded' });
  await admB.getByPlaceholder('Contraseña').fill(PASS);
  await admB.getByPlaceholder('Contraseña').press('Enter');
  await admB.getByText('Control del Juego').waitFor({ timeout: 5000 }).then(() => check(true, 'el panel admin también funciona con el almacenamiento bloqueado'), () => check(false, 'admin con almacenamiento bloqueado'));

  console.log('\n[M1] playerId desconocido -> jugador nuevo');
  const ghostCtx = await newPlayerCtx(`localStorage.setItem('pq_playerId', 'id-que-no-existe-123'); localStorage.setItem('pq_playerName', 'Fantasma');`);
  const ghost = await openPlayer(ghostCtx, null);
  const fan = await byName('Fantasma');
  check(fan.length === 1 && fan[0].score === 0, 'se crea un jugador nuevo con 0 pts, sin error');
  await vote(ghost, await correctAuthor());
  check(true, 'y puede votar');

  console.log('\n[M1] playerId de una partida ya borrada ("Borrar todo") -> jugador nuevo');
  await api('POST', '/api/admin/purge', { includeHistory: false });
  await sleep(400);
  check((await state()).players.length === 0, 'purge: no queda ningún jugador ni alias');
  await pedro.reload({ waitUntil: 'domcontentloaded' });
  await pedro.waitForFunction(() => document.body._x_dataStack && document.body._x_dataStack[0].connected);
  await sleep(500);
  const p2 = await byName('Pedro');
  check(p2.length === 1 && p2[0].score === 0, 'Pedro vuelve como jugador nuevo con 0 pts, sin error');
  const aliasCount = db().prepare('SELECT COUNT(*) c FROM player_aliases').get().c;
  check(aliasCount === 0, 'tabla de alias vacía tras purge');

  console.log('\n[API] validación de la fusión');
  const noAuth = await fetch(BASE + '/api/admin/players/merge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  check(noAuth.status === 401, 'sin token de admin: 401');
  check((await api('POST', '/api/admin/players/merge', { targetId: p2[0].id, sourceIds: [p2[0].id] })).status === 400, 'destino dentro de los fusionados: 400');
  check((await api('POST', '/api/admin/players/merge', { targetId: p2[0].id, sourceIds: ['nope'] })).status === 400, 'jugador inexistente: 400');
  check((await api('POST', '/api/admin/players/merge', { targetId: p2[0].id, sourceIds: 'x' })).status === 400, 'payload mal formado: 400');
  check((await state()).players.length === 1, 'las fusiones rechazadas no tocan nada');

  check(pageErrors.length === 0, `sin errores JS en ninguna página${pageErrors.length ? ': ' + pageErrors.join(' | ') : ''}`);
  await browser.close();
  console.log(failures.length ? `\n=== ${failures.length} FALLO(S) ===` : '\n=== OK ===');
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
