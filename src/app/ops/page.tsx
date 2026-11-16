"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, Play, ShieldCheck, XCircle } from "lucide-react";

interface EvalSuite {
  category: string;
  passed: number;
  total: number;
  score: number;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
}

interface EvalSummary {
  evaluated_at: string;
  overall_passed: number;
  overall_total: number;
  overall_score: number;
  suites: EvalSuite[];
}

export default function OpsPage() {
  const [evalResult, setEvalResult] = useState<EvalSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runEvals() {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch("/api/evals", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !Array.isArray(data.suites)) {
        throw new Error(data.error || "Evaluation run failed");
      }
      setEvalResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Evaluation run failed");
    } finally {
      setRunning(false);
    }
  }

  useEffect(() => {
    runEvals();
  }, []);

  const allPassed = evalResult ? evalResult.overall_passed === evalResult.overall_total : false;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-white">Operations & Guardrail Evals</h1>
          <p className="mt-1 text-sm text-slate-400">
            Zero-cost deterministic invariant suite verifying schema safety, two-stage evidence
            isolation, AES-256-GCM token encryption, and Gmail SHA-256 deduplication.
          </p>
        </div>
        <button
          type="button"
          disabled={running}
          onClick={runEvals}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
        >
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          {running ? "Running Evals..." : "Run Evaluation Suite"}
        </button>
      </div>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {evalResult && (
        <div className="space-y-6">
          <div
            className={`flex items-center justify-between rounded-2xl border p-5 ${
              allPassed ? "border-emerald-500/30 bg-emerald-500/10" : "border-amber-500/30 bg-amber-500/10"
            }`}
          >
            <div className="flex items-center gap-3">
              <ShieldCheck className={`h-7 w-7 ${allPassed ? "text-emerald-400" : "text-amber-400"}`} />
              <div>
                <p className="text-lg font-bold text-white">
                  Overall Guardrail Score: {(evalResult.overall_score * 100).toFixed(1)}%
                </p>
                <p className={`text-xs ${allPassed ? "text-emerald-200" : "text-amber-200"}`}>
                  {evalResult.overall_passed}/{evalResult.overall_total} deterministic invariant
                  checks passed · Evaluated {new Date(evalResult.evaluated_at).toLocaleString()}
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-5 md:grid-cols-2">
            {evalResult.suites.map((suite) => (
              <div
                key={suite.category}
                className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-white">{suite.category}</h2>
                  <span className="rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-xs font-semibold text-emerald-300">
                    {suite.passed}/{suite.total}
                  </span>
                </div>
                <div className="space-y-2">
                  {suite.checks.map((c) => (
                    <div
                      key={c.name}
                      className="flex items-start gap-2.5 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 text-xs"
                    >
                      {c.passed ? (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
                      ) : (
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                      )}
                      <div>
                        <p className="font-mono font-semibold text-slate-200">{c.name}</p>
                        <p className="mt-0.5 text-slate-400">{c.detail}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
