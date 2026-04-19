# apps.bizapp.club — deployer dashboard

A Coolify-native rebuild of [moshbari/app-deployer](https://github.com/moshbari/app-deployer).
Same UX (deploy React components or raw HTML to a personal subdomain), but the
deploy plumbing is Coolify + Traefik instead of HestiaCP shell-outs.

## How it works

- One Express container serves both the dashboard and **every** child app.
- Each child app gets a subdomain `<name>.apps.bizapp.club`.
- When you deploy an app the server:
  1. Writes the bundle to `/data/sites/<name>/index.html`
  2. Calls Coolify's API to attach `https://<name>.apps.bizapp.club` as an FQDN
     of this very application — Traefik picks up the new host, and Coolify asks
     Let's Encrypt for a cert.
- Incoming requests are routed by `Host:` header inside Express:
  - `apps.bizapp.club` → dashboard SPA
  - `<sub>.apps.bizapp.club` → static files from `/data/sites/<sub>`

## Required environment

| Var | Required | Notes |
|---|---|---|
| `PARENT_DOMAIN` | yes | e.g. `apps.bizapp.club` |
| `ADMIN_USERNAME` | first boot | bootstrap admin (created if no users exist) |
| `ADMIN_PASSWORD` | first boot | bootstrap admin password |
| `COOLIFY_API_URL` | yes | usually `http://coolify:8080` from inside Coolify's network |
| `COOLIFY_API_TOKEN` | yes | API token with permission to PATCH applications |
| `COOLIFY_APP_UUID` | yes | UUID of THIS application in Coolify |
| `PORT` | no | defaults to `3000` |
| `DATA_DIR` | no | defaults to `/data` (mount a volume) |

## Persistent storage

Mount a volume at `/data`. It holds:

```
/data/users.json
/data/apps.json
/data/html-apps.json
/data/sites/<name>/...   # rendered child-app bundles
```

## API surface

```
POST /api/register             { username, password }
POST /api/login                { username, password }
POST /api/logout
GET  /api/auth-check
GET  /api/admin/users
POST /api/admin/users/:user/toggle
DEL  /api/admin/users/:user

GET    /api/apps
POST   /api/apps               { name, code }       # React, must `export default`
GET    /api/apps/:name
PUT    /api/apps/:name         { code }
DELETE /api/apps/:name

GET    /api/html-apps
POST   /api/html-apps          { name, html }
GET    /api/html-apps/:name
PUT    /api/html-apps/:name    { html }
DELETE /api/html-apps/:name

GET /api/health
GET /api/meta
```

## Local development

```
npm install
PARENT_DOMAIN=localhost ADMIN_PASSWORD=admin npm start
# open http://localhost:3000
```

(Without Coolify env vars, app-create will write the bundle but the FQDN-attach step will return a non-fatal error — useful for UI dev.)
