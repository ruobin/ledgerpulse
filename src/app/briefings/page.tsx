"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Download, Loader2, Play, Sparkles } from "lucide-react";

interface SnapshotRow {
  snapshot_id: string;
  saved_at: string;
  kind: string;
  as_of: string | null;
  instrument_count: number;
  user_confirmed: boolean;
  source_type: string;
}

interface RunRow {
  run_id: string;
  created_at: string;
  model: string;
  language: string;
  instrument_count: number;
  cited_count: number;
  unverified_count: number;
  total_tokens: number;
  estimated_cost_usd: number;
  excluded_news_count: number;
}

function BriefingsContent() {
  const searchParams = useSearchParams();
  const initialSnap = searchParams.get("snapshot") || "";

  const [snapshots, setSnapshots] = useState<SnapshotRow[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [selectedSnapshot, setSelectedSnapshot] = useState(initialSnap);
  const [days, setDays] = useState(7);
  const [maxInstruments, setMaxInstruments] = useState(3);
  const [language, setLanguage] = useState<"English" | "Chinese">("English");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeMarkdown, setActiveMarkdown] = useState<string>("");
  const [activeRunId, setActiveRunId] = useState<string>("");

  async function refreshLists() {
    const [sRes, rRes] = await Promise.all([fetch("/api/snapshots"), fetch("/api/briefings")]);
    const sData = await sRes.json();
    const rData = await rRes.json();
    setSnapshots(sData.snapshots || []);
    setRuns(rData.runs || []);
    if (!selectedSnapshot && sData.snapshots?.length > 0) {
      setSelectedSnapshot(sData.snapshots[0].snapshot_id);
    }
    if (!activeRunId && rData.runs?.length > 0) {
      loadRun(rData.runs[0].run_id);
    }
  }

  async function loadRun(runId: string) {
    const res = await fetch(`/api/briefings/${encodeURIComponent(runId)}`);
    const data = await res.json();
    if (res.ok && data.run) {
      setActiveRunId(data.run.run_id);
      setActiveMarkdown(data.run.markdown);
    }
  }

  useEffect(() => {
    refreshLists().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleGenerate() {
    if (!selectedSnapshot) return;
    setError(null);
    setGenerating(true);
    try {
      const res = await fetch("/api/briefings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          snapshotId: selectedSnapshot,
          days,
          maxInstruments,
          language,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Briefing generation failed");
      setActiveRunId(data.runId);
      setActiveMarkdown(data.markdown);
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Generation failed");
    } finally {
      setGenerating(false);
    }
  }

  function downloadMarkdown() {
    const blob = new Blob([activeMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ledgerpulse-briefing-${activeRunId || "report"}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Market Intelligence Briefings</h1>
        <p className="mt-1 text-sm text-slate-400">
          Generate bounded, cited briefings from any saved portfolio snapshot using two-stage
          evidence isolation.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-5 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
          <h2 className="flex items-center gap-2 text-base font-semibold text-white">
            <Sparkles className="h-4 w-4 text-emerald-400" />
            Run Configuration
          </h2>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">Confirmed Snapshot</label>
            <select
              value={selectedSnapshot}
              onChange={(e) => setSelectedSnapshot(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
            >
              {snapshots.length === 0 && <option value="">No snapshots yet</option>}
              {snapshots.map((s) => (
                <option key={s.snapshot_id} value={s.snapshot_id}>
                  {s.snapshot_id} ({s.kind}, {s.instrument_count} pos, {s.source_type})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">News Window</label>
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
              >
                <option value={1}>Last 24h</option>
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={30}>Last 30 days</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-400">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as "English" | "Chinese")}
                className="w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"
              >
                <option value="English">English</option>
                <option value="Chinese">Chinese</option>
              </select>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400">
              Max Instruments Cost Cap: <strong className="text-white">{maxInstruments}</strong>
            </label>
            <input
              type="range"
              min={1}
              max={10}
              value={maxInstruments}
              onChange={(e) => setMaxInstruments(Number(e.target.value))}
              className="w-full accent-emerald-500"
            />
          </div>

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </div>
          )}

          <button
            type="button"
            disabled={!selectedSnapshot || generating}
            onClick={handleGenerate}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-40"
          >
            {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {generating ? "Researching & Synthesizing..." : "Generate Briefing"}
          </button>

          <div className="border-t border-slate-800 pt-4">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              Past Runs
            </h3>
            <div className="mt-2.5 space-y-2 max-h-64 overflow-y-auto">
              {runs.map((r) => (
                <button
                  key={r.run_id}
                  type="button"
                  onClick={() => loadRun(r.run_id)}
                  className={`w-full rounded-xl border p-3 text-left text-xs transition ${
                    activeRunId === r.run_id
                      ? "border-emerald-500/50 bg-emerald-500/10"
                      : "border-slate-800 bg-slate-950/60 hover:border-slate-700"
                  }`}
                >
                  <div className="flex items-center justify-between font-mono text-slate-200">
                    <span>{r.run_id}</span>
                    <span className="text-emerald-400">${r.estimated_cost_usd.toFixed(4)}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-slate-400">
                    {r.cited_count}/{r.instrument_count} cited · {r.excluded_news_count} blocked ·{" "}
                    {r.language}
                  </div>
                </button>
              ))}
              {runs.length === 0 && (
                <p className="text-xs text-slate-500">No briefing runs saved yet.</p>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 lg:col-span-2">
          <div className="mb-4 flex items-center justify-between border-b border-slate-800 pb-4">
            <h2 className="text-base font-semibold text-white">
              {activeRunId ? `Report: ${activeRunId}` : "Report Preview"}
            </h2>
            {activeMarkdown && (
              <button
                type="button"
                onClick={downloadMarkdown}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
              >
                <Download className="h-3.5 w-3.5" />
                Download .md
              </button>
            )}
          </div>

          {activeMarkdown ? (
            <article className="prose prose-invert prose-sm max-w-none prose-headings:text-white prose-a:text-emerald-400 prose-strong:text-white">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{activeMarkdown}</ReactMarkdown>
            </article>
          ) : (
            <div className="flex h-64 items-center justify-center text-sm text-slate-500">
              Select a snapshot and click Generate Briefing to inspect a cited report.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function BriefingsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-slate-400">Loading briefings...</div>}>
      <BriefingsContent />
    </Suspense>
  );
}
