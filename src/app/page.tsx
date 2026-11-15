"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  CheckCircle2,
  FileText,
  Mail,
  ShieldAlert,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";

interface SummaryData {
  snapshots: {
    total_snapshots: number;
    confirmed_snapshots: number;
    max_portfolio_instruments: number;
  };
  runs: {
    total_runs: number;
    citation_verification_rate: number;
    total_excluded_news: number;
    total_unverified_withheld: number;
    total_estimated_cost_usd: number;
    total_tokens: number;
  };
  gmail: {
    connected: boolean;
    email_address: string | null;
    last_sync_at: string | null;
    last_sync_status: string | null;
  };
  audit_events: Array<{
    created_at: string;
    event_type: string;
    severity: string;
    message: string;
  }>;
}

export default function DashboardPage() {
  const [data, setData] = useState<SummaryData | null>(null);

  useEffect(() => {
    fetch("/api/evals")
      .then((r) => r.json())
      .then(setData)
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900 to-emerald-950/30 p-6 sm:p-8">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-center">
          <div className="max-w-2xl space-y-2">
            <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" />
              Two-Stage Evidence Isolation · Gmail IBKR Auto-Sync · Multi-Tenant Ready
            </div>
            <h1 className="text-3xl font-bold tracking-tight text-white">
              LedgerPulse Portfolio Intelligence
            </h1>
            <p className="text-sm leading-relaxed text-slate-300">
              Automatically fetch your Interactive Brokers Daily Activity Statement from Gmail or
              upload a brokerage PDF, verify extracted positions against page-level evidence, and
              generate date-checked, cited market briefings with zero hallucinated claims.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/automation"
              className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400"
            >
              <Mail className="h-4 w-4" />
              Gmail IBKR Sync
            </Link>
            <Link
              href="/ingest"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-slate-700"
            >
              <UploadCloud className="h-4 w-4" />
              Upload Statement
            </Link>
          </div>
        </div>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Portfolio Snapshots
          </p>
          <p className="mt-2 text-2xl font-bold text-white">
            {data ? data.snapshots.total_snapshots : "—"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {data ? `${data.snapshots.confirmed_snapshots} human-confirmed` : "Loading..."}
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Citation Verification
          </p>
          <p className="mt-2 text-2xl font-bold text-emerald-400">
            {data ? `${(data.runs.citation_verification_rate * 100).toFixed(1)}%` : "—"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {data ? `${data.runs.total_runs} briefing run(s) recorded` : "Loading..."}
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Guardrail Blocks
          </p>
          <p className="mt-2 text-2xl font-bold text-amber-300">
            {data
              ? data.runs.total_excluded_news + data.runs.total_unverified_withheld
              : "—"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {data
              ? `${data.runs.total_excluded_news} undated news · ${data.runs.total_unverified_withheld} uncited`
              : "Loading..."}
          </p>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-5">
          <p className="text-xs font-medium uppercase tracking-wider text-slate-400">
            Cumulative API Spend
          </p>
          <p className="mt-2 text-2xl font-bold text-white">
            {data ? `$${data.runs.total_estimated_cost_usd.toFixed(4)}` : "—"}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {data ? `${data.runs.total_tokens.toLocaleString()} total tokens` : "Loading..."}
          </p>
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white">Recent Guardrail & Security Events</h2>
            <Link
              href="/ops"
              className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              View full telemetry <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          {!data || data.audit_events.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 p-6 text-center text-sm text-slate-400">
              No audit events recorded yet. Sync an IBKR statement or upload a sample to start.
            </div>
          ) : (
            <div className="space-y-2.5">
              {data.audit_events.slice(0, 6).map((ev, idx) => (
                <div
                  key={`${ev.created_at}-${idx}`}
                  className="flex items-start gap-3 rounded-xl border border-slate-800/80 bg-slate-950/50 p-3.5"
                >
                  {ev.severity === "warning" || ev.severity === "error" ? (
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs font-semibold text-slate-200">
                        {ev.event_type}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        {new Date(ev.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-slate-400">{ev.message}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="text-lg font-semibold text-white">Workflow Pipeline</h2>
          <ol className="space-y-4 text-sm">
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">
                1
              </span>
              <div>
                <p className="font-medium text-white">Gmail Auto-Fetch or PDF Upload</p>
                <p className="text-xs text-slate-400">
                  Pulls IBKR Daily Activity Statements via Gmail API with SHA-256 deduplication and
                  local PII redaction.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">
                2
              </span>
              <div>
                <p className="font-medium text-white">Human-in-the-Loop Verification</p>
                <p className="text-xs text-slate-400">
                  Activity-only statements cannot masquerade as open holdings. Edit & confirm before
                  persistence.
                </p>
              </div>
            </li>
            <li className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-xs font-bold text-emerald-300">
                3
              </span>
              <div>
                <p className="font-medium text-white">Two-Stage Evidence Synthesis</p>
                <p className="text-xs text-slate-400">
                  Deterministic Python date & citation gates block undated or unsourced claims before
                  scenario generation.
                </p>
              </div>
            </li>
          </ol>
          <div className="pt-2">
            <Link
              href="/briefings"
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-slate-700"
            >
              <FileText className="h-4 w-4" />
              Open Briefings Reader
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
