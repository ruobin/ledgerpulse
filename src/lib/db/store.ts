import Database from "better-sqlite3";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import type { Statement } from "../agent/models";
import { computeRunTelemetry, decryptSecret, encryptSecret, type RunTelemetry } from "../telemetry";

export interface UserRecord {
  user_id: string;
  email: string;
  display_name: string;
  timezone: string;
  created_at: string;
}

export interface ScheduleRecord {
  schedule_id: string;
  user_id: string;
  enabled: number;
  cron_expression: string;
  trading_days_only: number;
  timezone: string;
  news_window_days: number;
  max_instruments: number;
  language: "English" | "Chinese";
  gmail_query: string;
  delivery_channel: string;
  delivery_destination: string;
  last_run_at: string | null;
  updated_at: string;
}

export interface OAuthConnectionRecord {
  user_id: string;
  provider: string;
  email_address: string;
  encrypted_refresh_token: string;
  scope: string;
  connected_at: string;
  last_sync_at: string | null;
  last_sync_status: string | null;
}

export class OperationalStore {
  public readonly dbPath: string;
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = path.resolve(dataDir || process.env.DATA_DIR || path.join(process.cwd(), "data"));
    fs.mkdirSync(this.dataDir, { recursive: true });
    this.dbPath = path.join(this.dataDir, "ledgerpulse.sqlite");
    this.initSchema();
  }

  private connect(): Database.Database {
    const db = new Database(this.dbPath, { timeout: 10000 });
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    return db;
  }

  private initSchema(): void {
    const db = this.connect();
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          user_id TEXT PRIMARY KEY,
          email TEXT NOT NULL,
          display_name TEXT NOT NULL,
          timezone TEXT NOT NULL DEFAULT 'America/New_York',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS oauth_connections (
          user_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          email_address TEXT NOT NULL,
          encrypted_refresh_token TEXT NOT NULL,
          scope TEXT NOT NULL,
          connected_at TEXT NOT NULL,
          last_sync_at TEXT,
          last_sync_status TEXT,
          PRIMARY KEY (user_id, provider),
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS ingestion_jobs (
          job_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_message_id TEXT,
          attachment_sha256 TEXT NOT NULL,
          filename TEXT NOT NULL,
          status TEXT NOT NULL,
          snapshot_id TEXT,
          error_message TEXT,
          created_at TEXT NOT NULL,
          UNIQUE(user_id, attachment_sha256),
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS snapshots (
          snapshot_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          saved_at TEXT NOT NULL,
          kind TEXT NOT NULL,
          as_of TEXT,
          period TEXT,
          user_confirmed INTEGER NOT NULL,
          instrument_count INTEGER NOT NULL,
          stock_etf_count INTEGER NOT NULL,
          option_other_count INTEGER NOT NULL,
          warning_count INTEGER NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'upload',
          payload_json TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS briefing_runs (
          run_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          snapshot_id TEXT,
          created_at TEXT NOT NULL,
          confirmed INTEGER NOT NULL,
          window_start TEXT NOT NULL,
          window_end TEXT NOT NULL,
          language TEXT NOT NULL DEFAULT 'English',
          model TEXT NOT NULL,
          max_instruments INTEGER NOT NULL,
          instrument_count INTEGER NOT NULL,
          cited_count INTEGER NOT NULL,
          unverified_count INTEGER NOT NULL,
          failed_count INTEGER NOT NULL,
          unsupported_count INTEGER NOT NULL,
          total_search_calls INTEGER NOT NULL,
          total_input_tokens INTEGER NOT NULL,
          total_output_tokens INTEGER NOT NULL,
          total_tokens INTEGER NOT NULL,
          estimated_cost_usd REAL NOT NULL,
          excluded_news_count INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          markdown TEXT NOT NULL,
          metadata_json TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS audit_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_key TEXT UNIQUE,
          user_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          run_id TEXT,
          event_type TEXT NOT NULL,
          severity TEXT NOT NULL,
          message TEXT NOT NULL,
          details_json TEXT
        );

        CREATE TABLE IF NOT EXISTS delivery_outbox (
          delivery_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          run_id TEXT NOT NULL,
          channel TEXT NOT NULL,
          destination TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(run_id, channel, destination)
        );

        CREATE TABLE IF NOT EXISTS run_leases (
          job_key TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schedules (
          schedule_id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          cron_expression TEXT NOT NULL DEFAULT '0 18 * * 1-5',
          trading_days_only INTEGER NOT NULL DEFAULT 1,
          timezone TEXT NOT NULL DEFAULT 'America/New_York',
          news_window_days INTEGER NOT NULL DEFAULT 1,
          max_instruments INTEGER NOT NULL DEFAULT 5,
          language TEXT NOT NULL DEFAULT 'English',
          gmail_query TEXT NOT NULL,
          delivery_channel TEXT NOT NULL DEFAULT 'dashboard',
          delivery_destination TEXT NOT NULL DEFAULT '',
          last_run_at TEXT,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
        );
      `);
    } finally {
      db.close();
    }
  }

  public ensureUser(userId = process.env.DEFAULT_USER_ID || "usr_demo_owner"): UserRecord {
    const db = this.connect();
    try {
      const existing = db.prepare("SELECT * FROM users WHERE user_id = ?").get(userId) as
        | UserRecord
        | undefined;
      if (existing) return existing;

      const now = new Date().toISOString();
      const tz = process.env.DEFAULT_TIMEZONE || "America/New_York";
      const record: UserRecord = {
        user_id: userId,
        email: "investor@ledgerpulse.local",
        display_name: "Primary Portfolio",
        timezone: tz,
        created_at: now,
      };
      db.prepare(
        "INSERT INTO users (user_id, email, display_name, timezone, created_at) VALUES (?, ?, ?, ?, ?)"
      ).run(record.user_id, record.email, record.display_name, record.timezone, record.created_at);

      const defaultQuery =
        process.env.IBKR_GMAIL_QUERY ||
        'from:donotreply@interactivebrokers.com subject:"Daily Activity Statement" has:attachment filename:pdf';
      db.prepare(
        `INSERT OR IGNORE INTO schedules (
          schedule_id, user_id, enabled, cron_expression, trading_days_only,
          timezone, news_window_days, max_instruments, language, gmail_query,
          delivery_channel, delivery_destination, updated_at
        ) VALUES (?, ?, 1, '0 18 * * 1-5', 1, ?, 1, 5, 'English', ?, 'dashboard', '', ?)`
      ).run(`sch_${crypto.randomBytes(4).toString("hex")}`, userId, tz, defaultQuery, now);

      return record;
    } finally {
      db.close();
    }
  }

  public logEvent(params: {
    userId: string;
    eventType: string;
    message: string;
    severity?: "info" | "warning" | "error";
    runId?: string | null;
    details?: Record<string, unknown>;
    createdAt?: string;
    eventKey?: string;
  }): void {
    this.ensureUser(params.userId);
    const db = this.connect();
    try {
      db.prepare(
        `INSERT OR IGNORE INTO audit_events (event_key, user_id, created_at, run_id, event_type, severity, message, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        params.eventKey ?? null,
        params.userId,
        params.createdAt ?? new Date().toISOString(),
        params.runId ?? null,
        params.eventType,
        params.severity ?? "info",
        params.message,
        JSON.stringify(params.details ?? {})
      );
    } finally {
      db.close();
    }
  }

  public saveOAuthConnection(params: {
    userId: string;
    provider: "gmail";
    emailAddress: string;
    refreshToken: string;
    scope: string;
  }): void {
    this.ensureUser(params.userId);
    const encrypted = encryptSecret(params.refreshToken);
    const now = new Date().toISOString();
    const db = this.connect();
    try {
      db.prepare(
        `INSERT INTO oauth_connections (user_id, provider, email_address, encrypted_refresh_token, scope, connected_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, provider) DO UPDATE SET
           email_address = excluded.email_address,
           encrypted_refresh_token = excluded.encrypted_refresh_token,
           scope = excluded.scope,
           connected_at = excluded.connected_at`
      ).run(params.userId, params.provider, params.emailAddress, encrypted, params.scope, now);
    } finally {
      db.close();
    }
    this.logEvent({
      userId: params.userId,
      eventType: "gmail_oauth_connected",
      message: `Connected Gmail account ${params.emailAddress} with encrypted refresh token at rest.`,
      severity: "info",
      details: { scope: params.scope },
    });
  }

  public getOAuthConnection(
    userId: string,
    provider: "gmail" = "gmail"
  ): (OAuthConnectionRecord & { refresh_token: string }) | null {
    const db = this.connect();
    try {
      const row = db
        .prepare("SELECT * FROM oauth_connections WHERE user_id = ? AND provider = ?")
        .get(userId, provider) as OAuthConnectionRecord | undefined;
      if (!row) return null;
      return {
        ...row,
        refresh_token: decryptSecret(row.encrypted_refresh_token),
      };
    } finally {
      db.close();
    }
  }

  /** Existence check that does not decrypt the stored token. */
  public hasOAuthConnection(userId: string, provider: "gmail" = "gmail"): boolean {
    const db = this.connect();
    try {
      return Boolean(
        db.prepare("SELECT 1 FROM oauth_connections WHERE user_id = ? AND provider = ?").get(userId, provider)
      );
    } finally {
      db.close();
    }
  }

  public updateOAuthSyncStatus(userId: string, status: string): void {
    const db = this.connect();
    try {
      db.prepare(
        "UPDATE oauth_connections SET last_sync_at = ?, last_sync_status = ? WHERE user_id = ? AND provider = 'gmail'"
      ).run(new Date().toISOString(), status, userId);
    } finally {
      db.close();
    }
  }

  public hasProcessedAttachment(userId: string, sha256: string): { processed: boolean; snapshotId?: string } {
    const db = this.connect();
    try {
      const row = db
        .prepare("SELECT snapshot_id, status FROM ingestion_jobs WHERE user_id = ? AND attachment_sha256 = ?")
        .get(userId, sha256) as { snapshot_id: string | null; status: string } | undefined;
      if (row && row.status === "completed" && row.snapshot_id) {
        return { processed: true, snapshotId: row.snapshot_id };
      }
      return { processed: false };
    } finally {
      db.close();
    }
  }

  public recordIngestionJob(params: {
    userId: string;
    sourceType: "gmail" | "upload" | "paste" | "sample";
    sourceMessageId?: string;
    attachmentSha256: string;
    filename: string;
    status: "completed" | "failed" | "skipped_duplicate";
    snapshotId?: string;
    errorMessage?: string;
  }): string {
    this.ensureUser(params.userId);
    const jobId = `job_${crypto.randomBytes(6).toString("hex")}`;
    const now = new Date().toISOString();
    const db = this.connect();
    try {
      // A completed job is never demoted: a later failed or skipped attempt for the same
      // attachment must not make hasProcessedAttachment() report it as unprocessed again.
      db.prepare(
        `INSERT INTO ingestion_jobs (
          job_id, user_id, source_type, source_message_id, attachment_sha256,
          filename, status, snapshot_id, error_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, attachment_sha256) DO UPDATE SET
          status = excluded.status,
          snapshot_id = COALESCE(excluded.snapshot_id, ingestion_jobs.snapshot_id),
          error_message = excluded.error_message
        WHERE ingestion_jobs.status <> 'completed'`
      ).run(
        jobId,
        params.userId,
        params.sourceType,
        params.sourceMessageId ?? null,
        params.attachmentSha256,
        params.filename,
        params.status,
        params.snapshotId ?? null,
        params.errorMessage ?? null,
        now
      );
      return jobId;
    } finally {
      db.close();
    }
  }

  public saveSnapshot(params: {
    userId: string;
    statement: Statement;
    confirmed: boolean;
    sourceType?: "gmail" | "upload" | "paste" | "sample";
    snapshotId?: string;
  }): { snapshot_id: string; saved_at: string } {
    this.ensureUser(params.userId);
    const snapshotId =
      params.snapshotId ||
      `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${crypto.randomBytes(4).toString("hex")}`;
    const savedAt = new Date().toISOString();
    const stockEtf = params.statement.instruments.filter(
      (i) => i.asset_type === "stock" || i.asset_type === "etf"
    ).length;
    const other = params.statement.instruments.length - stockEtf;
    const payload = {
      schema_version: 2,
      snapshot_id: snapshotId,
      user_id: params.userId,
      saved_at: savedAt,
      user_confirmed: params.confirmed,
      statement: params.statement,
    };

    const db = this.connect();
    try {
      db.prepare(
        `INSERT OR REPLACE INTO snapshots (
          snapshot_id, user_id, saved_at, kind, as_of, period, user_confirmed,
          instrument_count, stock_etf_count, option_other_count, warning_count,
          source_type, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        snapshotId,
        params.userId,
        savedAt,
        params.statement.kind,
        params.statement.as_of,
        params.statement.period,
        params.confirmed ? 1 : 0,
        params.statement.instruments.length,
        stockEtf,
        other,
        params.statement.warnings.length,
        params.sourceType ?? "upload",
        JSON.stringify(payload)
      );
    } finally {
      db.close();
    }

    if (params.statement.kind !== "holdings") {
      this.logEvent({
        userId: params.userId,
        eventType: "activity_watchlist_enforced",
        message: `Snapshot ${snapshotId} classified as '${params.statement.kind}'; holding quantities nulled.`,
        severity: "warning",
        createdAt: savedAt,
        eventKey: `snap-activity-${snapshotId}`,
        details: { snapshot_id: snapshotId, instrument_count: params.statement.instruments.length },
      });
    }

    return { snapshot_id: snapshotId, saved_at: savedAt };
  }

  public getSnapshot(userId: string, snapshotId: string): { statement: Statement; confirmed: boolean; saved_at: string } | null {
    const db = this.connect();
    try {
      const row = db
        .prepare("SELECT payload_json, user_confirmed, saved_at FROM snapshots WHERE user_id = ? AND snapshot_id = ?")
        .get(userId, snapshotId) as { payload_json: string; user_confirmed: number; saved_at: string } | undefined;
      if (!row) return null;
      const parsed = JSON.parse(row.payload_json) as { statement: Statement };
      return {
        statement: parsed.statement,
        confirmed: Boolean(row.user_confirmed),
        saved_at: row.saved_at,
      };
    } finally {
      db.close();
    }
  }

  public listSnapshots(userId: string, limit = 20): Array<{
    snapshot_id: string;
    saved_at: string;
    kind: string;
    as_of: string | null;
    period: string;
    user_confirmed: boolean;
    instrument_count: number;
    stock_etf_count: number;
    option_other_count: number;
    source_type: string;
  }> {
    this.ensureUser(userId);
    const db = this.connect();
    try {
      const rows = db
        .prepare(
          `SELECT snapshot_id, saved_at, kind, as_of, period, user_confirmed,
                  instrument_count, stock_etf_count, option_other_count, source_type
           FROM snapshots WHERE user_id = ? ORDER BY saved_at DESC LIMIT ?`
        )
        .all(userId, limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({
        snapshot_id: String(r.snapshot_id),
        saved_at: String(r.saved_at),
        kind: String(r.kind),
        as_of: r.as_of ? String(r.as_of) : null,
        period: String(r.period ?? ""),
        user_confirmed: Boolean(r.user_confirmed),
        instrument_count: Number(r.instrument_count),
        stock_etf_count: Number(r.stock_etf_count),
        option_other_count: Number(r.option_other_count),
        source_type: String(r.source_type ?? "upload"),
      }));
    } finally {
      db.close();
    }
  }

  public recordRun(params: {
    userId: string;
    snapshotId?: string | null;
    confirmed: boolean;
    windowStart: string;
    windowEnd: string;
    language: string;
    model: string;
    maxInstruments: number;
    markdown: string;
    research: Array<Record<string, unknown>>;
    latencyMs?: number;
    runId?: string;
  }): { run_id: string; telemetry: RunTelemetry } {
    this.ensureUser(params.userId);
    const runId =
      params.runId ||
      `${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z-${crypto.randomBytes(4).toString("hex")}`;
    const telemetry = computeRunTelemetry(params.research, params.model, params.latencyMs ?? 0);
    const createdAt = params.windowEnd || new Date().toISOString();

    const db = this.connect();
    try {
      db.prepare(
        `INSERT OR REPLACE INTO briefing_runs (
          run_id, user_id, snapshot_id, created_at, confirmed, window_start, window_end,
          language, model, max_instruments, instrument_count, cited_count, unverified_count,
          failed_count, unsupported_count, total_search_calls, total_input_tokens,
          total_output_tokens, total_tokens, estimated_cost_usd, excluded_news_count,
          latency_ms, markdown, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runId,
        params.userId,
        params.snapshotId ?? null,
        createdAt,
        params.confirmed ? 1 : 0,
        params.windowStart,
        params.windowEnd,
        params.language,
        params.model,
        params.maxInstruments,
        telemetry.instrument_count,
        telemetry.cited_count,
        telemetry.unverified_count,
        telemetry.failed_count,
        telemetry.unsupported_count,
        telemetry.total_search_calls,
        telemetry.total_input_tokens,
        telemetry.total_output_tokens,
        telemetry.total_tokens,
        telemetry.estimated_cost_usd,
        telemetry.excluded_news_count,
        telemetry.latency_ms,
        params.markdown,
        JSON.stringify({
          snapshot_id: params.snapshotId,
          confirmed: params.confirmed,
          window_start: params.windowStart,
          window_end: params.windowEnd,
          language: params.language,
          model: params.model,
          max_instruments: params.maxInstruments,
          telemetry,
          research: params.research,
        })
      );
    } finally {
      db.close();
    }

    if (telemetry.excluded_news_count > 0) {
      this.logEvent({
        userId: params.userId,
        eventType: "dated_evidence_filtered",
        message: `Excluded ${telemetry.excluded_news_count} undated/out-of-window news item(s) before scenario synthesis.`,
        severity: "info",
        runId,
        createdAt,
        eventKey: `run-excluded-${runId}`,
        details: { excluded_news_count: telemetry.excluded_news_count },
      });
    }
    if (telemetry.unverified_count > 0) {
      const symbols = params.research.filter((r) => r.status === "unverified").map((r) => String(r.instrument));
      this.logEvent({
        userId: params.userId,
        eventType: "unverified_withheld",
        message: `Withheld ${telemetry.unverified_count} unverified search output(s) lacking citations (${symbols.join(", ")}).`,
        severity: "warning",
        runId,
        createdAt,
        eventKey: `run-unverified-${runId}`,
        details: { instruments: symbols },
      });
    }
    if (telemetry.failed_count > 0) {
      const symbols = params.research.filter((r) => r.status === "failed").map((r) => String(r.instrument));
      this.logEvent({
        userId: params.userId,
        eventType: "research_failure_isolated",
        message: `Isolated ${telemetry.failed_count} failed research call(s) (${symbols.join(", ")}); briefing preserved.`,
        severity: "error",
        runId,
        createdAt,
        eventKey: `run-failed-${runId}`,
        details: { instruments: symbols },
      });
    }

    return { run_id: runId, telemetry };
  }

  public getRun(userId: string, runId: string): Record<string, unknown> | null {
    const db = this.connect();
    try {
      const row = db
        .prepare("SELECT * FROM briefing_runs WHERE user_id = ? AND run_id = ?")
        .get(userId, runId) as Record<string, unknown> | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  }

  public listRuns(userId: string, limit = 20): Array<Record<string, unknown>> {
    this.ensureUser(userId);
    const db = this.connect();
    try {
      return db
        .prepare(
          `SELECT run_id, snapshot_id, created_at, confirmed, language, model, max_instruments,
                  instrument_count, cited_count, unverified_count, failed_count, unsupported_count,
                  total_search_calls, total_tokens, estimated_cost_usd, excluded_news_count, latency_ms
           FROM briefing_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(userId, limit) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  }

  public enqueueDelivery(params: {
    userId: string;
    runId: string;
    channel: string;
    destination: string;
    confirmed: boolean;
    requireConfirmation?: boolean;
  }): Record<string, unknown> {
    const requireConfirmation = params.requireConfirmation ?? true;
    const status = params.confirmed || !requireConfirmation ? "pending" : "blocked_unconfirmed";
    const lastError = status === "pending" ? null : "Human confirmation required before external delivery.";
    const now = new Date().toISOString();
    const deliveryId = `dlv-${crypto.randomBytes(5).toString("hex")}`;

    const db = this.connect();
    try {
      db.prepare(
        `INSERT INTO delivery_outbox (delivery_id, user_id, run_id, channel, destination, status, attempts, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(run_id, channel, destination) DO UPDATE SET
           status = CASE WHEN delivery_outbox.status = 'sent' THEN 'sent' ELSE excluded.status END,
           last_error = CASE WHEN delivery_outbox.status = 'sent' THEN delivery_outbox.last_error ELSE excluded.last_error END,
           updated_at = excluded.updated_at`
      ).run(deliveryId, params.userId, params.runId, params.channel, params.destination, status, lastError, now, now);

      const row = db
        .prepare("SELECT * FROM delivery_outbox WHERE run_id = ? AND channel = ? AND destination = ?")
        .get(params.runId, params.channel, params.destination) as Record<string, unknown>;

      if (status === "blocked_unconfirmed") {
        this.logEvent({
          userId: params.userId,
          eventType: "delivery_blocked_unconfirmed",
          message: `Blocked ${params.channel} delivery for run ${params.runId}: snapshot not user-confirmed.`,
          severity: "warning",
          runId: params.runId,
          details: { channel: params.channel, destination: params.destination },
        });
      }
      return row;
    } finally {
      db.close();
    }
  }

  public processOutbox(sender?: (item: Record<string, unknown>) => void): Array<Record<string, unknown>> {
    const db = this.connect();
    const processed: Array<Record<string, unknown>> = [];
    try {
      const rows = db
        .prepare("SELECT * FROM delivery_outbox WHERE status = 'pending' ORDER BY created_at")
        .all() as Array<Record<string, unknown>>;

      for (const item of rows) {
        const now = new Date().toISOString();
        const attempts = Number(item.attempts ?? 0) + 1;
        try {
          if (sender) sender(item);
          db.prepare(
            "UPDATE delivery_outbox SET status = 'sent', attempts = ?, last_error = NULL, updated_at = ? WHERE delivery_id = ?"
          ).run(attempts, now, item.delivery_id);
          processed.push({ ...item, status: "sent", attempts, last_error: null, updated_at: now });
        } catch (err) {
          const msg = err instanceof Error ? err.message.slice(0, 200) : "Delivery error";
          db.prepare(
            "UPDATE delivery_outbox SET status = 'failed', attempts = ?, last_error = ?, updated_at = ? WHERE delivery_id = ?"
          ).run(attempts, msg, now, item.delivery_id);
          processed.push({ ...item, status: "failed", attempts, last_error: msg, updated_at: now });
        }
      }
      return processed;
    } finally {
      db.close();
    }
  }

  /**
   * Acquire (or renew, for the same owner) a lease. The check and the write are a single
   * UPSERT so two processes can never both observe a free lease and both take it.
   * Owners must be unique per attempt; the same owner id is treated as a renewal.
   */
  public acquireLease(jobKey: string, ownerId: string, ttlSeconds = 300): boolean {
    const now = new Date();
    const nowIso = now.toISOString();
    const expIso = new Date(now.getTime() + ttlSeconds * 1000).toISOString();

    const db = this.connect();
    try {
      const result = db
        .prepare(
          `INSERT INTO run_leases (job_key, owner_id, acquired_at, expires_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(job_key) DO UPDATE SET
             owner_id = excluded.owner_id,
             acquired_at = excluded.acquired_at,
             expires_at = excluded.expires_at
           WHERE run_leases.expires_at <= excluded.acquired_at
              OR run_leases.owner_id = excluded.owner_id`
        )
        .run(jobKey, ownerId, nowIso, expIso);
      return result.changes > 0;
    } finally {
      db.close();
    }
  }

  public releaseLease(jobKey: string, ownerId: string): void {
    const db = this.connect();
    try {
      db.prepare("DELETE FROM run_leases WHERE job_key = ? AND owner_id = ?").run(jobKey, ownerId);
    } finally {
      db.close();
    }
  }

  public getSchedule(userId: string): ScheduleRecord {
    this.ensureUser(userId);
    const db = this.connect();
    try {
      return db.prepare("SELECT * FROM schedules WHERE user_id = ?").get(userId) as ScheduleRecord;
    } finally {
      db.close();
    }
  }

  /**
   * Persist a schedule patch. This is a trusted internal API (the worker uses it to set
   * last_run_at); HTTP input must be validated with SchedulePatchSchema first.
   */
  public updateSchedule(userId: string, patch: Partial<ScheduleRecord>): ScheduleRecord {
    const current = this.getSchedule(userId);
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as Partial<ScheduleRecord>;
    const updated: ScheduleRecord = {
      ...current,
      ...defined,
      schedule_id: current.schedule_id,
      user_id: userId,
      updated_at: new Date().toISOString(),
    };
    const db = this.connect();
    try {
      db.prepare(
        `UPDATE schedules SET
          enabled = ?, cron_expression = ?, trading_days_only = ?, timezone = ?,
          news_window_days = ?, max_instruments = ?, language = ?, gmail_query = ?,
          delivery_channel = ?, delivery_destination = ?, last_run_at = ?, updated_at = ?
         WHERE user_id = ?`
      ).run(
        updated.enabled ? 1 : 0,
        updated.cron_expression,
        updated.trading_days_only ? 1 : 0,
        updated.timezone,
        updated.news_window_days,
        updated.max_instruments,
        updated.language,
        updated.gmail_query,
        updated.delivery_channel,
        updated.delivery_destination,
        updated.last_run_at,
        updated.updated_at,
        userId
      );
      return updated;
    } finally {
      db.close();
    }
  }

  /** Enabled schedules; whether each one is due is decided by the worker (cron + timezone). */
  public listEnabledSchedules(): ScheduleRecord[] {
    const db = this.connect();
    try {
      return db
        .prepare("SELECT * FROM schedules WHERE enabled = 1 ORDER BY user_id")
        .all() as ScheduleRecord[];
    } finally {
      db.close();
    }
  }

  public summaryMetrics(userId: string): {
    snapshots: {
      total_snapshots: number;
      confirmed_snapshots: number;
      max_portfolio_instruments: number;
    };
    runs: {
      total_runs: number;
      confirmed_runs: number;
      total_researched_instruments: number;
      total_cited: number;
      total_unverified_withheld: number;
      total_failed: number;
      total_search_calls: number;
      total_tokens: number;
      total_estimated_cost_usd: number;
      total_excluded_news: number;
      citation_verification_rate: number;
    };
    recent_runs: Array<Record<string, unknown>>;
    audit_events: Array<Record<string, unknown>>;
    gmail: {
      connected: boolean;
      email_address: string | null;
      last_sync_at: string | null;
      last_sync_status: string | null;
    };
  } {
    this.ensureUser(userId);
    const db = this.connect();
    try {
      const snapRow = db
        .prepare(
          `SELECT COUNT(*) AS total_snapshots,
                  COALESCE(SUM(user_confirmed), 0) AS confirmed_snapshots,
                  COALESCE(MAX(instrument_count), 0) AS max_portfolio_instruments
           FROM snapshots WHERE user_id = ?`
        )
        .get(userId) as Record<string, number>;

      const runRow = db
        .prepare(
          `SELECT COUNT(*) AS total_runs,
                  COALESCE(SUM(confirmed), 0) AS confirmed_runs,
                  COALESCE(SUM(instrument_count), 0) AS total_researched_instruments,
                  COALESCE(SUM(cited_count), 0) AS total_cited,
                  COALESCE(SUM(unverified_count), 0) AS total_unverified_withheld,
                  COALESCE(SUM(failed_count), 0) AS total_failed,
                  COALESCE(SUM(total_search_calls), 0) AS total_search_calls,
                  COALESCE(SUM(total_tokens), 0) AS total_tokens,
                  ROUND(COALESCE(SUM(estimated_cost_usd), 0.0), 6) AS total_estimated_cost_usd,
                  COALESCE(SUM(excluded_news_count), 0) AS total_excluded_news
           FROM briefing_runs WHERE user_id = ?`
        )
        .get(userId) as Record<string, number>;

      const recentRuns = db
        .prepare(
          `SELECT run_id, snapshot_id, created_at, confirmed, language, model, instrument_count,
                  cited_count, unverified_count, failed_count, total_search_calls,
                  total_tokens, estimated_cost_usd, excluded_news_count, latency_ms
           FROM briefing_runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`
        )
        .all(userId) as Array<Record<string, unknown>>;

      const auditEvents = db
        .prepare(
          `SELECT created_at, run_id, event_type, severity, message
           FROM audit_events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 15`
        )
        .all(userId) as Array<Record<string, unknown>>;

      const oauthRow = db
        .prepare(
          "SELECT email_address, last_sync_at, last_sync_status FROM oauth_connections WHERE user_id = ? AND provider = 'gmail'"
        )
        .get(userId) as { email_address: string; last_sync_at: string | null; last_sync_status: string | null } | undefined;

      const totalResearched = Number(runRow.total_researched_instruments ?? 0);
      const totalCited = Number(runRow.total_cited ?? 0);
      const citationRate =
        totalResearched > 0 ? Number((totalCited / totalResearched).toFixed(4)) : 1.0;

      return {
        snapshots: {
          total_snapshots: Number(snapRow.total_snapshots ?? 0),
          confirmed_snapshots: Number(snapRow.confirmed_snapshots ?? 0),
          max_portfolio_instruments: Number(snapRow.max_portfolio_instruments ?? 0),
        },
        runs: {
          total_runs: Number(runRow.total_runs ?? 0),
          confirmed_runs: Number(runRow.confirmed_runs ?? 0),
          total_researched_instruments: totalResearched,
          total_cited: totalCited,
          total_unverified_withheld: Number(runRow.total_unverified_withheld ?? 0),
          total_failed: Number(runRow.total_failed ?? 0),
          total_search_calls: Number(runRow.total_search_calls ?? 0),
          total_tokens: Number(runRow.total_tokens ?? 0),
          total_estimated_cost_usd: Number(runRow.total_estimated_cost_usd ?? 0),
          total_excluded_news: Number(runRow.total_excluded_news ?? 0),
          citation_verification_rate: citationRate,
        },
        recent_runs: recentRuns,
        audit_events: auditEvents,
        gmail: {
          connected: Boolean(oauthRow),
          email_address: oauthRow?.email_address ?? null,
          last_sync_at: oauthRow?.last_sync_at ?? null,
          last_sync_status: oauthRow?.last_sync_status ?? null,
        },
      };
    } finally {
      db.close();
    }
  }
}
