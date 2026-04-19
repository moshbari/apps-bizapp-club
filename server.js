/**
 * apps.bizapp.club — Coolify-native app deployer dashboard
 *
 * Differences from the original HestiaCP version:
 *   - No shell-outs to v-add-web-domain / v-add-letsencrypt-domain.
 *     Subdomains are attached to THIS Coolify application via the Coolify
 *     API; Traefik handles routing + Let's Encrypt automatically.
 *   - One container serves every child app. Express looks at the Host
 *     header and serves the right static bundle from /data/sites/<sub>.
 *   - All persistent state (users, apps, html-apps, deployed bundles) lives
 *     under DATA_DIR so it survives container rebuilds via a Coolify volume.
 */

const express = require('express');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

// -------- crash-safety --------
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// -------- config --------
const PORT = parseInt(process.env.PORT || '3000', 10);
// PARENT_DOMAIN = where the dashboard lives (e.g. apps.bizapp.club)
const PARENT_DOMAIN = process.env.PARENT_DOMAIN || 'apps.bizapp.club';
// APP_DOMAIN = suffix for child apps (e.g. bizapp.club → debtdua1.bizapp.club).
// Defaults to PARENT_DOMAIN for the nested layout (debtdua1.apps.bizapp.club).
const APP_DOMAIN = process.env.APP_DOMAIN || PARENT_DOMAIN;
// DASHBOARD_SUB: the label of PARENT_DOMAIN inside APP_DOMAIN (reserved name).
// e.g. PARENT='apps.bizapp.club', APP='bizapp.club' → 'apps'
const DASHBOARD_SUB = (PARENT_DOMAIN !== APP_DOMAIN && PARENT_DOMAIN.endsWith('.' + APP_DOMAIN))
  ? PARENT_DOMAIN.slice(0, -(1 + APP_DOMAIN.length))
  : null;
const RESERVED_SUBS = new Set([DASHBOARD_SUB, 'www', 'mail', 'api', 'admin', 'ftp', 'smtp', 'pop', 'imap', 'ns1', 'ns2'].filter(Boolean));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOLIFY_API_URL = (process.env.COOLIFY_API_URL || '').replace(/\/+$/, '');
const COOLIFY_API_TOKEN = process.env.COOLIFY_API_TOKEN || '';
const COOLIFY_APP_UUID = process.env.COOLIFY_APP_UUID || '';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

const SITES_DIR = path.join(DATA_DIR, 'sites');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const HTML_APPS_FILE = path.join(DATA_DIR, 'html-apps.json');

// -------- storage helpers --------
function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
}
function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
async function writeJson(file, data) {
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

ensureDirSync(DATA_DIR);
ensureDirSync(SITES_DIR);

// -------- password hashing (scrypt) --------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  // constant-time compare
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// -------- naming / routing helpers --------
function sanitizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
function getDomain(name) {
  return `${name}.${APP_DOMAIN}`;
}
function isReservedName(name) {
  return RESERVED_SUBS.has(name);
}
function siteDir(name) {
  return path.join(SITES_DIR, name);
}

// -------- Coolify API --------
async function coolify(method, urlPath, body) {
  if (!COOLIFY_API_URL || !COOLIFY_API_TOKEN || !COOLIFY_APP_UUID) {
    throw new Error('Coolify API not configured (COOLIFY_API_URL / COOLIFY_API_TOKEN / COOLIFY_APP_UUID)');
  }
  const res = await fetch(`${COOLIFY_API_URL}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${COOLIFY_API_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Coolify API ${res.status}`;
    throw new Error(`${msg} (${method} ${urlPath})`);
  }
  return data;
}

async function getThisApp() {
  return coolify('GET', `/api/v1/applications/${COOLIFY_APP_UUID}`);
}
async function setAppFqdns(fqdns) {
  // PATCH with the full new list of comma-separated domains.
  // Coolify's PATCH endpoint exposes this field as `domains` (not `fqdn`).
  const r = await coolify('PATCH', `/api/v1/applications/${COOLIFY_APP_UUID}`, {
    domains: fqdns.join(','),
  });
  // Trigger a container restart so Traefik picks up the new host labels
  // and Let's Encrypt issues the cert for the new FQDN. Fire-and-forget —
  // Coolify returns quickly and the actual restart happens async.
  coolify('POST', `/api/v1/applications/${COOLIFY_APP_UUID}/restart`).catch((e) => {
    console.error('[restart after fqdn change]', e.message);
  });
  return r;
}
async function attachFqdn(fqdn) {
  const app = await getThisApp();
  const current = String(app.fqdn || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const url = `https://${fqdn}`;
  if (current.includes(url) || current.includes(fqdn)) return { ok: true, already: true };
  current.push(url);
  await setAppFqdns(current);
  return { ok: true };
}
async function detachFqdn(fqdn) {
  const app = await getThisApp();
  const current = String(app.fqdn || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const remaining = current.filter((u) => {
    try {
      const host = new URL(u.includes('://') ? u : `https://${u}`).hostname;
      return host !== fqdn;
    } catch {
      return u !== fqdn;
    }
  });
  if (remaining.length === current.length) return { ok: true, missing: true };
  await setAppFqdns(remaining);
  return { ok: true };
}

// -------- migration: recompute .domain on existing apps when APP_DOMAIN changes --------
async function migrateAppDomains() {
  const apps = readJsonSync(APPS_FILE, {});
  const html = readJsonSync(HTML_APPS_FILE, {});
  let touchedApps = false, touchedHtml = false;
  for (const a of Object.values(apps)) {
    const want = getDomain(a.name);
    if (a.domain !== want) {
      console.log(`[migrate] react ${a.name}: ${a.domain} -> ${want}`);
      a.domain = want; touchedApps = true;
    }
  }
  for (const a of Object.values(html)) {
    const want = getDomain(a.name);
    if (a.domain !== want) {
      console.log(`[migrate] html  ${a.name}: ${a.domain} -> ${want}`);
      a.domain = want; touchedHtml = true;
    }
  }
  if (touchedApps) await writeJson(APPS_FILE, apps);
  if (touchedHtml) await writeJson(HTML_APPS_FILE, html);
}

// -------- bootstrap admin --------
async function ensureBootstrapAdmin() {
  const users = readJsonSync(USERS_FILE, {});
  if (Object.keys(users).length === 0 && ADMIN_PASSWORD) {
    users[ADMIN_USERNAME] = {
      username: ADMIN_USERNAME,
      password: hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      active: true,
      createdAt: new Date().toISOString(),
    };
    await writeJson(USERS_FILE, users);
    console.log(`[bootstrap] created admin user "${ADMIN_USERNAME}"`);
  }
}

// -------- sessions (in-memory tokens) --------
const sessions = new Map(); // token -> { username, createdAt }
function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// -------- express --------
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// host-based static serving for child apps must come BEFORE the dashboard.
// Priority:
//   1. exact PARENT_DOMAIN / localhost → dashboard
//   2. <sub>.APP_DOMAIN (flat layout) → child app, sub cannot contain a dot
//   3. <sub>.PARENT_DOMAIN (legacy nested layout) → child app, same rules
// This dual-matching lets us support both layouts during transition.
app.use((req, res, next) => {
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (host === PARENT_DOMAIN || host === '' || host === '127.0.0.1' || host === 'localhost') {
    return next();
  }
  const suffixes = [];
  if (APP_DOMAIN) suffixes.push('.' + APP_DOMAIN);
  if (PARENT_DOMAIN !== APP_DOMAIN) suffixes.push('.' + PARENT_DOMAIN);
  let sub = null;
  for (const suf of suffixes) {
    if (host.endsWith(suf)) {
      const candidate = host.slice(0, -suf.length);
      if (candidate && !candidate.includes('.')) { sub = candidate; break; }
    }
  }
  if (!sub) return next();
  // skip reserved names — they fall through to the dashboard routes (likely 404/ dashboard SPA)
  if (isReservedName(sub)) return next();
  const dir = siteDir(sub);
  if (!fs.existsSync(dir)) {
    return res.status(404).type('text/html').send(`<!doctype html><meta charset=utf-8><title>Not deployed</title><body style="font-family:system-ui;padding:2rem"><h1>${sub}.${APP_DOMAIN}</h1><p>This subdomain is registered but no bundle has been deployed yet.</p>`);
  }
  return express.static(dir, { fallthrough: false, index: 'index.html' })(req, res, (err) => {
    if (err) {
      const indexPath = path.join(dir, 'index.html');
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
      return res.status(404).send('Not found');
    }
  });
});

// -------- auth middleware --------
function getToken(req) {
  if (req.cookies && req.cookies.token) return req.cookies.token;
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}
function authRequired(req, res, next) {
  const token = getToken(req);
  const sess = token && sessions.get(token);
  if (!sess) return res.status(401).json({ error: 'unauthorized' });
  const users = readJsonSync(USERS_FILE, {});
  const user = users[sess.username];
  if (!user || !user.active) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  next();
}

// -------- auth routes --------
app.post('/api/register', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const u = sanitizeName(username);
  if (!u) return res.status(400).json({ error: 'invalid username' });
  const users = readJsonSync(USERS_FILE, {});
  if (users[u]) return res.status(409).json({ error: 'username taken' });
  users[u] = {
    username: u,
    password: hashPassword(password),
    role: 'user',
    active: false, // requires admin activation
    createdAt: new Date().toISOString(),
  };
  await writeJson(USERS_FILE, users);
  res.json({ ok: true, message: 'registered; awaiting admin activation' });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'username and password required' });
  const users = readJsonSync(USERS_FILE, {});
  const user = users[username];
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  if (!user.active) return res.status(403).json({ error: 'account not yet activated' });
  const token = newToken();
  sessions.set(token, { username: user.username, createdAt: Date.now() });
  res.cookie('token', token, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7 * 24 * 3600 * 1000 });
  res.json({ ok: true, user: { username: user.username, role: user.role } });
});

app.post('/api/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth-check', authRequired, (req, res) => {
  res.json({ ok: true, user: { username: req.user.username, role: req.user.role } });
});

// -------- admin: users --------
app.get('/api/admin/users', authRequired, adminOnly, (_req, res) => {
  const users = readJsonSync(USERS_FILE, {});
  res.json(Object.values(users).map((u) => ({
    username: u.username, role: u.role, active: u.active, createdAt: u.createdAt,
  })));
});
app.post('/api/admin/users/:username/toggle', authRequired, adminOnly, async (req, res) => {
  const users = readJsonSync(USERS_FILE, {});
  const u = users[req.params.username];
  if (!u) return res.status(404).json({ error: 'not found' });
  u.active = !u.active;
  await writeJson(USERS_FILE, users);
  res.json({ ok: true, active: u.active });
});
app.delete('/api/admin/users/:username', authRequired, adminOnly, async (req, res) => {
  const users = readJsonSync(USERS_FILE, {});
  if (!users[req.params.username]) return res.status(404).json({ error: 'not found' });
  if (users[req.params.username].role === 'admin') {
    return res.status(400).json({ error: 'cannot delete admin' });
  }
  delete users[req.params.username];
  await writeJson(USERS_FILE, users);
  res.json({ ok: true });
});

// -------- code validation (React apps) --------
function validateReactCode(code) {
  if (!code || typeof code !== 'string') return 'code is required';
  const lower = code.toLowerCase().trim();
  if (lower.startsWith('<!doctype') || lower.startsWith('<html') || lower.startsWith('<head') || lower.startsWith('<body')) {
    return 'looks like raw HTML — use the HTML deploy section instead';
  }
  if (!/export\s+default/.test(code)) return 'must contain `export default`';
  return null;
}

// -------- deploy: write bundle to disk --------
async function writeReactBundle(name, code) {
  // MVP: ship the JSX as a single HTML page using esm.sh + Babel standalone.
  // Avoids a build step in the container while still rendering modern JSX.
  // Replace later with a true vite build + persisted dist.
  const dir = siteDir(name);
  ensureDirSync(dir);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${name}</title>
<script type="importmap">
{ "imports": {
    "react": "https://esm.sh/react@18.3.1",
    "react-dom": "https://esm.sh/react-dom@18.3.1",
    "react-dom/client": "https://esm.sh/react-dom@18.3.1/client"
  } }
</script>
<script src="https://unpkg.com/@babel/standalone@7.24.7/babel.min.js"></script>
</head>
<body>
<div id="root"></div>
<script type="text/babel" data-type="module" data-presets="env,react">
${code}
import { createRoot } from 'react-dom/client';
import React from 'react';
const App = (typeof App !== 'undefined') ? App : (typeof default_1 !== 'undefined' ? default_1 : null);
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(App || (() => React.createElement('pre', null, 'Failed to find default export'))));
</script>
</body>
</html>`;
  await fsp.writeFile(path.join(dir, 'index.html'), html);
}
async function writeHtmlBundle(name, html) {
  const dir = siteDir(name);
  ensureDirSync(dir);
  await fsp.writeFile(path.join(dir, 'index.html'), html);
}
async function removeBundle(name) {
  const dir = siteDir(name);
  await fsp.rm(dir, { recursive: true, force: true });
}

// -------- React apps CRUD --------
app.get('/api/apps', authRequired, (_req, res) => {
  const apps = readJsonSync(APPS_FILE, {});
  res.json(Object.values(apps));
});
app.get('/api/apps/:name', authRequired, (req, res) => {
  const apps = readJsonSync(APPS_FILE, {});
  const a = apps[req.params.name];
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});
app.post('/api/apps', authRequired, async (req, res) => {
  try {
    const { name, code } = req.body || {};
    const n = sanitizeName(name);
    if (!n) return res.status(400).json({ error: 'invalid name' });
    if (isReservedName(n)) return res.status(400).json({ error: `"${n}" is a reserved name` });
    const err = validateReactCode(code);
    if (err) return res.status(400).json({ error: err });
    const apps = readJsonSync(APPS_FILE, {});
    const html = readJsonSync(HTML_APPS_FILE, {});
    if (apps[n] || html[n]) return res.status(409).json({ error: 'name already used' });
    await writeReactBundle(n, code);
    const fqdn = getDomain(n);
    let fqdnResult = { skipped: true };
    try { fqdnResult = await attachFqdn(fqdn); } catch (e) {
      console.error('[attachFqdn]', e.message);
      fqdnResult = { error: e.message };
    }
    apps[n] = {
      name: n, type: 'react', domain: fqdn, owner: req.user.username,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      code,
    };
    await writeJson(APPS_FILE, apps);
    res.json({ ok: true, app: apps[n], fqdn: fqdnResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.put('/api/apps/:name', authRequired, async (req, res) => {
  try {
    const apps = readJsonSync(APPS_FILE, {});
    const a = apps[req.params.name];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.owner !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { code } = req.body || {};
    const err = validateReactCode(code);
    if (err) return res.status(400).json({ error: err });
    await writeReactBundle(a.name, code);
    a.code = code;
    a.updatedAt = new Date().toISOString();
    await writeJson(APPS_FILE, apps);
    res.json({ ok: true, app: a });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/apps/:name', authRequired, async (req, res) => {
  try {
    const apps = readJsonSync(APPS_FILE, {});
    const a = apps[req.params.name];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.owner !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    await removeBundle(a.name);
    let fqdnResult = { skipped: true };
    try { fqdnResult = await detachFqdn(a.domain); } catch (e) { fqdnResult = { error: e.message }; }
    delete apps[a.name];
    await writeJson(APPS_FILE, apps);
    res.json({ ok: true, fqdn: fqdnResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- HTML apps CRUD --------
app.get('/api/html-apps', authRequired, (_req, res) => {
  const html = readJsonSync(HTML_APPS_FILE, {});
  res.json(Object.values(html));
});
app.get('/api/html-apps/:name', authRequired, (req, res) => {
  const html = readJsonSync(HTML_APPS_FILE, {});
  const a = html[req.params.name];
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});
app.post('/api/html-apps', authRequired, async (req, res) => {
  try {
    const { name, html: body } = req.body || {};
    const n = sanitizeName(name);
    if (!n) return res.status(400).json({ error: 'invalid name' });
    if (isReservedName(n)) return res.status(400).json({ error: `"${n}" is a reserved name` });
    if (!body || typeof body !== 'string' || body.length < 10) return res.status(400).json({ error: 'html required' });
    const apps = readJsonSync(APPS_FILE, {});
    const html = readJsonSync(HTML_APPS_FILE, {});
    if (apps[n] || html[n]) return res.status(409).json({ error: 'name already used' });
    await writeHtmlBundle(n, body);
    const fqdn = getDomain(n);
    let fqdnResult = { skipped: true };
    try { fqdnResult = await attachFqdn(fqdn); } catch (e) { fqdnResult = { error: e.message }; }
    html[n] = {
      name: n, type: 'html', domain: fqdn, owner: req.user.username,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      html: body,
    };
    await writeJson(HTML_APPS_FILE, html);
    res.json({ ok: true, app: html[n], fqdn: fqdnResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.put('/api/html-apps/:name', authRequired, async (req, res) => {
  try {
    const html = readJsonSync(HTML_APPS_FILE, {});
    const a = html[req.params.name];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.owner !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { html: body } = req.body || {};
    if (!body || typeof body !== 'string') return res.status(400).json({ error: 'html required' });
    await writeHtmlBundle(a.name, body);
    a.html = body;
    a.updatedAt = new Date().toISOString();
    await writeJson(HTML_APPS_FILE, html);
    res.json({ ok: true, app: a });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/html-apps/:name', authRequired, async (req, res) => {
  try {
    const html = readJsonSync(HTML_APPS_FILE, {});
    const a = html[req.params.name];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (a.owner !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    await removeBundle(a.name);
    let fqdnResult = { skipped: true };
    try { fqdnResult = await detachFqdn(a.domain); } catch (e) { fqdnResult = { error: e.message }; }
    delete html[a.name];
    await writeJson(HTML_APPS_FILE, html);
    res.json({ ok: true, fqdn: fqdnResult });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// -------- health + meta --------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    parentDomain: PARENT_DOMAIN,
    appDomain: APP_DOMAIN,
    coolifyConfigured: Boolean(COOLIFY_API_URL && COOLIFY_API_TOKEN && COOLIFY_APP_UUID),
    time: new Date().toISOString(),
  });
});
app.get('/api/meta', (_req, res) => {
  res.json({ parentDomain: PARENT_DOMAIN, appDomain: APP_DOMAIN });
});

// -------- static dashboard + SPA fallback --------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------- start --------
Promise.resolve()
  .then(() => ensureBootstrapAdmin())
  .then(() => migrateAppDomains())
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`[deployer] listening on :${PORT}`);
      console.log(`  dashboard host: ${PARENT_DOMAIN}`);
      console.log(`  child suffix:   ${APP_DOMAIN} (apps live at <name>.${APP_DOMAIN})`);
      console.log(`  data dir:       ${DATA_DIR}`);
      console.log(`  coolify api:    ${COOLIFY_API_URL ? 'configured' : 'NOT configured'}`);
    });
  });
