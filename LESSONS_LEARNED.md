# Lessons Learned

A running log of things that broke, why they broke, and what we'd do differently. Newest at the top.

---

## 2026-05-15 — "no available server" on recently-created child apps

### What happened
Two child apps — `bizappclubsalespage2.bizapp.club` and `exclusive.bizapp.club` — returned Traefik's "no available server" 404. Both showed up correctly in the dashboard's app list and had records in `html-apps.json`, but the browser never reached them.

Every app created before some unknown date worked fine. Every app created after that date had the same problem.

### Root cause
The deployer's `COOLIFY_API_TOKEN` env var had gone stale. Every call from the deployer to Coolify's API was coming back with `Unauthenticated`. That meant `attachFqdn(fqdn)` (in `server.js`) was failing for every new app — but it failed *silently*:

```js
// server.js — POST /api/html-apps (and the React equivalent)
let fqdnResult = { skipped: true };
try { fqdnResult = await attachFqdn(fqdn); }
catch (e) { fqdnResult = { error: e.message }; console.error('[attachFqdn]', e.message); }
// ...
res.json({ ok: true, app: ..., fqdn: fqdnResult });
```

The handler logs the error, stuffs it into the response under `fqdn.error`, and *still returns `ok: true`*. The HTML bundle gets written to disk. The DB record gets saved. Only Coolify's `domains` field never updates, so Traefik has no idea the new hostname exists.

The dashboard UI doesn't render `fqdn.error` anywhere visible, so from the user's perspective the app "deployed" — until they actually open the URL.

### How we fixed it
1. Confirmed the token was the problem: hit `GET /api/v1/applications/{uuid}` with a fresh token → 200. The deployer's own stored token was bad.
2. PATCH'd Coolify's `domains` field with the two missing FQDNs added; restarted the container so Traefik regenerated its router labels.
3. PATCH'd the deployer's `COOLIFY_API_TOKEN` env var to the working token via `PATCH /api/v1/applications/{uuid}/envs`; restarted again so the deployer's in-process value was fresh.
4. End-to-end verified both broken URLs returned HTTP 200 with the correct page title; spot-checked previously-working apps for regressions.

Memory file with the full diagnostic playbook: `reference_no_available_server_diagnosis.md` (Claude's local memory).

### Lessons

**1. Silent failures in two-step deploys will bite us again.** Writing the bundle and attaching the FQDN should either be atomic (both succeed or both roll back) or the partial-failure state should be screaming loud in the UI. Today the deployer happily reports success when half of the job failed.

**2. Token health needs an active probe.** `COOLIFY_API_TOKEN` is a single point of failure with no monitoring. There's no startup check, no periodic ping, no metric. The right place is `/api/health` — it should attempt a cheap Coolify call (`GET /api/v1/applications/{uuid}`) and surface `coolifyReachable: true/false` alongside `coolifyConfigured`.

**3. Drift between deployer DB and Coolify state has no observability.** Today the only way to find a broken app is to visit its URL. A reconciliation endpoint that diffs `apps.json` + `html-apps.json` against Coolify's `domains` would turn this from "user notices days later" into "Claude can audit on demand".

**4. The diagnostic sequence is now reusable.** When "no available server" comes up again, the order is:
   - DNS resolves to `178.156.240.200`? (`dig +short`)
   - Server returns 404 with "no available server" body? (`curl -sI -H "Host: ..." http://178.156.240.200/`)
   - FQDN missing from Coolify's domain list? (`GET /api/v1/applications/{uuid}` — check `fqdn` field)
   - Deployer's DB has the record? (`GET /api/html-apps/<name>` or `/api/apps/<name>` with admin auth)
   - If DB row exists but Coolify is missing it → `attachFqdn` silently failed → check the token first.

### Recommended follow-ups (not done in this incident)

- **Surface partial-failure to the UI.** Make `POST /api/html-apps` and `POST /api/apps` return a non-2xx status when `attachFqdn` fails, with a structured `code: "fqdn-attach-failed"` so the dashboard can render an actionable error and offer a retry button.
- **Add a Coolify-ping to `/api/health`.** A cheap `GET` on the deployer's own UUID, returning `coolifyReachable: boolean` and `coolifyTokenValid: boolean`. Run it periodically from a small monitor.
- **Add `POST /api/admin/reconcile`.** Admin-only. Walks both JSON files, GETs Coolify's current domain list, returns a structured diff: `{missingInCoolify: [...], extraInCoolify: [...]}`. With a `?fix=true` query param, re-fires `attachFqdn` for each missing entry. Would have closed this incident in one click.
- **Label the token.** Rotate `COOLIFY_API_TOKEN` to a clearly-named long-lived token (`apps-bizapp-club-deployer`) so it doesn't get revoked by accident. Note the label and creation date in Coolify's Keys & Tokens.
- **Don't trust `ok: true` in this codebase.** Anywhere a handler swallows an error into a sub-field of an otherwise-success response, treat that as a code smell and fix it.
