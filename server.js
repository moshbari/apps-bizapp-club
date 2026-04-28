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

// Magic-link / passwordless config
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAGIC_LINK_FROM = process.env.MAGIC_LINK_FROM || 'bizapp@onesign.click';
const MAGIC_LINK_FROM_NAME = process.env.MAGIC_LINK_FROM_NAME || 'apps.bizapp.club';
const BASE_URL = (process.env.BASE_URL || `https://${PARENT_DOMAIN}`).replace(/\/+$/, '');
const MAGIC_TOKEN_TTL_MS = 24 * 3600 * 1000; // 24h

const SITES_DIR = path.join(DATA_DIR, 'sites');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const HTML_APPS_FILE = path.join(DATA_DIR, 'html-apps.json');
// Magic-token store: holds both pending-deploys (anonymous publish requests
// awaiting email confirmation) AND login-links (existing user sign-in).
const MAGIC_TOKENS_FILE = path.join(DATA_DIR, 'magic-tokens.json');

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

// -------- email + magic-link helpers --------
function isEmail(s) {
  return typeof s === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}
function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

async function sendEmail({ to, subject, html, text }) {
  if (!RESEND_API_KEY) {
    console.warn('[sendEmail] RESEND_API_KEY not set — would have sent to:', to, 'subject:', subject);
    throw new Error('Email is not configured (RESEND_API_KEY missing)');
  }
  const from = MAGIC_LINK_FROM_NAME ? `${MAGIC_LINK_FROM_NAME} <${MAGIC_LINK_FROM}>` : MAGIC_LINK_FROM;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, html, text }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || data?.error || `Resend ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function magicLinkEmail({ link, intent, appType, appName, appDomain, expiresIn = '24 hours' }) {
  // intent: 'deploy' | 'login'
  const isDeploy = intent === 'deploy';
  const heading = isDeploy ? 'Confirm and publish your app' : 'Sign in to apps.bizapp.club';
  const lead = isDeploy
    ? `Click the button below to publish <strong>${appName}</strong> at <a href="https://${appDomain}">${appDomain}</a> and view it live.`
    : `Click the button below to sign in. This link expires in ${expiresIn}.`;
  const cta = isDeploy ? 'Publish my app' : 'Sign in';
  const subject = isDeploy
    ? `Confirm and publish "${appName}"`
    : 'Sign in to apps.bizapp.club';
  const html = `<!doctype html><html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f6f8;margin:0;padding:24px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:white;border-radius:12px;border:1px solid #e2e5ec">
  <tr><td style="padding:28px 28px 8px">
    <h2 style="margin:0 0 12px;color:#0b0d12">${heading}</h2>
    <p style="margin:0 0 18px;color:#3a4053;line-height:1.5">${lead}</p>
    <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#5b9dff;color:white;text-decoration:none;font-weight:600;padding:12px 22px;border-radius:8px">${cta}</a></p>
    <p style="margin:0 0 6px;color:#6c7588;font-size:13px">If the button doesn't work, paste this link in your browser:</p>
    <p style="margin:0;word-break:break-all"><a href="${link}" style="color:#5b9dff">${link}</a></p>
    <hr style="border:none;border-top:1px solid #eef0f4;margin:22px 0" />
    <p style="margin:0;color:#8a93a6;font-size:12px">This link expires in ${expiresIn}. If you didn't request it, you can ignore this email.</p>
  </td></tr>
</table></body></html>`;
  const text = `${heading}\n\n${isDeploy ? `Click to publish "${appName}" at https://${appDomain}` : 'Click to sign in'}:\n${link}\n\nThis link expires in ${expiresIn}. If you didn't request it, you can ignore this email.`;
  return { subject, html, text };
}

// Magic tokens: { token: { type, email, payload?, createdAt, expiresAt, usedAt? } }
function readMagicTokens() { return readJsonSync(MAGIC_TOKENS_FILE, {}); }
async function writeMagicTokens(d) { return writeJson(MAGIC_TOKENS_FILE, d); }
function gcMagicTokens(d) {
  const now = Date.now();
  let changed = false;
  for (const [tok, t] of Object.entries(d)) {
    if (!t || (t.expiresAt && t.expiresAt < now) || (t.usedAt && (now - t.usedAt) > 24 * 3600 * 1000)) {
      delete d[tok]; changed = true;
    }
  }
  return changed;
}
async function createMagicToken({ type, email, payload }) {
  const tokens = readMagicTokens();
  if (gcMagicTokens(tokens)) await writeMagicTokens(tokens);
  const token = crypto.randomBytes(32).toString('hex');
  tokens[token] = {
    type, email: normalizeEmail(email), payload: payload || null,
    createdAt: Date.now(), expiresAt: Date.now() + MAGIC_TOKEN_TTL_MS,
  };
  await writeMagicTokens(tokens);
  return token;
}
async function consumeMagicToken(token) {
  const tokens = readMagicTokens();
  const t = tokens[token];
  if (!t) return null;
  if (t.expiresAt && t.expiresAt < Date.now()) { delete tokens[token]; await writeMagicTokens(tokens); return null; }
  if (t.usedAt) return null; // already used (single-use)
  t.usedAt = Date.now();
  await writeMagicTokens(tokens);
  return t;
}
function pendingSubdomainsInUse() {
  const tokens = readMagicTokens();
  const now = Date.now();
  const subs = new Set();
  for (const t of Object.values(tokens)) {
    if (t && t.type === 'pending-deploy' && !t.usedAt && (!t.expiresAt || t.expiresAt > now)) {
      const sub = t.payload?.subdomain || t.payload?.name;
      if (sub) subs.add(sub);
    }
  }
  return subs;
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
app.post('/api/register', (_req, res) => {
  // Public username+password signup is disabled. New users come in via magic link.
  res.status(410).json({ error: 'public registration disabled — use email magic link instead' });
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
  res.json({ ok: true, user: { username: user.username, email: user.email || null, role: user.role } });
});


// -------- POST /api/login-link — send a magic-link to existing user by email --------
app.post('/api/login-link', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!isEmail(email)) return res.status(400).json({ error: 'valid email required' });
    const users = readJsonSync(USERS_FILE, {});
    // find user keyed by email; users created via magic link use email as their key
    let user = users[email];
    // if missing, scan for user.email match (admin-created accounts that have an email field)
    if (!user) {
      for (const u of Object.values(users)) {
        if (normalizeEmail(u.email) === email) { user = u; break; }
      }
    }
    // for security, always return ok (do not leak whether the email exists)
    if (!user || !user.active) {
      return res.json({ ok: true, sent: false });
    }
    const token = await createMagicToken({ type: 'login-link', email, payload: { username: user.username } });
    const link = `${BASE_URL}/auth/magic?token=${token}`;
    const tpl = magicLinkEmail({ link, intent: 'login' });
    try {
      await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    } catch (e) {
      console.error('[sendEmail/login-link]', e.message);
      return res.status(500).json({ error: 'failed to send email: ' + e.message });
    }
    res.json({ ok: true, sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// -------- POST /api/pending — anonymous user wants to deploy an app --------
// Body: { type: 'react'|'html', name, subdomain?, code?, html?, email }
// Stores a pending record + sends magic link. The actual deploy happens when
// the magic link is consumed at /auth/magic.
app.post('/api/pending', async (req, res) => {
  try {
    const { type, name, subdomain: rawSub, code, html: htmlBody, email: rawEmail } = req.body || {};
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) return res.status(400).json({ error: 'valid email required' });
    if (type !== 'react' && type !== 'html') return res.status(400).json({ error: 'type must be "react" or "html"' });
    const n = sanitizeName(name);
    if (!n) return res.status(400).json({ error: 'invalid name' });
    if (isReservedName(n)) return res.status(400).json({ error: `"${n}" is a reserved name` });
    const sub = rawSub ? sanitizeName(rawSub) : n;
    if (!sub) return res.status(400).json({ error: 'invalid subdomain' });
    if (isReservedName(sub)) return res.status(400).json({ error: `"${sub}" is a reserved subdomain` });
    if (type === 'react') {
      const err = validateReactCode(code);
      if (err) return res.status(400).json({ error: err });
    } else {
      if (!htmlBody || typeof htmlBody !== 'string' || htmlBody.length < 10) return res.status(400).json({ error: 'html required' });
    }
    // Conflict check: against react apps, html apps, and OTHER pending records
    const apps = readJsonSync(APPS_FILE, {});
    const html = readJsonSync(HTML_APPS_FILE, {});
    const usedSubs = new Set([
      ...Object.values(apps).map((a) => a.subdomain || a.name),
      ...Object.values(html).map((a) => a.subdomain || a.name),
      ...pendingSubdomainsInUse(),
    ]);
    if (usedSubs.has(sub)) return res.status(409).json({ error: `subdomain "${sub}" already in use or pending` });
    if (apps[n] || html[n]) return res.status(409).json({ error: 'name already used' });

    const payload = { type, name: n, subdomain: sub, code: code || null, html: htmlBody || null };
    const token = await createMagicToken({ type: 'pending-deploy', email, payload });
    const link = `${BASE_URL}/auth/magic?token=${token}`;
    const appDomain = getDomain(sub);
    const tpl = magicLinkEmail({ link, intent: 'deploy', appType: type, appName: n, appDomain });
    try {
      await sendEmail({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text });
    } catch (e) {
      console.error('[sendEmail/pending]', e.message);
      return res.status(500).json({ error: 'failed to send email: ' + e.message });
    }
    res.json({ ok: true, message: `Magic link sent to ${email}. Click it to publish your app.` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// -------- GET /auth/magic?token=... — consume token, deploy if pending, set session, redirect to dashboard --------
app.get('/auth/magic', async (req, res) => {
  try {
    const token = String(req.query?.token || '');
    if (!token) return res.status(400).type('text/html').send(magicErrorPage('Missing token'));
    const t = await consumeMagicToken(token);
    if (!t) return res.status(400).type('text/html').send(magicErrorPage('This link has expired or has already been used. Please request a new one.'));
    const email = normalizeEmail(t.email);
    if (!isEmail(email)) return res.status(400).type('text/html').send(magicErrorPage('Invalid email on token'));
    const users = readJsonSync(USERS_FILE, {});
    let user = users[email];
    // If a record exists with email field but different username, find it
    if (!user) {
      for (const u of Object.values(users)) {
        if (normalizeEmail(u.email) === email) { user = u; break; }
      }
    }
    // Auto-create user if needed (magic-link users have no password, are active immediately)
    if (!user) {
      user = {
        username: email,
        email,
        role: 'user',
        active: true,
        password: null,
        createdAt: new Date().toISOString(),
        passwordless: true,
      };
      users[email] = user;
      await writeJson(USERS_FILE, users);
    } else if (!user.active) {
      // re-activate (defensive — magic-link confirms email)
      user.active = true;
      await writeJson(USERS_FILE, users);
    }
    // If this magic was a pending-deploy, finalize the deploy under this user.
    if (t.type === 'pending-deploy' && t.payload) {
      try {
        await finalizePendingDeploy(t.payload, user);
      } catch (e) {
        console.error('[finalizePendingDeploy]', e.message);
        return res.status(500).type('text/html').send(magicErrorPage(`Could not publish your app: ${e.message}`));
      }
    }
    // Create session
    const sessTok = newToken();
    sessions.set(sessTok, { username: user.username, createdAt: Date.now() });
    res.cookie('token', sessTok, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 7 * 24 * 3600 * 1000 });
    if (t.type === 'pending-deploy' && t.payload) {
      const sub = t.payload.subdomain || t.payload.name;
      const liveUrl = `https://${sub}.${APP_DOMAIN}`;
      return res.type('text/html').send(magicDeployedInterstitial({ liveUrl, sub }));
    }
    return res.redirect(302, '/');
  } catch (e) {
    res.status(500).type('text/html').send(magicErrorPage(e.message));
  }
});

function magicDeployedInterstitial({ liveUrl, sub }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Publishing ${sub}...</title><style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0d12;color:#e6e9ef;margin:0;padding:0;min-height:100vh;display:grid;place-items:center}
    .card{background:#141821;border:1px solid #262d3d;border-radius:14px;padding:32px;max-width:520px;width:calc(100% - 32px);text-align:center}
    h1{margin:0 0 8px;font-size:22px}
    p{margin:0 0 16px;color:#8a93a6;line-height:1.5}
    .url{color:#5b9dff;word-break:break-all;font-weight:500}
    .spinner{width:32px;height:32px;border:3px solid #262d3d;border-top-color:#5b9dff;border-radius:50%;margin:18px auto;animation:spin 1s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    .btn{display:inline-block;background:linear-gradient(135deg,#5b9dff,#7c5bff);color:white;border:0;border-radius:8px;padding:11px 18px;font-weight:600;text-decoration:none;font-size:14px;cursor:pointer;font-family:inherit}
    .btn.secondary{background:#1b2130;border:1px solid #262d3d}
    .btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:8px}
    .ok-icon{font-size:42px}
  </style></head><body>
  <div class="card" id="root">
    <div id="loading">
      <h1>Publishing your app...</h1>
      <p class="url">${liveUrl}</p>
      <div class="spinner"></div>
      <p>This usually takes 15-30 seconds while we set up DNS and TLS. <br />Please don't close this tab.</p>
    </div>
    <div id="ready" style="display:none">
      <div class="ok-icon">🎉</div>
      <h1 style="margin-top:8px">Your app is live</h1>
      <p class="url">${liveUrl}</p>
      <div class="btns">
        <a class="btn" href="${liveUrl}" target="_blank" rel="noreferrer">Open live page</a>
        <a class="btn secondary" href="/">Go to dashboard</a>
      </div>
    </div>
    <div id="slow" style="display:none">
      <h1>Still finishing up...</h1>
      <p class="url">${liveUrl}</p>
      <p>Provisioning is taking longer than usual. The app will be live within a minute or two. You can open it from the dashboard or try the link below.</p>
      <div class="btns">
        <a class="btn" href="${liveUrl}" target="_blank" rel="noreferrer">Try the live page</a>
        <a class="btn secondary" href="/">Go to dashboard</a>
      </div>
    </div>
  </div>
  <script>
    const url = ${JSON.stringify(liveUrl)};
    const start = Date.now();
    const maxMs = 90000;
    async function probe() {
      try {
        const r = await fetch(url + '/?_=' + Date.now(), { method: 'GET', mode: 'no-cors', cache: 'no-store' });
        // no-cors returns opaque; treat any non-throw as success
        return true;
      } catch (e) { return false; }
    }
    async function loop() {
      while (Date.now() - start < maxMs) {
        await new Promise(r => setTimeout(r, 2500));
        if (await probe()) {
          document.getElementById('loading').style.display = 'none';
          document.getElementById('ready').style.display = 'block';
          return;
        }
      }
      document.getElementById('loading').style.display = 'none';
      document.getElementById('slow').style.display = 'block';
    }
    loop();
  </script>
  </body></html>`;
}

function magicErrorPage(msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Magic link</title><style>body{font-family:system-ui;background:#0b0d12;color:#e6e9ef;padding:48px;max-width:560px;margin:0 auto}a{color:#5b9dff}</style></head><body><h2>That link didn't work</h2><p>${msg}</p><p><a href="/">Go to the dashboard</a></p></body></html>`;
}

async function finalizePendingDeploy(payload, user) {
  const { type, name, subdomain, code, html: htmlBody } = payload;
  const apps = readJsonSync(APPS_FILE, {});
  const html = readJsonSync(HTML_APPS_FILE, {});
  if (apps[name] || html[name]) throw new Error('name already used');
  const usedSubs = new Set([
    ...Object.values(apps).map((a) => a.subdomain || a.name),
    ...Object.values(html).map((a) => a.subdomain || a.name),
  ]);
  if (usedSubs.has(subdomain)) throw new Error(`subdomain "${subdomain}" already in use`);
  const fqdn = getDomain(subdomain);
  if (type === 'react') {
    await writeReactBundle(subdomain, code);
  } else {
    await writeHtmlBundle(subdomain, htmlBody);
  }
  let fqdnResult = { skipped: true };
  try { fqdnResult = await attachFqdn(fqdn); } catch (e) { fqdnResult = { error: e.message }; console.error('[attachFqdn/finalize]', e.message); }
  const record = {
    name, subdomain, type, domain: fqdn, owner: user.username,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  if (type === 'react') {
    record.code = code;
    apps[name] = record;
    await writeJson(APPS_FILE, apps);
  } else {
    record.html = htmlBody;
    html[name] = record;
    await writeJson(HTML_APPS_FILE, html);
  }
  return { record, fqdnResult };
}

app.post('/api/logout', (req, res) => {
  const token = getToken(req);
  if (token) sessions.delete(token);
  res.clearCookie('token');
  res.json({ ok: true });
});

app.get('/api/auth-check', authRequired, (req, res) => {
  res.json({ ok: true, user: { username: req.user.username, email: req.user.email || null, role: req.user.role } });
});

// -------- change own password --------
app.post('/api/change-password', authRequired, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ error: 'oldPassword and newPassword required' });
  if (String(newPassword).length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  const users = readJsonSync(USERS_FILE, {});
  const user = users[req.user.username];
  if (!user || !verifyPassword(oldPassword, user.password)) {
    return res.status(401).json({ error: 'invalid old password' });
  }
  user.password = hashPassword(newPassword);
  user.updatedAt = new Date().toISOString();
  await writeJson(USERS_FILE, users);
  // invalidate other sessions for this user
  for (const [tok, s] of sessions) if (s.username === user.username) sessions.delete(tok);
  res.clearCookie('token');
  res.json({ ok: true, message: 'password changed — please log in again' });
});

// -------- admin: reset another user's password --------
app.post('/api/admin/users/:username/reset-password', authRequired, adminOnly, async (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 8) return res.status(400).json({ error: 'newPassword must be at least 8 characters' });
  const users = readJsonSync(USERS_FILE, {});
  const u = users[req.params.username];
  if (!u) return res.status(404).json({ error: 'not found' });
  u.password = hashPassword(newPassword);
  u.updatedAt = new Date().toISOString();
  await writeJson(USERS_FILE, users);
  for (const [tok, s] of sessions) if (s.username === u.username) sessions.delete(tok);
  res.json({ ok: true });
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
app.get('/api/apps', authRequired, (req, res) => {
  const apps = readJsonSync(APPS_FILE, {});
  const all = Object.values(apps);
  const visible = req.user.role === 'admin' ? all : all.filter((a) => a.owner === req.user.username);
  res.json(visible);
});
app.get('/api/apps/:name', authRequired, (req, res) => {
  const apps = readJsonSync(APPS_FILE, {});
  const a = apps[req.params.name];
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.owner !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json(a);
});
app.post('/api/apps', authRequired, async (req, res) => {
  try {
    const { name, subdomain: rawSubdomain, code } = req.body || {};
    const n = sanitizeName(name);
    if (!n) return res.status(400).json({ error: 'invalid name' });
    if (isReservedName(n)) return res.status(400).json({ error: `"${n}" is a reserved name` });
    const sub = rawSubdomain ? sanitizeName(rawSubdomain) : n;
    if (!sub) return res.status(400).json({ error: 'invalid subdomain' });
    if (isReservedName(sub)) return res.status(400).json({ error: `"${sub}" is a reserved subdomain` });
    const err = validateReactCode(code);
    if (err) return res.status(400).json({ error: err });
    const apps = readJsonSync(APPS_FILE, {});
    const html = readJsonSync(HTML_APPS_FILE, {});
    // page-name uniqueness (storage key)
    if (apps[n] || html[n]) return res.status(409).json({ error: 'name already used' });
    // effective-subdomain uniqueness across both react and html apps
    const usedSubs = new Set([
      ...Object.values(apps).map((a) => a.subdomain || a.name),
      ...Object.values(html).map((a) => a.subdomain || a.name),
    ]);
    if (usedSubs.has(sub)) return res.status(409).json({ error: `subdomain "${sub}" already in use` });
    await writeReactBundle(sub, code);
    const fqdn = getDomain(sub);
    let fqdnResult = { skipped: true };
    try { fqdnResult = await attachFqdn(fqdn); } catch (e) {
      console.error('[attachFqdn]', e.message);
      fqdnResult = { error: e.message };
    }
    apps[n] = {
      name: n, subdomain: sub, type: 'react', domain: fqdn, owner: req.user.username,
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
    await writeReactBundle(a.subdomain || a.name, code);
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
    await removeBundle(a.subdomain || a.name);
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
app.get('/api/html-apps', authRequired, (req, res) => {
  const html = readJsonSync(HTML_APPS_FILE, {});
  const all = Object.values(html);
  const visible = req.user.role === 'admin' ? all : all.filter((a) => a.owner === req.user.username);
  res.json(visible);
});
app.get('/api/html-apps/:name', authRequired, (req, res) => {
  const html = readJsonSync(HTML_APPS_FILE, {});
  const a = html[req.params.name];
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.owner !== req.user.username && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.json(a);
});
app.post('/api/html-apps', authRequired, async (req, res) => {
  try {
    const { name, subdomain: rawSubdomain, html: body } = req.body || {};
    const n = sanitizeName(name);
    if (!n) return res.status(400).json({ error: 'invalid name' });
    if (isReservedName(n)) return res.status(400).json({ error: `"${n}" is a reserved name` });
    const sub = rawSubdomain ? sanitizeName(rawSubdomain) : n;
    if (!sub) return res.status(400).json({ error: 'invalid subdomain' });
    if (isReservedName(sub)) return res.status(400).json({ error: `"${sub}" is a reserved subdomain` });
    if (!body || typeof body !== 'string' || body.length < 10) return res.status(400).json({ error: 'html required' });
    const apps = readJsonSync(APPS_FILE, {});
    const html = readJsonSync(HTML_APPS_FILE, {});
    // page-name uniqueness (storage key)
    if (apps[n] || html[n]) return res.status(409).json({ error: 'name already used' });
    // effective-subdomain uniqueness (across both react and html apps)
    const usedSubs = new Set([
      ...Object.values(apps).map((a) => a.subdomain || a.name),
      ...Object.values(html).map((a) => a.subdomain || a.name),
    ]);
    if (usedSubs.has(sub)) return res.status(409).json({ error: `subdomain "${sub}" already in use` });
    await writeHtmlBundle(sub, body);
    const fqdn = getDomain(sub);
    let fqdnResult = { skipped: true };
    try { fqdnResult = await attachFqdn(fqdn); } catch (e) { fqdnResult = { error: e.message }; }
    html[n] = {
      name: n, subdomain: sub, type: 'html', domain: fqdn, owner: req.user.username,
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
    await writeHtmlBundle(a.subdomain || a.name, body);
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
    await removeBundle(a.subdomain || a.name);
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
  res.json({ parentDomain: PARENT_DOMAIN, appDomain: APP_DOMAIN, magicLinkEnabled: Boolean(RESEND_API_KEY) });
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
