# LedgerPulse — VPS Deployment Guide (Docker Compose + Caddy)

This guide deploys **LedgerPulse** (`web` + `worker` + `caddy` HTTPS reverse proxy) to an Ubuntu/Debian VPS.

---

## 1. Prerequisites

1. A Linux VPS (1 vCPU and 1–2 GB RAM is enough for a single-owner SQLite deployment).
2. A DNS `A` record pointing your domain (e.g. `ledgerpulse.yourdomain.com`) at the VPS public IP, with ports 80 and 443 open.
3. Docker with Docker Compose v2:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   ```

---

## 2. Clone and configure

```bash
git clone https://github.com/ruobin/ledgerpulse.git
cd ledgerpulse
cp .env.example .env
```

Generate the two secrets:
```bash
openssl rand -hex 32   # TOKEN_ENCRYPTION_KEY: encrypts Gmail refresh tokens at rest
openssl rand -base64 24   # APP_PASSWORD: sign-in password for the web app
```

Edit `.env` with your production values:
```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_RESEARCH_MODEL=gpt-4.1-mini

# Required in production
TOKEN_ENCRYPTION_KEY=<64-hex-chars-from-openssl>
APP_USERNAME=admin
APP_PASSWORD=<long-random-password>

# Google Cloud Console -> OAuth 2.0 Client (Web Application)
GMAIL_CLIENT_ID=...apps.googleusercontent.com
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=https://ledgerpulse.yourdomain.com/api/gmail/callback

APP_URL=https://ledgerpulse.yourdomain.com
APP_DOMAIN=ledgerpulse.yourdomain.com
DEFAULT_TIMEZONE=America/New_York
WORKER_POLL_INTERVAL_MS=60000
```

- Without `APP_PASSWORD` the production app answers every request with `503` (only `/api/health` stays open). If an upstream proxy such as Cloudflare Access or Tailscale already authenticates every request, set `APP_AUTH_DISABLED=true` instead.
- Keep `TOKEN_ENCRYPTION_KEY` stable and backed up: if it changes, stored Gmail tokens can no longer be decrypted and Gmail must be reconnected.
- The AI provider, the model for each task, and web search (including a Brave Search API key) can be set either here in `.env` or after deployment in the **Admin Console** (`/admin`). Values saved there take precedence, and both containers use them without a restart. API keys saved in the Admin Console are encrypted with `TOKEN_ENCRYPTION_KEY`, which is one more reason to keep that key stable. See the README sections *Admin Console*, *Choosing models*, *Web search providers* and *Using an API gateway*.

> **Google Cloud Console setup for the Gmail API**
> 1. Enable the **Gmail API** in your Google Cloud project.
> 2. Configure the OAuth consent screen and add the `https://www.googleapis.com/auth/gmail.readonly` scope.
> 3. Create an OAuth 2.0 Web client with the authorized redirect URI `https://ledgerpulse.yourdomain.com/api/gmail/callback`.
> 4. While the consent screen's publishing status is **Testing**, Google expires refresh tokens after 7 days, so the scheduled sync will start failing with an auth error until you reconnect. Reconnect from the Automation page when that happens, or move the app to **In production**.

---

## 3. Build and start

```bash
docker compose up -d --build
```

Compose reads `APP_DOMAIN` from `.env` and passes it to Caddy, which obtains and renews a Let's Encrypt certificate for it and proxies HTTPS to `web:3000`. The web container listens on `127.0.0.1:3000` only.

Verify:
```bash
docker compose ps                                  # web: healthy; worker and caddy: running
curl -I https://ledgerpulse.yourdomain.com/        # 401 + WWW-Authenticate: Basic
curl -u admin:<password> https://ledgerpulse.yourdomain.com/api/schedules
docker compose logs -f web worker
```

The worker has no HTTP endpoint, so its container has no health check. Its log prints a line for every scheduled run (`completed`, `failed`, `locked`, …) and stays quiet when nothing is due.

Then open the site, sign in, connect Gmail on **Automation**, and set the schedule. The cron expression is evaluated in the schedule's timezone; pick a time after your IBKR statement email usually arrives (default `0 18 * * 1-5` = 18:00 Monday–Friday).

---

## 4. Operations and maintenance

- **Run the deterministic evals inside the container** (all 15 checks should pass; the encryption check fails if `TOKEN_ENCRYPTION_KEY` is missing or malformed):
  ```bash
  docker compose exec web npm run eval
  ```
- **Back up the SQLite database (online, WAL-safe)**:
  ```bash
  docker compose exec web node -e "
    const db = new (require('better-sqlite3'))('/app/data/ledgerpulse.sqlite');
    db.backup('/app/data/backup.sqlite').then(() => console.log('Backup complete'));
  "
  docker compose cp web:/app/data/backup.sqlite ./ledgerpulse-backup.sqlite
  ```
  Store backups together with your `.env` (or at least `TOKEN_ENCRYPTION_KEY`); without the key, the Gmail tokens in a backup cannot be used.
- **Update and rebuild** (containers are recreated, so expect a short interruption):
  ```bash
  git pull origin main
  docker compose up -d --build
  ```
