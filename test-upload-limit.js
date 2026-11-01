#!/usr/bin/env node
/**
 * Prueba del límite de subida (MAX_UPLOAD_MB) en backend y frontend.
 *
 * Uso (SOLO contra un servidor local/aislado: crea un autor y sube/borra una foto):
 *   ADMIN_PASSWORD=xxx node test-upload-limit.js http://localhost:3001 [--photos-dir ./photos]
 *
 * --photos-dir: carpeta de fotos de ESE servidor, para verificar que un 413 no deja
 *               ficheros huérfanos en disco (opcional; solo posible en local).
 */
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const BASE = (args.find(a => /^https?:/.test(a)) || 'http://localhost:3001').replace(/\/$/, '');
const di = args.indexOf('--photos-dir');
const PHOTOS_DIR = di >= 0 ? args[di + 1] : null;
const PASS = process.env.ADMIN_PASSWORD;

const failures = [];
const check = (c, m) => { console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) failures.push(m); };
const listPhotos = () => (PHOTOS_DIR ? fs.readdirSync(PHOTOS_DIR).sort() : []);

// Minimal valid JPEG header + padding to the requested size
function jpegOfSize(bytes) {
  const buf = Buffer.alloc(bytes, 0);
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]).copy(buf, 0);
  buf[bytes - 2] = 0xff; buf[bytes - 1] = 0xd9;
  return buf;
}

async function upload(token, authorId, bytes, name) {
  const form = new FormData();
  form.append('photo', new Blob([jpegOfSize(bytes)], { type: 'image/jpeg' }), name);
  form.append('author_id', String(authorId));
  const res = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'X-Admin-Token': token }, body: form });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

async function backend() {
  console.log(`[Backend] ${BASE}`);
  if (!PASS) { console.error('Falta ADMIN_PASSWORD'); process.exit(2); }
  const login = await (await fetch(`${BASE}/api/admin/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASS }),
  })).json();
  const token = login.token;
  const state = await (await fetch(`${BASE}/api/state`)).json();
  const MAX = state.maxUploadMB;
  check(typeof MAX === 'number', `/api/state expone maxUploadMB = ${MAX}`);
  const MB = 1024 * 1024;

  const author = await (await fetch(`${BASE}/api/authors`, {
    method: 'POST', headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test límite subida' }),
  })).json();

  // Under the limit
  const small = await upload(token, author.id, Math.floor((MAX - 0.1) * MB), 'pequena.jpg');
  check(small.status === 200, `foto de ${(MAX - 0.1).toFixed(1)}MB -> HTTP ${small.status}`);

  // Over the limit, bypassing the client
  const before = listPhotos();
  const big = await upload(token, author.id, Math.floor((MAX + 1) * MB), 'grande.jpg');
  check(big.status === 413, `foto de ${MAX + 1}MB -> HTTP ${big.status} (esperado 413, no 500)`);
  check(big.json && big.json.code === 'FILE_TOO_LARGE' && big.json.maxUploadMB === MAX && /máximo/.test(big.json.error),
    `JSON legible: ${big.text.slice(0, 120)}`);
  if (PHOTOS_DIR) {
    await new Promise(r => setTimeout(r, 300));
    const after = listPhotos();
    check(after.length === before.length, `sin ficheros huérfanos en disco (${before.length} -> ${after.length})`);
  } else console.log('  (sin --photos-dir: no se verifica disco)');

  // Other multer errors are not confused with size
  const form = new FormData();
  form.append('photo', new Blob([Buffer.from('hola')], { type: 'text/plain' }), 'nota.txt');
  form.append('author_id', String(author.id));
  const bad = await fetch(`${BASE}/api/upload`, { method: 'POST', headers: { 'X-Admin-Token': token }, body: form });
  const badJson = await bad.json().catch(() => null);
  check(bad.status === 400 && badJson && badJson.code !== 'FILE_TOO_LARGE', `tipo no permitido -> HTTP ${bad.status} ${JSON.stringify(badJson)}`);

  // Cleanup: remove the test author (and its photo)
  await fetch(`${BASE}/api/authors/${author.id}`, { method: 'DELETE', headers: { 'X-Admin-Token': token } });
}

async function frontend() {
  console.log('\n[Frontend] uploadPhotos() de index.html con ficheros simulados');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  const start = html.indexOf('function app()');
  const code = html.slice(start, html.indexOf('</script>', start));
  const alerts = [];
  const app = new Function('sessionStorage', 'alert', 'window', `${code}; return app();`)(
    { getItem: () => '', setItem() {}, removeItem() {} }, (m) => alerts.push(m), { location: { search: '' } });
  const sent = [];
  app.adminFetch = async (url, opts) => { sent.push(opts.body.entries.photo.name); return { ok: true, status: 200 }; };
  app.fetchState = () => {};
  app.maxUploadMB = 5;
  // Recording FormData stub (simulated files are plain {name,size} objects, not Blobs)
  const RealFormData = global.FormData;
  global.FormData = class { constructor() { this.entries = {}; } append(k, v) { this.entries[k] = v; } };
  const MB = 1024 * 1024;
  const event = { target: { value: 'x', files: [
    { name: 'ok.jpg', size: 4.9 * MB },
    { name: 'foto.jpg', size: 8.2 * MB },
  ] } };
  await app.uploadPhotos(event, 1);
  check(sent.length === 1 && sent[0] === 'ok.jpg', `solo se envía la foto válida (enviadas: ${sent.join(', ')})`);
  check(alerts.length === 1 && alerts[0].includes('foto.jpg pesa 8.2MB, máximo 5MB'), `aviso claro: ${JSON.stringify(alerts[0])}`);
  check(app.uploadStatus === '1/2 fotos subidas — 1 con error', `estado: "${app.uploadStatus}"`);
  global.FormData = RealFormData;
}

(async () => {
  await frontend();
  if (args.includes('--frontend-only')) {} else { console.log(''); await backend(); }
  console.log(`\n=== ${failures.length ? failures.length + ' FALLOS' : 'OK'} ===`);
  process.exit(failures.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
