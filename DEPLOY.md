# Deploy checklist — what's done and what's left

Last updated: 2026-04-19

## ✅ Done
- Hetzner VPS (178.156.240.200) with Coolify running at http://178.156.240.200:8000/
- Coolify API token generated + saved
- DNS `apps.bizapp.club` → `178.156.240.200` (Namecheap, propagated)
- Full dashboard code scaffolded in this folder (server.js, public/index.html, Dockerfile, etc.)
- Local git repo initialised with an initial commit

## ⏳ Remaining steps (in order)

### 1. Create an empty GitHub repo (~30 seconds, needs you)

The PAT you gave me is a **fine-grained** token. Fine-grained PATs can read + write existing repos but **can't create new ones** unless "Administration: write" is set at the account level — which is rare and dangerous to grant.

Fastest path: create the empty repo yourself.

- Open: https://github.com/new
- Owner: `moshbari`
- Name: `apps-bizapp-club`
- Description: `Coolify-native app deployer dashboard for *.apps.bizapp.club`
- Visibility: **Public** (so Coolify can clone without a deploy key)
- Leave "Add a README", "Add .gitignore", "Choose a license" **unchecked** (repo must be empty)
- Click **Create repository**

Then tell me "repo created" and I'll push the code.

### 2. Push code to the new repo (I do this)

Command I'll run:
```
git remote add origin https://<PAT>@github.com/moshbari/apps-bizapp-club.git
git push -u origin main
```

### 3. Create Coolify Application from GitHub (I do this if you loosen the API IP-lock, or we do it together in the UI — 2 minutes)

You currently have the Coolify API IP-restricted to your home IP, so my sandbox can't call it. Either:
- **Option A (fastest):** Open Coolify → Settings → API → remove the IP restriction (or set to `0.0.0.0/0`). I'll do the rest via API: create the Application, set env vars, deploy.
- **Option B (manual UI, ~2 min):** In Coolify, Applications → New → Public Repository → `https://github.com/moshbari/apps-bizapp-club` → branch `main` → Build Pack: `Dockerfile` → Domains: `https://apps.bizapp.club` → save. Paste env vars from `.env.example` (see README for values). Deploy.

### 4. Smoke test (I do this)
- Hit https://apps.bizapp.club → dashboard loads with valid TLS.
- Register → admin activates → log in.
- Deploy a "hello" React app to `hello.apps.bizapp.club`. Expect HTTPS + page render.

## Credentials / pointers
- Coolify dashboard + creds: stored in Apple Notes → "APIs" folder → "Hetzner coolify" note
- GitHub PAT + Coolify API token: stored only in my sandbox (never committed to the repo)
