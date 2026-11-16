# LedgerPulse

**Automated IBKR statement intelligence and evidence-gated market briefings**, built with TypeScript, Next.js 15, React 19, LangGraph, structured outputs and web search from OpenAI (directly or through any OpenAI-compatible API gateway), the Gmail API, SQLite and Docker.

> Sister application to [portfolio-briefing-agent](https://github.com/ruobin/portfolio-briefing-agent), rebuilt from Python/Streamlit as a TypeScript web app with automated Gmail fetching of Interactive Brokers Daily Activity Statements, `user_id`-scoped storage, and a Docker/VPS deployment.

LedgerPulse turns a brokerage statement into a reviewed portfolio snapshot, then researches recent news for the holdings and writes a cited briefing. Every step is built to fail conservatively: quantities it cannot prove are left unknown, uncited search output is withheld, and undated news never reaches the trading-idea stage.

---

## Key capabilities

1. **Statement ingestion with human review** (`/ingest`, `src/lib/agent/`)
   - Reads searchable PDFs or text (max 10 MB, 80 pages, no OCR), tags every page as `[PAGE N]`, and redacts personal fields locally before any text is sent to the AI provider.
   - Extracts instruments with a strict Zod schema; if the model output is truncated it retries with a larger budget (5,000 → 16,000 tokens), then splits the text on line boundaries while keeping page markers.
   - Deterministic validation: activity-only statements never produce holding quantities, cited pages must exist, and duplicate rows are merged (two *different* explicit quantities are a conflict, so the quantity is dropped with a warning).
2. **Evidence-gated briefings** (`/briefings`, `src/lib/agent/workflow.ts`)
   - Researches up to 10 stocks/ETFs per run with your choice of web search: OpenAI's hosted search tool, a model's built-in search through a gateway, or the Brave Search API. Options, bonds and other assets are kept in the snapshot but marked out of scope.
   - Search output without citations is withheld. Cited output passes a two-stage pipeline: stage 1 extracts dated news facts with source ids; a deterministic TypeScript gate (`eligibleNews`) drops undated, out-of-window or unsourced facts; only the accepted facts reach stage 2, which writes the interpretation and at most two conditional ideas.
   - Token usage, estimated USD cost (each model and search provider at its own rate), latency and guardrail events are recorded per run.
3. **Gmail automation** (`/automation`, `src/lib/gmail/client.ts`, `src/worker/scheduler.ts`)
   - Read-only Gmail OAuth (`gmail.readonly`); the refresh token is stored AES-256-GCM encrypted, and the OAuth `state` is bound to an HttpOnly cookie to block login-CSRF.
   - A background worker runs each user's schedule on its cron expression in the user's timezone (default `0 18 * * 1-5`, 18:00 Monday–Friday), fetches the newest matching statement, deduplicates it by SHA-256, ingests it as an *unconfirmed* snapshot and generates a briefing.
4. **Operations** (`/ops`, `npm run eval`)
   - A 15-check offline evaluation suite exercises the guardrails at $0 API cost; the overview dashboard shows run metrics, spend and recent audit events.
5. **Admin Console** (`/admin`)
   - Edit the AI provider or gateway, the model for each task, and the web search provider (including a Brave API key) in the browser, then check them with **Test connection**. See [Admin Console](#admin-console).

---

## Quick start (local development)

```bash
npm install
cp .env.example .env
# Set OPENAI_API_KEY here, or configure the provider later in the Admin Console (/admin).
# Optionally set GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET.
npm run dev      # web app on http://localhost:3000
npm run worker   # optional: the scheduler, in a second terminal
```

Without Gmail credentials, **Automation → Run Simulated IBKR Sync** exercises the whole pipeline with a built-in fictional statement (saved with source `sample`; extraction still calls the configured model).

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

Settings are environment variables (see `.env.example`). The AI settings marked † can also be edited in the [Admin Console](#admin-console), whose saved values take precedence.

| Variable | Required | Purpose |
|---|---|---|
| `LLM_API_KEY` (or `OPENAI_API_KEY`) † | yes, unless the gateway needs none | Key for OpenAI or your gateway, sent as `Authorization: Bearer` |
| `LLM_BASE_URL` (or `OPENAI_BASE_URL`) † | no | OpenAI-compatible gateway URL; unset means OpenAI. See [Using an API gateway](#using-an-api-gateway) |
| `LLM_HEADERS` † | no | JSON object of extra request headers (gateway auth, attribution) |
| `LLM_MODEL` (or `OPENAI_MODEL`) † | no | Statement extraction model (default `gpt-4.1-mini`). See [Choosing models](#choosing-models) |
| `LLM_ANALYSIS_MODEL` † | no | Evidence and ideas model (default: the extraction model) |
| `LLM_RESEARCH_MODEL` (or `OPENAI_RESEARCH_MODEL`) † | no | Web research model (default `gpt-4.1-mini`; unused with Brave) |
| `WEB_SEARCH_PROVIDER` † | no | `openai` (default), `model` or `brave`. See [Web search providers](#web-search-providers) |
| `BRAVE_SEARCH_API_KEY` † | with Brave | Brave Search API subscription token |
| `BRAVE_SEARCH_ENDPOINT` † | no | `news` (default) or `web` |
| `BRAVE_SEARCH_COST_PER_1K` † | no | Your Brave price per 1,000 requests in USD, for cost estimates (default `0`) |
| `LLM_PRICING` † | no | JSON prices for models the built-in cost table doesn't know |
| `BRAVE_SEARCH_BASE_URL` | no | Advanced: send Brave requests through a proxy |
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

`LLM_*` names take precedence over their `OPENAI_*` aliases, so existing OpenAI-only setups keep working unchanged.

## Admin Console

Open **Admin** (`/admin`) to change the AI provider, the models and web search without editing `.env` or restarting anything:

- Saved values override `.env` and apply to the web app and the worker from their next model call. Each field shows whether its value comes from the Admin Console, `.env` or the default, and can be reset to `.env`/default.
- API keys and gateway headers are encrypted with `TOKEN_ENCRYPTION_KEY` (required in production) and are write-only: the page never shows them again.
- **Test connection** sends one tiny request per configured model, plus a one-result Brave query when Brave is selected. It uses the same parameters as real runs, so an incompatible model fails here instead of mid-briefing.
- Every change is recorded in the audit trail by setting name (never by value). Anyone who can sign in can edit these settings.

## Choosing models

LedgerPulse uses models for three different jobs, configured separately:

| Task | Setting | What the model does | Recommended |
|---|---|---|---|
| Statement extraction | `LLM_MODEL` | Reads up to ~120,000 characters of statement text and returns every position in a strict JSON schema | Precision first: a capable model with reliable strict JSON-schema output and a long context window. Mid-size models (the default `gpt-4.1-mini`) handle typical statements; use a larger one such as `gpt-4.1` for long multi-asset statements with many option legs. Avoid "nano"-class models, which drop rows and flip signs. |
| Analysis | `LLM_ANALYSIS_MODEL` | Turns search results into dated, sourced facts, then writes the interpretation and up to two conditional ideas | The strongest instruction-following model you can afford, with strict JSON-schema output. This is where reasoning quality shows. |
| Web research | `LLM_RESEARCH_MODEL` | Searches the web for each stock or ETF and writes cited notes | A fast, inexpensive model that supports your search provider: an OpenAI model with the hosted search tool (e.g. `gpt-4.1-mini`), or a search-enabled model such as an OpenRouter `:online` model or `gpt-4o-mini-search-preview`. Uncited output is withheld anyway. Not used with Brave Search. |

All structured calls send `temperature: 0` and `max_tokens`. OpenAI's reasoning models (o-series, GPT-5) reject those parameters on Chat Completions, so prefer non-reasoning chat models unless your gateway translates them. **Test connection** catches this before a briefing runs.

## Web search providers

| `WEB_SEARCH_PROVIDER` | How research searches | Use it when |
|---|---|---|
| `openai` (default) | OpenAI's Responses API with the hosted `web_search_preview` tool, at most 2 searches per instrument | You call OpenAI directly, or through a gateway that passes requests through to OpenAI (Cloudflare AI Gateway, Helicone, Portkey) |
| `model` | Chat Completions with `web_search_options`; citations come from OpenAI-style `url_citation` annotations | Your gateway's model searches on its own: OpenRouter `:online` models, OpenAI search models, LiteLLM. Check that it returns these annotations |
| `brave` | LedgerPulse queries the [Brave Search API](https://brave.com/search/api/) itself (`news` or `web` endpoint, limited to the briefing window), and the analysis model works only from those results | You want search that is independent of the model provider, or your model has no built-in search. Needs `BRAVE_SEARCH_API_KEY` |

With every provider, research without citations is withheld as *unverified*, so a missing search capability produces clearly marked gaps rather than uncited claims. With Brave, source URLs come from Brave's results rather than from a model, each instrument costs one Brave request (10 results), and the research model is skipped.

## Using an API gateway

Every model call goes through an OpenAI-compatible client (`src/lib/agent/llm.ts`), so LedgerPulse can call OpenAI directly or any gateway that speaks the OpenAI API, such as OpenRouter, a LiteLLM proxy, Cloudflare AI Gateway, Azure OpenAI's v1 endpoint, Helicone, Portkey, or an internal proxy.

The models must support **Chat Completions with JSON-schema structured outputs** (`response_format: json_schema`) for extraction and analysis, plus whichever [web search provider](#web-search-providers) you choose. If a gateway lacks the Responses API, the run says to switch `WEB_SEARCH_PROVIDER` to `model` or `brave`.

Examples for `.env` (or the same values in the Admin Console; wrap JSON values in single quotes in `.env`):

```env
# OpenRouter with its built-in web search
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=sk-or-...
LLM_MODEL=openai/gpt-4.1-mini
LLM_RESEARCH_MODEL=openai/gpt-4.1-mini:online
WEB_SEARCH_PROVIDER=model

# LiteLLM proxy plus Brave Search (model names are your LiteLLM aliases)
LLM_BASE_URL=http://litellm:4000/v1
LLM_API_KEY=sk-litellm-...
LLM_MODEL=extraction-model
LLM_ANALYSIS_MODEL=analysis-model
WEB_SEARCH_PROVIDER=brave
BRAVE_SEARCH_API_KEY=<brave-api-key>

# Cloudflare AI Gateway in front of OpenAI (requests pass through, so the default search works)
LLM_BASE_URL=https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/openai
LLM_API_KEY=sk-...
LLM_HEADERS='{"cf-aig-authorization":"Bearer <gateway-token>"}'
```

Notes:

- A query string on `LLM_BASE_URL` (for example `?api-version=...`) is sent with every request.
- All settings are validated before the first model call, and configuration errors never echo URLs or header values.
- Each report's footer records the search provider, the analysis model and the gateway host.
- Cost estimates use the built-in OpenAI prices, and gateway ids such as `openai/gpt-4.1-mini:online` price as the base model. For any other model, add its price, for example `LLM_PRICING='{"vendor/model":{"input":3,"output":15}}'` (USD per 1M tokens, with an optional `searchPer1k`). Otherwise it is estimated at `gpt-4.1-mini` rates.

## Security model

- **Sign-in.** `src/middleware.ts` puts every page and API route except `/api/health` behind HTTP Basic auth. Production refuses to serve without `APP_PASSWORD` unless `APP_AUTH_DISABLED=true` is set deliberately. Serve it only over HTTPS (the Docker setup puts Caddy in front).
- **Tenancy.** All data is scoped by `user_id`, but there are no per-user accounts yet: `resolveUserId()` falls back to `DEFAULT_USER_ID` and honours an `x-ledgerpulse-user` header intended for development and tests. Anyone who passes the sign-in can choose a tenant, so treat a deployment as single-owner until real authentication is wired into `src/lib/tenant.ts`.
- **Secrets.** Gmail refresh tokens, and API keys and headers saved in the Admin Console, are encrypted at rest with AES-256-GCM. Outside production a key is derived from `OPENAI_API_KEY` for convenience; production requires `TOKEN_ENCRYPTION_KEY`.
- **Data sent to the AI provider.** The configured provider (and the gateway, if one is set) receives statement text and research prompts. The web search provider (OpenAI, the gateway's model, or Brave) sees search queries made of the researched companies' names and tickers. Statement text is redacted locally first: labelled personal lines (`Account Number/ID/Holder/Name:`, `Address:`, `Email:`, `Phone:`, `Tax ID:`, `SSN:`, `IBAN:`, `SWIFT:` …), SSN/TIN patterns, email addresses and IBKR account ids (`U…`/`DU…`). Redaction is pattern-based, so personal details in other formats (for example a bare name line) can still pass; review what you upload. Raw PDFs are not stored.
- **Untrusted content.** Statement text, web pages and model output are treated as data in every prompt; citation URLs are normalized to plain `http(s)` links without credentials.

## Known limitations

- Each sync processes only the newest matching Gmail message (and its first PDF attachment); older unprocessed statements are not backfilled.
- "Trading days" means Monday–Friday in the schedule's timezone; exchange holidays are not modelled.
- The delivery outbox records requested deliveries, but no sender is implemented yet, and scheduled deliveries stay blocked until the snapshot is human-confirmed.
- Run cost covers research and analysis; the tokens spent extracting a statement are not yet included.
- `npm audit` reports advisories in production dependencies (via `@langchain/*`, `unpdf` → `canvas` → `tar`, `googleapis`, `openai`, `zod`, `next`). Clearing them requires major-version upgrades (LangChain 1.x, unpdf 1.x, zod 4, OpenAI SDK, Next 16), which should be done as a dedicated migration.

---

## Documentation

- [LangGraph study guide: ingestion and briefing graphs](docs/langgraph-guide.md)
- [High-level design and scaling path](docs/architecture-hld.md)
- [Low-level design: schema, sequences, module reference](docs/low-level-design.md)
- [VPS deployment guide (Docker Compose + Caddy)](docs/vps-deployment.md)
