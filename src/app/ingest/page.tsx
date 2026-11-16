"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Play, Shield } from "lucide-react";
import type { Instrument, Statement } from "@/lib/agent/models";

export default function IngestPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"upload" | "paste" | "sample">("sample");
  const [file, setFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState("");
  const [consent, setConsent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statement, setStatement] = useState<Statement | null>(null);
  const [piiCounts, setPiiCounts] = useState<Record<string, number>>({});
  const [confirmed, setConfirmed] = useState(false);

  async function handleExtract() {
    setError(null);
    setLoading(true);
    try {
      let res: Response;
      if (mode === "upload") {
        if (!file) throw new Error("Select a PDF or TXT file first.");
        const form = new FormData();
        form.append("file", file);
        res = await fetch("/api/ingest", { method: "POST", body: form });
      } else {
        res = await fetch("/api/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mode === "sample" ? { mode: "sample" } : { text: pastedText }),
        });
      }
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Extraction failed");
      setStatement(data.statement);
      setPiiCounts(data.piiRedactions || {});
      setConfirmed(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extraction failed");
    } finally {
      setLoading(false);
    }
  }

  function updateInstrument(index: number, field: keyof Instrument, value: string) {
    if (!statement) return;
    const next = [...statement.instruments];
    next[index] = {
      ...next[index],
      [field]: field === "holding_quantity" ? (value.trim() ? value : null) : value,
    };
    setStatement({ ...statement, instruments: next });
  }

  async function handleSaveSnapshot() {
    if (!statement) return;
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/snapshots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          statement,
          confirmed,
          sourceType: mode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to save snapshot");
      router.push(`/briefings?snapshot=${encodeURIComponent(data.snapshot_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">1. Statement Ingestion & Review</h1>
        <p className="mt-1 text-sm text-slate-400">
          Extract positions from a searchable IBKR/brokerage PDF, inspect verbatim page evidence,
          and confirm the snapshot before generating market intelligence.
        </p>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-5">
        <div className="flex flex-wrap gap-2">
          {(["sample", "upload", "paste"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
                mode === m
                  ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40"
                  : "bg-slate-800 text-slate-300 hover:bg-slate-700"
              }`}
            >
              {m === "sample"
                ? "Fictional IBKR Sample"
                : m === "upload"
                  ? "Upload PDF / TXT"
                  : "Paste Excerpt"}
            </button>
          ))}
        </div>

        {mode === "upload" && (
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-slate-700 bg-slate-950/50 p-8 transition hover:border-emerald-500/50">
            <FileUp className="h-8 w-8 text-slate-400" />
            <span className="mt-2 text-sm font-medium text-slate-200">
              {file ? file.name : "Click to select searchable PDF or UTF-8 TXT (max 10 MB, 80 pages)"}
            </span>
            <input
              type="file"
              accept=".pdf,.txt"
              className="hidden"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
            />
          </label>
        )}

        {mode === "paste" && (
          <textarea
            value={pastedText}
            onChange={(e) => setPastedText(e.target.value)}
            rows={6}
            placeholder="Paste brokerage statement positions or trade activity..."
            className="w-full rounded-xl border border-slate-700 bg-slate-950 p-4 font-mono text-xs text-slate-200 focus:border-emerald-500 focus:outline-none"
          />
        )}

        {mode === "sample" && (
          <div className="rounded-xl border border-slate-800 bg-slate-950 p-4 text-xs text-slate-300">
            Uses a built-in fictional IBKR Daily Activity Statement containing NVDA, MSFT, ASML, a
            short QQQ ETF position (-315), and a CBOE put option contract, plus a dummy account
            number line to demonstrate local PII redaction.
          </div>
        )}

        <div className="flex items-start gap-3 rounded-xl border border-sky-500/20 bg-sky-500/10 p-4 text-xs text-sky-200">
          <Shield className="mt-0.5 h-4 w-4 shrink-0 text-sky-400" />
          <div>
            Local pre-processing automatically strips account numbers, SSN/Tax IDs, and inline
            emails before sending text to the configured AI provider (OpenAI unless an API
            gateway is set) for structured extraction. Raw PDFs are not persisted.
          </div>
        </div>

        <label className="flex items-center gap-2.5 text-sm text-slate-300">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500"
          />
          I agree to send sanitized statement text to the configured AI provider for structured
          extraction.
        </label>

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
            {error}
          </div>
        )}

        <button
          type="button"
          disabled={!consent || loading}
          onClick={handleExtract}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {loading ? "Extracting Instruments..." : "Extract Instruments"}
        </button>
      </div>

      {statement && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-white">2. Human-in-the-Loop Review</h2>
              <p className="text-xs text-slate-400">
                Type: <strong className="text-white">{statement.kind}</strong> · As of:{" "}
                <strong className="text-white">{statement.as_of || "unknown"}</strong> · Period:{" "}
                <strong className="text-white">{statement.period || "unknown"}</strong>
              </p>
            </div>
            {Object.keys(piiCounts).length > 0 && (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Redacted {Object.values(piiCounts).reduce((a, b) => a + b, 0)} PII field(s)
              </span>
            )}
          </div>

          {statement.warnings.length > 0 && (
            <div className="space-y-1.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
              {statement.warnings.map((w, i) => (
                <div key={i} className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                  <span>{w}</span>
                </div>
              ))}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-950 text-slate-400">
                <tr>
                  <th className="px-3 py-2.5">Symbol</th>
                  <th className="px-3 py-2.5">Name</th>
                  <th className="px-3 py-2.5">Type</th>
                  <th className="px-3 py-2.5">Exchange</th>
                  <th className="px-3 py-2.5">Qty</th>
                  <th className="px-3 py-2.5">Ccy</th>
                  <th className="px-3 py-2.5">Page</th>
                  <th className="px-3 py-2.5">Evidence</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/80">
                {statement.instruments.map((inst, idx) => (
                  <tr key={idx} className="bg-slate-900/40">
                    <td className="px-3 py-2">
                      <input
                        value={inst.symbol}
                        onChange={(e) => updateInstrument(idx, "symbol", e.target.value)}
                        className="w-28 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-white"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={inst.name}
                        onChange={(e) => updateInstrument(idx, "name", e.target.value)}
                        className="w-44 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-300">{inst.asset_type}</td>
                    <td className="px-3 py-2">
                      <input
                        value={inst.exchange}
                        onChange={(e) => updateInstrument(idx, "exchange", e.target.value)}
                        className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-slate-200"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <input
                        value={inst.holding_quantity ?? ""}
                        disabled={statement.kind !== "holdings"}
                        placeholder="unknown"
                        onChange={(e) => updateInstrument(idx, "holding_quantity", e.target.value)}
                        className="w-20 rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-emerald-300 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-3 py-2 font-mono text-slate-300">{inst.currency}</td>
                    <td className="px-3 py-2 font-mono text-slate-400">{inst.source_page}</td>
                    <td className="max-w-xs truncate px-3 py-2 font-mono text-[11px] text-slate-400">
                      {inst.evidence}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="flex items-center gap-2.5 text-sm text-slate-300">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-emerald-500"
            />
            I have verified these instrument identities and quantities against the source statement.
          </label>

          <button
            type="button"
            disabled={!confirmed || saving}
            onClick={handleSaveSnapshot}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {saving ? "Saving Snapshot..." : "Confirm & Continue to Briefings"}
          </button>
        </div>
      )}
    </div>
  );
}
