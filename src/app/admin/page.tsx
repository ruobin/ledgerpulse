"use client";

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, PlugZap, RotateCcw, Save, SlidersHorizontal, XCircle } from "lucide-react";
import {
  AI_SETTING_GROUPS,
  AI_SETTINGS,
  type AiSettingDescriptor,
} from "@/lib/ai-settings-catalog";
import type { AiSettingState } from "@/lib/ai-settings";

interface SettingsResponse {
  settings: AiSettingState[];
  configError: string | null;
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  latencyMs: number;
}

/** Draft edits: a string sets an Admin Console value, null removes it (back to .env/default). */
type Drafts = Record<string, string | null>;

function SourceBadge({ state, descriptor }: { state: AiSettingState; descriptor: AiSettingDescriptor }) {
  if (state.source === "admin") {
    return <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-300">Admin</span>;
  }
  if (state.source === "env") {
    return (
      <span className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-300">
        .env · {state.envName}
      </span>
    );
  }
  return (
    <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-slate-400">
      Default{descriptor.defaultLabel ? ` · ${descriptor.defaultLabel}` : ""}
    </span>
  );
}

export default function AdminConsolePage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [drafts, setDrafts] = useState<Drafts>({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);

  useEffect(() => {
    fetch("/api/admin/settings")
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || "Could not load settings");
        setData(body);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load settings"));
  }, []);

  const stateByKey = useMemo(
    () => new Map((data?.settings ?? []).map((setting) => [setting.key, setting])),
    [data]
  );
  const dirty = Object.keys(drafts).length > 0;

  /** Value shown in a non-secret input: the draft if edited, otherwise the effective value. */
  function displayValue(descriptor: AiSettingDescriptor): string {
    if (descriptor.key in drafts) return drafts[descriptor.key] ?? "";
    const state = stateByKey.get(descriptor.key);
    return state?.source === "default" ? "" : (state?.value ?? "");
  }

  function setDraft(key: string, value: string | null) {
    setDrafts((current) => ({ ...current, [key]: value }));
    setMessage(null);
  }

  function discardDraft(key: string) {
    setDrafts((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: drafts }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Saving failed");
      setData(body);
      setDrafts({});
      setChecks(null);
      setMessage("Saved. The web app and the worker use the new settings from their next model call.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Saving failed");
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    setError(null);
    setChecks(null);
    try {
      const res = await fetch("/api/admin/settings/test", { method: "POST" });
      const body = await res.json();
      if (!res.ok || !Array.isArray(body.checks)) throw new Error(body.error || "Test failed");
      setChecks(body.checks);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  const effectiveProvider =
    (drafts.WEB_SEARCH_PROVIDER ?? undefined) ?? stateByKey.get("WEB_SEARCH_PROVIDER")?.value ?? "openai";

  function renderField(descriptor: AiSettingDescriptor) {
    const state = stateByKey.get(descriptor.key);
    if (!state) return null;
    const edited = descriptor.key in drafts;
    const inputClass =
      "w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white placeholder:text-slate-600 focus:border-emerald-500 focus:outline-none";
    const unusedResearchModel = descriptor.key === "LLM_RESEARCH_MODEL" && effectiveProvider === "brave";

    let input: React.ReactNode;
    if (descriptor.kind === "secret") {
      const pendingClear = edited && drafts[descriptor.key] === null;
      input = (
        <input
          type="password"
          autoComplete="off"
          value={edited ? (drafts[descriptor.key] ?? "") : ""}
          onChange={(e) => setDraft(descriptor.key, e.target.value)}
          placeholder={
            pendingClear
              ? "Saved value will be removed"
              : state.configured
                ? `Configured (${state.source === "admin" ? "Admin Console" : state.envName}). Type to replace.`
                : "Not set"
          }
          className={`${inputClass} font-mono`}
        />
      );
    } else if (descriptor.kind === "select") {
      const value = displayValue(descriptor) || descriptor.defaultValue;
      const selected = descriptor.options?.find((option) => option.value === value);
      input = (
        <div className="space-y-1.5">
          <select value={value} onChange={(e) => setDraft(descriptor.key, e.target.value)} className={inputClass}>
            {descriptor.options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          {selected && <p className="text-[11px] leading-relaxed text-slate-400">{selected.description}</p>}
        </div>
      );
    } else if (descriptor.kind === "json") {
      input = (
        <textarea
          rows={3}
          value={displayValue(descriptor)}
          onChange={(e) => setDraft(descriptor.key, e.target.value)}
          placeholder={descriptor.placeholder}
          className={`${inputClass} font-mono`}
        />
      );
    } else {
      input = (
        <input
          inputMode={descriptor.kind === "number" ? "decimal" : undefined}
          value={displayValue(descriptor)}
          onChange={(e) => setDraft(descriptor.key, e.target.value)}
          placeholder={descriptor.placeholder ?? descriptor.defaultLabel}
          className={`${inputClass} ${descriptor.kind === "text" ? "font-mono" : ""}`}
        />
      );
    }

    return (
      <div key={descriptor.key} className="space-y-1.5 border-t border-slate-800/80 pt-4 first:border-t-0 first:pt-0">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            {descriptor.kind === "secret" && <KeyRound className="h-3.5 w-3.5 text-slate-500" />}
            {descriptor.label}
            {unusedResearchModel && <span className="font-normal text-slate-500">(not used with Brave Search)</span>}
          </label>
          <div className="flex items-center gap-2">
            {edited && <span className="text-[11px] font-medium text-amber-300">Unsaved</span>}
            <SourceBadge state={state} descriptor={descriptor} />
          </div>
        </div>
        {input}
        <p className="text-[11px] leading-relaxed text-slate-500">{descriptor.help}</p>
        {state.error && <p className="text-[11px] text-red-300">{state.error}</p>}
        <div className="flex gap-3">
          {edited && (
            <button type="button" onClick={() => discardDraft(descriptor.key)} className="text-[11px] text-slate-400 hover:text-white">
              Undo edit
            </button>
          )}
          {state.source === "admin" && !(edited && drafts[descriptor.key] === null) && (
            <button
              type="button"
              onClick={() => setDraft(descriptor.key, null)}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-white"
            >
              <RotateCcw className="h-3 w-3" /> Use .env / default instead
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-white">
            <SlidersHorizontal className="h-6 w-6 text-emerald-400" />
            Admin Console
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-400">
            AI provider, models and web search. Saved values override <code>.env</code> and apply to the web
            app and the scheduler worker from their next model call. Secrets are stored encrypted and are never
            shown again. Anyone who can sign in to LedgerPulse can change these settings.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={save}
            className="inline-flex items-center gap-2 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save changes
          </button>
          <button
            type="button"
            disabled={!dirty || saving}
            onClick={() => setDrafts({})}
            className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            Discard
          </button>
          <button
            type="button"
            disabled={dirty || testing || !data}
            title={dirty ? "Save your changes before testing them" : undefined}
            onClick={testConnection}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <PlugZap className="h-4 w-4" />}
            Test connection
          </button>
        </div>
      </div>

      {data?.configError && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">
          Current configuration problem: {data.configError}
        </div>
      )}
      {error && <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</div>}
      {message && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{message}</div>
      )}

      {checks && (
        <div className="space-y-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-5">
          <h2 className="text-sm font-semibold text-white">Connection test (uses the saved settings)</h2>
          {checks.map((result) => (
            <div key={result.name} className="flex items-start gap-2.5 rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 text-xs">
              {result.ok ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-400" />
              ) : (
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
              )}
              <div>
                <p className="font-semibold text-slate-200">
                  {result.name} <span className="font-normal text-slate-500">· {result.latencyMs} ms</span>
                </p>
                <p className="mt-0.5 text-slate-400">{result.detail}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {!data && !error && <p className="text-sm text-slate-400">Loading settings…</p>}

      {data && (
        <div className="grid gap-6 lg:grid-cols-2">
          {AI_SETTING_GROUPS.map((group) => (
            <section key={group.id} className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/60 p-6">
              <div>
                <h2 className="text-base font-semibold text-white">{group.title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-slate-400">{group.description}</p>
              </div>
              <div className="space-y-4">
                {AI_SETTINGS.filter((setting) => setting.group === group.id).map(renderField)}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
