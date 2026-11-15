# LedgerPulse — VPS Deployment Guide (Docker Compose + Caddy)

This guide explains how to deploy **LedgerPulse** (`web` + `worker` + `caddy` HTTPS reverse proxy) onto any Ubuntu/Debian VPS.

---

## 1. Prerequisites on Your VPS

1. A Linux VPS (1 vCPU / 1–2 GB RAM is sufficient for single-VPS SQLite deployment).
2. A DNS `A` record pointing your domain (e.g., `ledgerpulse.yourdomain.com`) to the VPS public IP.
3. Docker & Docker Compose v2 installed:
   ```bash
   curl -fsSL https://get.docker.com | sh
   sudo usermod -aG docker $USER
   ```

---

## 2. Clone & Configure Environment

```bash
git clone https://github.com/ruobin/ledgerpulse.git
cd ledgerpulse
cp .env.example .env
```

Generate a 32-byte AES-256-GCM encryption key for Gmail OAuth tokens:
```bash
openssl rand -hex 32
```

Edit `.env` with your production values:
```env
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
OPENAI_RESEARCH_MODEL=gpt-4.1-mini

# Google Cloud Console -> OAuth 2.0 Client (Web Application)
GMAIL_CLIENT_ID=...apps.googleusercontent.com
GMAIL_CLIENT_SECRET=...
GMAIL_REDIRECT_URI=https://ledgerpulse.yourdomain.com/api/gmail/callback

TOKEN_ENCRYPTION_KEY=<64-hex-chars-from-openssl>
APP_URL=https://ledgerpulse.yourdomain.com
APP_DOMAIN=ledgerpulse.yourdomain.com
DEFAULT_TIMEZONE=America/New_York
WORKER_POLL_INTERVAL_MS=60000
```

> **Google Cloud Console Setup for Gmail API:**
> 1. Enable the **Gmail API** in your Google Cloud project.
> 2. Configure the OAuth Consent Screen (External or Internal) and add `https://www.googleapis.com/auth/gmail.readonly` scope.
> 3. Create an OAuth 2.0 Web Client with Authorized Redirect URI `https://ledgerpulse.yourdomain.com/api/gmail/callback`.

---

## 3. Build & Start Production Containers

```bash
APP_DOMAIN=ledgerpulse.yourdomain.com docker compose up -d --build
```

Verify all three containers (`ledgerpulse-web`, `ledgerpulse-worker`, `ledgerpulse-caddy`) are healthy:
```bash
docker compose ps
docker compose logs -f web worker
```

Caddy automatically provisions and renews Let's Encrypt TLS certificates for `APP_DOMAIN` and proxies HTTPS traffic to `web:3000`.

---

## 4. Operations, Backups & Maintenance

- **Run Deterministic Evals Inside Container**:
  ```bash
  docker compose exec web npm run eval
  ```
- **Backup SQLite Database (Hot-Safe WAL Backup)**:
  ```bash
  docker compose exec web node -e "
    const db = new (require('better-sqlite3'))('/app/data/ledgerpulse.sqlite');
    db.backup('/app/data/backup.sqlite').then(() => console.log('Backup complete'));
  "
  ```
- **Update & Zero-Downtime Rebuild**:
  ```bash
  git pull origin main
  APP_DOMAIN=ledgerpulse.yourdomain.com docker compose up -d --build
  ```
