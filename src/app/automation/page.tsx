"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Clock, Loader2, Mail, RefreshCw, Save } from "lucide-react";

interface ScheduleConfig {
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
}

export default function AutomationPage() {
  const [gmailStatus, setGmailStatus] = useState<{
    connected: boolean;
    email_address: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
  } | null>(null);
  const [oauthConfigured, setOauthConfigured] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<ScheduleConfig | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadAll() {
    const [evalRes, authRes, schedRes] = await Promise.all([
      fetch("/api/evals"),
      fetch("/api/gmail/auth"),
      fetch("/api/schedules"),
    ]);
    const evalData = await evalRes.json();
    const authData = await authRes.json();
    const schedData = await schedRes.json();
    setGmailStatus(evalData.gmail);
    setOauthConfigured(Boolean(authData.configured));
    setAuthUrl(authData.authUrl);
    setSchedule(schedData.schedule);
  }

  useEffect(() => {
    // Surface the result of the Google OAuth redirect (/api/gmail/callback), then tidy the URL.
    const params = new URLSearchParams(window.location.search);
    if (params.get("connected") === "1") {
      setSyncMessage("Gmail connected. Scheduled syncs will use this inbox.");
    } else if (params.get("error")) {
      setError(params.get("error"));
    }
    if (params.has("connected") || params.has("error")) {
      window.history.replaceState(null, "", window.location.pathname);
    }

    loadAll().catch(() => setError("Could not load automation settings."));
  }, []);

  async function handleSaveSchedule() {
    if (!schedule) return;
    setSaving(true);
    setError(null);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/schedules", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save schedule");
      setSchedule(data.schedule);
      setSyncMessage("Schedule saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncNow(demoMode = false) {
    setSyncing(true);
    setError(null);
    setSyncMessage(null);
    try {
      const res = await fetch("/api/gmail/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runBriefingAfter: false, demoMode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Sync failed");

      if (data.syncStatus === "skipped_duplicate") {
        setSyncMessage(
          `Deduplicated (${data.mode}): ${data.filename} was already ingested into snapshot ${data.snapshotId}.`
        );
      } else if (data.syncStatus === "no_matching_email") {
        setSyncMessage("No matching IBKR Daily Activity Statement emails found in inbox.");
      } else {
        setSyncMessage(
          `Ingested (${data.mode}): ${data.filename} -> snapshot ${data.snapshotId} (${data.instrumentCount} instruments).`
        );
      }
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Gmail API & Trading-Day Automation</h1>
        <p className="mt-1 text-sm text-slate-400">
          Connect your Gmail inbox (read-only OAuth2 scope) to automatically fetch Interactive
          Brokers Daily Activity Statement PDFs every trading day with SHA-256 deduplication.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-base font-semibold text-white">
              <Mail className="h-4 w-4 text-emerald-400" />
              Gmail OAuth2 Connection
            </h2>
            {gmailStatus?.connected ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" /> Connected
              </span>
            ) : (
              <span className="rounded-full bg-slate-800 px-2.5 py-1 text-xs text-slate-400">
                Not Connected
              </span>
            )}
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-300 space-y-1.5">
            <p>
              <span className="text-slate-500">Account:</span>{" "}
              {gmailStatus?.email_address || "None connected"}
            </p>
            <p>
              <span className="text-slate-500">Token Security:</span> AES-256-GCM encrypted refresh
              token in SQLite
            </p>
            <p>
              <span className="text-slate-500">Scope:</span>{" "}
              <code className="text-emerald-300">gmail.readonly</code> (least privilege)
            </p>
            <p>
              <span className="text-slate-500">Last Sync:</span>{" "}
              {gmailStatus?.last_sync_at
                ? `${new Date(gmailStatus.last_sync_at).toLocaleString()} (${gmailStatus.last_sync_status})`
                : "Never"}
            </p>
          </div>

          <div className="flex flex-wrap gap-3">
            {oauthConfigured && authUrl ? (
              <a
                href={authUrl}
                className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400"
              >
                <Mail className="h-4 w-4" />
                {gmailStatus?.connected ? "Reconnect Gmail OAuth2" : "Connect Gmail OAuth2"}
              </a>
            ) : (
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-200">
                Live Google OAuth2 requires <code>GMAIL_CLIENT_ID</code> and{" "}
                <code>GMAIL_CLIENT_SECRET</code> in <code>.env</code>. You can test the full
                pipeline right now using Simulated IBKR Sync below.
              </div>
            )}

            <button
              type="button"
              disabled={syncing}
              onClick={() => handleSyncNow(!gmailStatus?.connected)}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
            >
              {syncing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {gmailStatus?.connected ? "Fetch IBKR Email Now" : "Run Simulated IBKR Sync"}
            </button>
          </div>

          {syncMessage && (
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200">
              {syncMessage}
            </div>
          )}
          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            <Clock className="h-4 w-4 text-emerald-400" />
            Trading-Day Worker Schedule
          </h2>

          {schedule ? (
            <div className="space-y-4 text-sm">
              <label className="flex items-center gap-2.5 text-slate-300">
                <input
                  type="checkbox"
                  checked={Boolean(schedule.enabled)}
                  onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked ? 1 : 0 })}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500"
                />
                Enable automated background worker sync
              </label>

              <label className="flex items-center gap-2.5 text-slate-300">
                <input
                  type="checkbox"
                  checked={Boolean(schedule.trading_days_only)}
                  onChange={(e) =>
                    setSchedule({ ...schedule, trading_days_only: e.target.checked ? 1 : 0 })
                  }
                  className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500"
                />
                Restrict to trading weekdays (Mon–Fri)
              </label>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">
                  Run Schedule (cron, evaluated in the timezone below)
                </label>
                <input
                  value={schedule.cron_expression}
                  onChange={(e) => setSchedule({ ...schedule, cron_expression: e.target.value })}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
                />
                <p className="text-[11px] text-slate-500">
                  <code>0 18 * * 1-5</code> = 18:00 Mon–Fri. Last scheduled run:{" "}
                  {schedule.last_run_at ? new Date(schedule.last_run_at).toLocaleString() : "never"}
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-xs font-medium text-slate-400">Gmail Search Query</label>
                <input
                  value={schedule.gmail_query}
                  onChange={(e) => setSchedule({ ...schedule, gmail_query: e.target.value })}
                  className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">Timezone (IANA)</label>
                  <input
                    value={schedule.timezone}
                    onChange={(e) => setSchedule({ ...schedule, timezone: e.target.value })}
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-400">Max Instruments</label>
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={schedule.max_instruments}
                    onChange={(e) =>
                      setSchedule({ ...schedule, max_instruments: Number(e.target.value) })
                    }
                    className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white"
                  />
                </div>
              </div>

              <button
                type="button"
                disabled={saving}
                onClick={handleSaveSchedule}
                className="inline-flex items-center gap-2 rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white ring-1 ring-slate-700 hover:bg-slate-700"
              >
                <Save className="h-4 w-4" />
                {saving ? "Saving..." : "Save Schedule"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">Loading schedule...</p>
          )}
        </div>
      </div>
    </div>
  );
}
