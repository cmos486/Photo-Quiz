#!/usr/bin/env node
/**
 * Ensayo con NAVEGADOR REAL (Google Chrome headless vía Playwright).
 * Cada jugador es una pestaña de Chrome (perfil móvil) que carga index.html, se une por la UI
 * y vota pulsando los botones reales. Una TV (Chrome escritorio) verifica barras, contador y
 * nombre del autor por DOM. El admin conduce la partida por API (como rehearsal.js).
 *
 * Uso:
 *   ADMIN_PASSWORD=xxx node rehearsal-browser.js <BASE_URL> [opciones]
 * Opciones:
 *   --players N     pestañas de jugador (default 4)
 *   --photos N      fotos (default 3)
 *   --early N       jugadores que cargan la página ANTES de que existan autores (default 2)
 *   --offline N     jugadores a los que se corta la red durante la revelación (default 2)
 *   --cleanup       purga los datos de juego al terminar (conserva historial)
 *   --headed        ver los navegadores (depuración)
 * Requiere: npm install (devDependency playwright) y Google Chrome instalado.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { chromium, devices } = require('playwright');

const args = process.argv.slice(2);
const BASE = (args.find(a => /^https?:/.test(a)) || 'http://localhost:3001').replace(/\/$/, '');
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const N = parseInt(opt('players', 4), 10);
const N_PHOTOS = parseInt(opt('photos', 3), 10);
const N_EARLY = Math.min(parseInt(opt('early', 2), 10), N);
const N_OFFLINE = Math.min(parseInt(opt('offline', 2), 10), Math.max(0, N - 2));
const PASS = process.env.ADMIN_PASSWORD;
const UA_API = devices['Pixel 7'].userAgent;

const failures = [];
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures.push(m); return c; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = () => Date.now();

// --- machine load sampling (to tell client-side saturation from server latency)
const load = { maxLoad1: 0, minFreeGB: Infinity, maxChromeGB: 0, samples: 0 };
function sampleLoad() {
  load.samples++;
  load.maxLoad1 = Math.max(load.maxLoad1, os.loadavg()[0]);
  // macOS "free" memory under-reports; use vm_stat pages free+inactive+speculative
  try {
    const vm = execSync('vm_stat', { encoding: 'utf8' });
    const pg = parseInt((vm.match(/page size of (\d+)/) || [0, 16384])[1], 10);
    const get = k => parseInt((vm.match(new RegExp(`${k}:\\s+(\\d+)`)) || [0, 0])[1], 10);
    const avail = (get('Pages free') + get('Pages inactive') + get('Pages speculative')) * pg / 2 ** 30;
    load.minFreeGB = Math.min(load.minFreeGB, avail);
    const rssKB = execSync("ps -A -o rss=,comm= | grep -i 'google chrome' | awk '{s+=$1} END{print s+0}'", { encoding: 'utf8', shell: '/bin/bash' });
    load.maxChromeGB = Math.max(load.maxChromeGB, parseInt(rssKB, 10) / 2 ** 20);
  } catch {}
}
const loadTimer = setInterval(sampleLoad, 2000);

async function api(method, url, body, isForm) {
  const headers = { 'User-Agent': UA_API };
  if (api.token) headers['X-Admin-Token'] = api.token;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const r = await fetch(BASE + url, { method, headers, body: isForm ? body : body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  if (r.status === 403 || r.status === 429 || (!json && r.status >= 400)) console.log(`  ! ${method} ${url} -> ${r.status} ${text.slice(0, 100)}`);
  return { status: r.status, json };
}

// Wait until fn() is truthy on every item, returns elapsed ms (or -1 on timeout)
async function waitAll(items, fn, timeout = 20000) {
  const s = t();
  const res = await Promise.all(items.map(async it => {
    try { await fn(it); return t() - s; } catch { return -1; }
  }));
  return res;
}
const pct = (arr, p) => { const a = arr.filter(x => x >= 0).sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : -1; };

async function main() {
  console.log(`=== Ensayo NAVEGADOR (Chrome real) contra ${BASE}: ${N} jugadores (${N_EARLY} tempranos, ${N_OFFLINE} offline en reveal), ${N_PHOTOS} fotos ===`);
  if (!PASS) { console.error('Falta ADMIN_PASSWORD'); process.exit(2); }
  if (N < 3) { console.error('Mínimo 3 jugadores'); process.exit(2); }
  const login = await api('POST', '/api/admin/login', { password: PASS });
  if (!login.json || !login.json.token) { console.error('Login fallido', login.status); process.exit(2); }
  api.token = login.json.token;
  const st0 = (await api('GET', '/api/state')).json;
  if (st0.session.state !== 'lobby' || st0.photos.length || st0.authors.length) {
    console.error(`ABORTADO: el servidor tiene datos (estado=${st0.session.state}, ${st0.photos.length} fotos, ${st0.authors.length} autores)`);
    process.exit(3);
  }

  const browser = await chromium.launch({ channel: 'chrome', headless: !args.includes('--headed') });
  console.log(`  navegador: Google Chrome ${browser.version()} (Playwright ${require('playwright/package.json').version})`);
  const consoleErrors = [];

  // --- TV (desktop)
  const tvCtx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const tv = await tvCtx.newPage();
  tv.on('pageerror', e => consoleErrors.push(`TV: ${e.message}`));
  await tv.goto(`${BASE}/?view=tv`, { waitUntil: 'domcontentloaded' });

  // --- Player helper
  const players = [];
  async function openPlayer(i) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    const page = await ctx.newPage();
    const name = `Chrome ${String(i + 1).padStart(2, '0')} ${['📱', 'Ñandú', 'José', 'Zoë'][i % 4]}`;
    const p = { i, ctx, page, name, early: i < N_EARLY, choice: {}, mixedContent: [] };
    page.on('pageerror', e => consoleErrors.push(`P${i + 1}: ${e.message}`));
    page.on('console', m => { if (/mixed content/i.test(m.text())) p.mixedContent.push(m.text()); });
    await page.goto(`${BASE}/?view=player`, { waitUntil: 'domcontentloaded' });
    await page.getByPlaceholder('Tu nombre').fill(name);
    await page.getByRole('button', { name: 'Entrar' }).click();
    await page.getByText('Jugando como').waitFor({ timeout: 15000 });
    players[i] = p;
    return p;
  }
  // Vote buttons = visible buttons whose text is an author name
  const voteButtons = (p, names) => p.page.locator('button:visible').filter({ hasText: new RegExp(`^\\s*(${names.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*$`) });

  // --- [1] Early players BEFORE authors exist (the blocker scenario)
  console.log(`\n[1] ${N_EARLY} jugadores cargan la página ANTES de que existan autores`);
  for (let i = 0; i < N_EARLY; i++) await openPlayer(i);
  check(true, `${N_EARLY} jugadores tempranos unidos por la UI`);

  // --- [2] Admin creates authors + photos
  console.log('\n[2] Admin crea autores y fotos (API)');
  const nAuthors = Math.max(3, Math.min(N_PHOTOS, 6));
  const authorNames = Array.from({ length: nAuthors }, (_, i) => `Autor ${['Ana', 'Bruno', 'Carla', 'David', 'Elena', 'Fran'][i]} ${i + 1}`);
  const authorIds = [];
  for (const n of authorNames) authorIds.push((await api('POST', '/api/authors', { name: n })).json.id);
  const local = fs.readdirSync(path.join(__dirname, 'photos')).filter(f => /\.jpe?g$/i.test(f));
  for (let k = 0; k < N_PHOTOS; k++) {
    const f = new FormData();
    f.append('photo', new Blob([fs.readFileSync(path.join(__dirname, 'photos', local[k % local.length]))], { type: 'image/jpeg' }), `browser${k}.jpg`);
    f.append('author_id', String(authorIds[k % authorIds.length]));
    const r = await api('POST', '/api/upload', f, true);
    if (r.status !== 200) check(false, `upload ${k} -> ${r.status}`);
  }

  // --- [3] Rest of the players join (staggered like people scanning a QR)
  console.log(`\n[3] ${N - N_EARLY} jugadores más se unen por la UI`);
  const tJoin = t();
  const joinTimes = [];
  await Promise.all(Array.from({ length: N - N_EARLY }, (_, k) => sleep(k * 150).then(async () => {
    const s = t(); await openPlayer(N_EARLY + k); joinTimes.push(t() - s);
  })));
  check(players.filter(Boolean).length === N, `${N} jugadores unidos en ${t() - tJoin}ms (p50 ${pct(joinTimes, 0.5)}ms, p95 ${pct(joinTimes, 0.95)}ms por pestaña)`);
  await tv.getByText(`${N} jugadores conectados`).waitFor({ timeout: 15000 }).then(() => check(true, `TV lobby: "${N} jugadores conectados"`), () => check(false, `TV lobby no muestra ${N} jugadores conectados`));
  sampleLoad();

  // --- [4] Game
  console.log('\n[4] Partida');
  check((await api('POST', '/api/game/start')).status === 200, 'start OK');
  const nonVoter = players[N - 1];                                  // never votes -> "Autor: X"
  const offline = players.slice(N_EARLY, N_EARLY + N_OFFLINE);      // network cut during reveal
  const voters = players.filter(p => p !== nonVoter);
  const timings = { buttons: [], vote: [] };

  for (let k = 0; k < N_PHOTOS; k++) {
    const st = (await api('GET', '/api/state')).json;
    const truth = st.currentPhoto.author_id;
    const truthName = st.authors.find(a => a.id === truth).name;
    console.log(`  -- Foto ${k + 1}/${N_PHOTOS}`);

    // Vote buttons appear on every player (incl. early ones, no reload)
    const bt = await waitAll(players, p => voteButtons(p, authorNames).nth(nAuthors - 1).waitFor({ timeout: 20000 }));
    timings.buttons.push(...bt);
    const early = players.filter(p => p.early);
    check(early.every(p => bt[p.i] >= 0), `jugadores tempranos ven ${nAuthors} botones SIN recargar`);
    check(bt.every(x => x >= 0), `${bt.filter(x => x >= 0).length}/${N} jugadores ven los botones (p95 ${pct(bt, 0.95)}ms)`);
    const counts = await Promise.all(players.map(p => voteButtons(p, authorNames).count()));
    check(counts.every(c => c === nAuthors), `cada jugador tiene exactamente ${nAuthors} botones (${[...new Set(counts)].join(',')})`);
    check(await tv.locator('.bar-transition').count() === nAuthors, `TV pinta ${nAuthors} barras`);

    // Every voter clicks a real button
    const vt = await waitAll(voters, async p => {
      const idx = Math.floor(Math.random() * nAuthors);
      p.choice[k] = authorIds[idx];
      await voteButtons(p, authorNames).filter({ hasText: authorNames[idx] }).first().click();
      await p.page.getByText('Voto registrado').waitFor({ timeout: 20000 });
    });
    timings.vote.push(...vt);
    check(vt.every(x => x >= 0), `${vt.filter(x => x >= 0).length}/${voters.length} votos por clic confirmados ("Voto registrado"; p50 ${pct(vt, 0.5)}ms, p95 ${pct(vt, 0.95)}ms)`);
    const counter = `${voters.length}/${N} votos recibidos`;
    await tv.getByText(counter).waitFor({ timeout: 10000 }).then(() => check(true, `TV: "${counter}"`), async () => check(false, `TV contador: "${(await tv.getByText('votos recibidos').first().textContent()).trim()}" (esperado ${counter})`));
    sampleLoad();

    // Cut network on some players, reveal, check "Reconectando", restore, check result
    await Promise.all(offline.map(p => p.ctx.setOffline(true)));
    check((await api('POST', '/api/game/reveal')).status === 200, 'reveal OK');
    await tv.getByText(`📸 ${truthName}`).waitFor({ timeout: 10000 }).then(() => check(true, `TV muestra "📸 ${truthName}"`), () => check(false, `TV no muestra "📸 ${truthName}"`));
    await nonVoter.page.getByText(`Autor: ${truthName}`).waitFor({ timeout: 10000 }).then(() => check(true, `jugador que NO votó ve "Autor: ${truthName}"`), () => check(false, 'jugador que no votó no ve el autor'));
    const online = voters.filter(p => !offline.includes(p));
    const rt = await waitAll(online, async p => {
      const ok = p.choice[k] === truth;
      await p.page.getByText(ok ? '¡Acertaste! +3 puntos' : 'Fallaste', { exact: true }).waitFor({ timeout: 10000 });
      await p.page.getByText(`Era: ${truthName}`).waitFor({ timeout: 5000 });
    });
    check(rt.every(x => x >= 0), `${rt.filter(x => x >= 0).length}/${online.length} votantes ven su resultado correcto + "Era: ${truthName}"`);
    if (offline.length) {
      // Chrome offline emulation does not always kill an open WebSocket immediately; engine.io
      // detects it on the next ping (pingInterval 25s + pingTimeout 20s). Wait up to 50s.
      const rc = await waitAll(offline, p => p.page.getByText('Reconectando...').waitFor({ timeout: 50000 }), 50000);
      check(rc.every(x => x >= 0), `${rc.filter(x => x >= 0).length}/${offline.length} sin red muestran "Reconectando..." (tras ${pct(rc, 0.5)}ms)`);
      await Promise.all(offline.map(p => p.ctx.setOffline(false)));
      const back = await waitAll(offline, async p => {
        const ok = p.choice[k] === truth;
        await p.page.getByText('Reconectando...').waitFor({ state: 'hidden', timeout: 20000 });
        await p.page.getByText(ok ? '¡Acertaste! +3 puntos' : 'Fallaste', { exact: true }).waitFor({ timeout: 15000 });
      });
      check(back.every(x => x >= 0), `${back.filter(x => x >= 0).length}/${offline.length} al recuperar red: desaparece "Reconectando" y ven su resultado (p95 ${pct(back, 0.95)}ms)`);
    }
    // Ranking on TV
    const apiRank = (await api('GET', '/api/state')).json.players.sort((a, b) => b.score - a.score);
    const tvTop = (await tv.locator('text=pts').first().textContent()).trim();
    check(tvTop === `${apiRank[0].score} pts`, `ranking TV: líder con "${tvTop}" (API ${apiRank[0].score} pts)`);
    sampleLoad();

    if (k < N_PHOTOS - 1) check((await api('POST', '/api/game/next')).status === 200, 'next OK');
  }

  // --- [5] Final
  console.log('\n[5] Final');
  check((await api('POST', '/api/game/finish')).status === 200, 'finish OK');
  await tv.getByText('Resultados Finales').waitFor({ timeout: 10000 }).then(() => check(true, 'TV muestra "Resultados Finales"'), () => check(false, 'TV no muestra resultados finales'));
  const finals = await waitAll(players, p => p.page.getByText('Resultados Finales').waitFor({ timeout: 10000 }));
  check(finals.every(x => x >= 0), `${finals.filter(x => x >= 0).length}/${N} jugadores ven "Resultados Finales"`);
  const fin = (await api('GET', '/api/state')).json.players;
  check(fin.length === N, `${fin.length} jugadores en el ranking final`);
  check(consoleErrors.length === 0, `sin errores JS en las páginas${consoleErrors.length ? ': ' + consoleErrors.slice(0, 3).join(' | ') : ''}`);
  const mixed = players.flatMap(p => p.mixedContent);
  check(mixed.length === 0, 'sin avisos de mixed content');

  await browser.close();
  if (args.includes('--cleanup')) { await api('POST', '/api/admin/purge', { includeHistory: false }); console.log('  (datos de ensayo purgados; historial conservado)'); }
  clearInterval(loadTimer);

  console.log('\n[Carga de la máquina cliente]');
  console.log(`  load1 máx ${load.maxLoad1.toFixed(1)} (${os.cpus().length} CPUs) · RAM disponible mín ${load.minFreeGB.toFixed(1)} GB · RSS Chrome máx ${load.maxChromeGB.toFixed(1)} GB`);
  console.log(`  botones visibles p50/p95: ${pct(timings.buttons, 0.5)}/${pct(timings.buttons, 0.95)}ms · voto por clic p50/p95: ${pct(timings.vote, 0.5)}/${pct(timings.vote, 0.95)}ms`);
  const saturated = load.maxLoad1 > os.cpus().length * 1.5 || load.minFreeGB < 1;
  console.log(`  ${saturated ? '⚠ MÁQUINA SATURADA: las latencias reflejan el cliente, no el servidor' : 'máquina sin saturar: latencias representativas'}`);

  console.log(`\n=== ${failures.length ? failures.length + ' FALLOS' : 'ENSAYO NAVEGADOR OK'} ===`);
  failures.forEach(f => console.log('  - ' + f));
  process.exit(failures.length ? 1 : 0);
}

main().catch(e => { console.error('Error fatal:', e); process.exit(1); });
