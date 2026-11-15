# LedgerPulse — Low-Level Design (LLD)

This document details the database schema, state machines, Gmail OAuth2 & deduplication sequence, and two-stage evidence isolation contracts so engineers can understand and extend the codebase quickly.

---

## 1. Relational Data Model (`src/lib/db/store.ts`)

```mermaid
erDiagram
    users ||--o{ oauth_connections : owns
    users ||--o{ ingestion_jobs : triggers
    users ||--o{ snapshots : owns
    users ||--o{ briefing_runs : owns
    users ||--o| schedules : configures
    users ||--o{ audit_events : logs
    snapshots ||--o{ briefing_runs : feeds

    users {
        text user_id PK
        text email
        text display_name
        text timezone
        text created_at
    }
    oauth_connections {
        text user_id PK,FK
        text provider PK
        text email_address
        text encrypted_refresh_token
        text scope
        text last_sync_at
        text last_sync_status
    }
    ingestion_jobs {
        text job_id PK
        text user_id FK
        text source_type
        text source_message_id
        text attachment_sha256
        text filename
        text status
        text snapshot_id
    }
    snapshots {
        text snapshot_id PK
        text user_id FK
        text saved_at
        text kind
        text as_of
        integer user_confirmed
        integer instrument_count
        text payload_json
    }
    briefing_runs {
        text run_id PK
        text user_id FK
        text snapshot_id FK
        text created_at
        integer confirmed
        text model
        integer total_tokens
        real estimated_cost_usd
        integer excluded_news_count
        text markdown
    }
    schedules {
        text schedule_id PK
        text user_id FK
        integer enabled
        integer trading_days_only
        text timezone
        integer news_window_days
        integer max_instruments
        text gmail_query
    }
    run_leases {
        text job_key PK
        text owner_id
        text acquired_at
        text expires_at
    }
    delivery_outbox {
        text delivery_id PK
        text user_id
        text run_id
        text channel
        text destination
        text status
        integer attempts
    }
```

---

## 2. Gmail IBKR Auto-Sync & Deduplication Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Sched as Worker / User (/api/gmail/sync)
    participant Store as OperationalStore (SQLite)
    participant Crypto as AES-256-GCM (telemetry.ts)
    participant Gmail as Google Gmail API v1
    participant Ingest as Ingestion Graph (LangGraph)

    Sched->>Store: acquireLease("daily-ibkr:{userId}:{YYYY-MM-DD}")
    alt Lease held by another worker
        Store-->>Sched: false (exit cleanly)
    end
    Sched->>Store: getOAuthConnection(userId, "gmail")
    Store->>Crypto: decryptSecret(encrypted_refresh_token)
    Crypto-->>Sched: plaintext refresh_token
    Sched->>Gmail: users.messages.list(q="from:donotreply@interactivebrokers.com ...")
    Gmail-->>Sched: messageId
    Sched->>Gmail: users.messages.attachments.get(messageId, attachmentId)
    Gmail-->>Sched: PDF bytes
    Sched->>Sched: sha256 = SHA256(pdfBuffer)
    Sched->>Store: hasProcessedAttachment(userId, sha256)
    alt Already processed
        Store-->>Sched: { processed: true, snapshotId }
        Sched->>Store: logEvent("gmail_dedup_skipped")
    else New Daily Statement
        Sched->>Ingest: readDocument() -> extractStatement() -> validatedStatement()
        Ingest-->>Sched: Statement (activity != holdings enforced)
        Sched->>Store: saveSnapshot(confirmed=false, sourceType="gmail")
        Sched->>Store: recordIngestionJob(sha256, status="completed")
    end
    Sched->>Store: releaseLease(...)
```

---

## 3. Module-by-Module Reference

### `src/lib/agent/models.ts`
- **`InstrumentSchema` & `StatementSchema`**: Strict Zod schemas (`strict()`) compiled to OpenAI JSON Schema via `zodResponseFormat`.
- **`validatedStatement(statement, pageCount?)`**:
  - Forces `holding_quantity = null` and `as_of = null` whenever `statement.kind !== "holdings"`.
  - Rejects `source_page > pageCount`.
  - Deduplicates instruments by `(symbol || name, exchange, asset_type)` and nulls `holding_quantity` with a warning if duplicate rows disagree.

### `src/lib/agent/services.ts`
- **`readDocument(data, filename)`**: Checks 10 MB / 80-page limits, verifies `%PDF-` signature, extracts per-page text via `unpdf`, rejects scanned/empty pages (`< 10 chars`), tags pages `[PAGE N]`, and runs `redactPii()`.
- **`extractStatement(text)`**: Adaptive truncation recovery. Starts at `max_tokens: 5000`; on `LengthFinishReasonError`, retries at `16000`; if still truncated, calls `splitBatch()` on `\n` boundaries while re-injecting the active `[PAGE N]` marker and document header (`text.slice(0, 800)`).
- **`synthesizeResearch(result, startIso, endIso, language)`**:
  - **Stage 1 (`EvidenceSchema`)**: Extracts `NewsFact[]` with explicit `publication_date` and `source_ids`.
  - **Deterministic Gate (`eligibleNews()`)**: Rejects `publication_date === null`, dates outside `[startIso, endIso]` (UTC calendar-day granularity), and out-of-range `source_ids`.
  - **Stage 2 (`ScenariosSchema`)**: Invoked *only* if `accepted.length > 0`, receiving only `accepted_news`—never raw search text or rejected articles.

### `src/lib/agent/workflow.ts`
- **`buildIngestionGraph()`**: `START -> extract_instruments -> validate_extraction -> END`.
- **`buildBriefingGraph()`**: `START -> prepare_window -> (conditional: research_news | render_markdown) -> render_markdown -> save_report -> END`.

### `src/lib/telemetry.ts`
- **`redactPii(text)`**: Strips `Account Number/Holder`, `Address`, `Email`, `Phone`, `Tax ID/SSN`, `IBAN/SWIFT`, and inline email addresses.
- **`encryptSecret` / `decryptSecret`**: AES-256-GCM authenticated encryption using `TOKEN_ENCRYPTION_KEY` (32-byte hex).
