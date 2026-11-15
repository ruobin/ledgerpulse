# LedgerPulse

**Automated IBKR Statement Intelligence & Evidence-Gated Market Briefings** — built with **TypeScript, Next.js 15, React 19, LangChain/LangGraph, OpenAI Structured Outputs & Hosted Web Search, Gmail API, SQLite, and Docker**.

> Sister application to [portfolio-briefing-agent](https://github.com/ruobin/portfolio-briefing-agent), refactored from Python/Streamlit into a customer-facing TypeScript web app with automated Gmail IBKR Daily Activity Statement fetching, multi-tenant data isolation, and VPS Docker deployment.

---

## Key Capabilities

1. **Automated Gmail IBKR Sync (`src/lib/gmail/client.ts`)**:
   - Connects via read-only Google OAuth2 (`gmail.readonly`), storing refresh tokens encrypted with **AES-256-GCM** at rest.
   - Fetches your Interactive Brokers `Daily Activity Statement` PDF attachment on trading days (`src/worker/scheduler.ts`), deduplicates via **SHA-256** attachment hashing, and ingests positions automatically.
2. **Production Financial & Hallucination Guardrails (`src/lib/agent/`)**:
   - **Activity != Holdings Isolation**: Trade-only statements force `holding_quantity = null` so historical buys/sells never masquerade as open positions.
   - **Adaptive Truncation Recovery**: Escalates output token budgets (`5,000 -> 16,000`) and recursively splits oversized statements on line boundaries while preserving `[PAGE N]` provenance headers.
   - **Two-Stage Evidence Isolation**: Separates structured `Evidence` extraction from `Scenarios` synthesis using a deterministic UTC date-window and source-ID gate (`eligibleNews`), ensuring rejected undated news never leaks into trading ideas.
   - **Unverified Output Withholding**: Search responses lacking citation URL annotations are withheld from published reports and logged in `audit_events`.
3. **Customer-Facing Next.js Console (`src/app/`)**:
   - `/` Overview Dashboard, `/ingest` PDF Upload & Human Review Table, `/briefings` Report Generator & Markdown Reader, `/automation` Gmail OAuth2 & Trading-Day Schedule, and `/ops` Telemetry & Deterministic Eval Scorecard.
4. **Multi-Tenant Ready & Dockerized**:
   - `user_id`-scoped SQLite WAL operational store (`snapshots`, `briefing_runs`, `ingestion_jobs`, `oauth_connections`, `schedules`, `run_leases`, `delivery_outbox`, `audit_events`).
   - Production `Dockerfile`, `docker-compose.yml` (`web` + `worker` + `caddy` HTTPS), and healthcheck endpoint (`/api/health`).

---

## Quick Start (Local Development)

```bash
npm install
cp .env.example .env
# Add OPENAI_API_KEY (and optional GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET) to .env
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Verification & Offline Evals

```bash
npm run typecheck   # TypeScript strict check
npm test            # Vitest suite
npm run eval        # 15-check deterministic guardrail scorecard ($0 API cost)
```

---

## Documentation

- [High-Level Design (HLD) & Scaling Blueprint](docs/architecture-hld.md)
- [Low-Level Design (LLD) & Database Schema](docs/low-level-design.md)
- [VPS Deployment Guide (Docker Compose + Caddy)](docs/vps-deployment.md)
