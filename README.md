# LedgerPulse

**Automated IBKR statement intelligence and evidence-gated market briefings**, built with TypeScript, Next.js 15, React 19, LangGraph, OpenAI Structured Outputs and hosted web search, the Gmail API, SQLite and Docker.

> Sister application to [portfolio-briefing-agent](https://github.com/ruobin/portfolio-briefing-agent), rebuilt from Python/Streamlit as a TypeScript web app with automated Gmail fetching of Interactive Brokers Daily Activity Statements, `user_id`-scoped storage, and a Docker/VPS deployment.

LedgerPulse turns a brokerage statement into a reviewed portfolio snapshot, then researches recent news for the holdings and writes a cited briefing. Every step is built to fail conservatively: quantities it cannot prove are left unknown, uncited search output is withheld, and undated news never reaches the trading-idea stage.

---

## Key capabilities

1. **Statement ingestion with human review** (`/ingest`, `src/lib/agent/`)
   - Reads searchable PDFs or text (max 10 MB, 80 pages, no OCR), tags every page as `[PAGE N]`, and redacts personal fields locally before any text is sent to OpenAI.
   - Extracts instruments with a strict Zod schema; if the model output is truncated it retries with a larger budget (5,000 → 16,000 tokens), then splits the text on line boundaries while keeping page markers.
   - Deterministic validation: activity-only statements never produce holding quantities, cited pages must exist, and duplicate rows are merged (two *different* explicit quantities are a conflict, so the quantity is dropped with a warning).
2. **Evidence-gated briefings** (`/briefings`, `src/lib/agent/workflow.ts`)
   - Researches up to 10 stocks/ETFs per run with OpenAI hosted web search (`max_tool_calls: 2`, `store: false`); options, bonds and other assets are kept in the snapshot but marked out of scope.
   - Search output without citation annotations is withheld. Cited output passes a two-stage pipeline: stage 1 extracts dated news facts with source ids; a deterministic TypeScript gate (`eligibleNews`) drops undated, out-of-window or unsourced facts; only the accepted facts reach stage 2, which writes the interpretation and at most two conditional ideas.
   - Token usage, estimated USD cost, latency and guardrail events are recorded per run.
3. **Gmail automation** (`/automation`, `src/lib/gmail/client.ts`, `src/worker/scheduler.ts`)
   - Read-only Gmail OAuth (`gmail.readonly`); the refresh token is stored AES-256-GCM encrypted, and the OAuth `state` is bound to an HttpOnly cookie to block login-CSRF.
   - A background worker runs each user's schedule on its cron expression in the user's timezone (default `0 18 * * 1-5`, 18:00 Monday–Friday), fetches the newest matching statement, deduplicates it by SHA-256, ingests it as an *unconfirmed* snapshot and generates a briefing.
4. **Operations** (`/ops`, `npm run eval`)
   - A 15-check offline evaluation suite exercises the guardrails at $0 API cost; the overview dashboard shows run metrics, spend and recent audit events.

---

## Quick start (local development)

```bash
npm install
cp .env.example .env
# Set OPENAI_API_KEY (and optionally GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) in .env
npm run dev      # web app on http://localhost:3000
npm run worker   # optional: the scheduler, in a second terminal
```

Without Gmail credentials, **Automation → Run Simulated IBKR Sync** exercises the whole pipeline with a built-in fictional statement (saved with source `sample`; extraction still calls OpenAI).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development server, production build, production server |
| `npm run worker` | Scheduler loop (`src/worker/scheduler.ts`) |
| `npm test` | Vitest suite (offline; model calls are injected fakes) |
| `npm run typecheck` | `tsc --noEmit` in strict mode |
| `npm run lint` | ESLint (`next/core-web-vitals` + `next/typescript`) |
| `npm run eval` | 15-check guardrail scorecard; exits non-zero on any failure |
| `npm run metrics` | Print the default user's operational metrics as JSON |

## Configuration

All settings are environment variables (see `.env.example`).

| Variable | Required | Purpose |
|---|---|---|
| `OPENAI_API_KEY` | yes | Extraction, research and synthesis |
| `OPENAI_MODEL`, `OPENAI_RESEARCH_MODEL` | no | Model ids (default `gpt-4.1-mini`) |
| `APP_PASSWORD` | **production** | Password for the built-in HTTP Basic sign-in. Without it a production server answers `503` |
| `APP_USERNAME` | no | Sign-in username (default `admin`) |
| `APP_AUTH_DISABLED` | no | `true` only when an upstream proxy (Cloudflare Access, Tailscale, …) already authenticates every request |
| `TOKEN_ENCRYPTION_KEY` | **production** | 64 hex chars (`openssl rand -hex 32`) encrypting Gmail refresh tokens. Changing it means reconnecting Gmail |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REDIRECT_URI` | for Gmail | Google OAuth web client |
| `IBKR_GMAIL_QUERY` | no | Default Gmail search for new users' schedules |
| `DATA_DIR` | no | SQLite location (default `./data`) |
| `DEFAULT_USER_ID`, `DEFAULT_TIMEZONE` | no | Default tenant and schedule timezone |
| `WORKER_POLL_INTERVAL_MS` | no | How often the worker checks schedules (default 60000, minimum 5000) |
| `APP_DOMAIN` | for Docker | Hostname Caddy serves and provisions TLS for |

## Security model

- **Sign-in.** `src/middleware.ts` puts every page and API route except `/api/health` behind HTTP Basic auth. Production refuses to serve without `APP_PASSWORD` unless `APP_AUTH_DISABLED=true` is set deliberately. Serve it only over HTTPS (the Docker setup puts Caddy in front).
- **Tenancy.** All data is scoped by `user_id`, but there are no per-user accounts yet: `resolveUserId()` falls back to `DEFAULT_USER_ID` and honours an `x-ledgerpulse-user` header intended for development and tests. Anyone who passes the sign-in can choose a tenant, so treat a deployment as single-owner until real authentication is wired into `src/lib/tenant.ts`.
- **Secrets.** Gmail refresh tokens are encrypted at rest with AES-256-GCM. Outside production a key is derived from `OPENAI_API_KEY` for convenience; production requires `TOKEN_ENCRYPTION_KEY`.
- **Data sent to OpenAI.** Statement text is redacted locally first: labelled personal lines (`Account Number/ID/Holder/Name:`, `Address:`, `Email:`, `Phone:`, `Tax ID:`, `SSN:`, `IBAN:`, `SWIFT:` …), SSN/TIN patterns, email addresses and IBKR account ids (`U…`/`DU…`). Redaction is pattern-based, so personal details in other formats (for example a bare name line) can still pass; review what you upload. Raw PDFs are not stored.
- **Untrusted content.** Statement text, web pages and model output are treated as data in every prompt; citation URLs are normalized to plain `http(s)` links without credentials.

## Known limitations

- Each sync processes only the newest matching Gmail message (and its first PDF attachment); older unprocessed statements are not backfilled.
- "Trading days" means Monday–Friday in the schedule's timezone; exchange holidays are not modelled.
- The delivery outbox records requested deliveries, but no sender is implemented yet, and scheduled deliveries stay blocked until the snapshot is human-confirmed.
- `npm audit` reports advisories in production dependencies (via `@langchain/*`, `unpdf` → `canvas` → `tar`, `googleapis`, `openai`, `zod`, `next`). Clearing them requires major-version upgrades (LangChain 1.x, unpdf 1.x, zod 4, OpenAI SDK, Next 16), which should be done as a dedicated migration.

---

## Documentation

- [LangGraph study guide: ingestion and briefing graphs](docs/langgraph-guide.md)
- [High-level design and scaling path](docs/architecture-hld.md)
- [Low-level design: schema, sequences, module reference](docs/low-level-design.md)
- [VPS deployment guide (Docker Compose + Caddy)](docs/vps-deployment.md)
