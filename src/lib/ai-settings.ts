import fs from "fs";
import path from "path";
import {
  parseBaseUrl,
  parseBraveCost,
  parseBraveEndpoint,
  parseHeaders,
  parseWebSearchProvider,
  resolveAiConfig,
  validateModelId,
  type LlmEnv,
} from "./agent/llm-config";
import { AI_SETTINGS, aiSettingDescriptor, type AiSettingDescriptor } from "./ai-settings-catalog";
import { OperationalStore } from "./db/store";
import { decryptSecret, encryptSecret, parsePricingOverrides } from "./telemetry";

/**
 * Admin Console settings: values saved in SQLite (secrets AES-256-GCM encrypted with
 * TOKEN_ENCRYPTION_KEY) layered over process.env. The web app and the worker share the
 * database, so a saved change applies to the next model call in either process.
 */

const stores = new Map<string, OperationalStore>();

function dataDir(): string {
  return path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
}

/** One store per data directory, so hot paths don't re-run schema setup on every read. */
function settingsStore(): OperationalStore {
  const dir = dataDir();
  let store = stores.get(dir);
  if (!store) {
    store = new OperationalStore(dir);
    stores.set(dir, store);
  }
  return store;
}

/** Reading settings never creates a database: with none yet, nothing has been saved. */
function existingSettingsStore(): OperationalStore | null {
  const dir = dataDir();
  return stores.has(dir) || fs.existsSync(path.join(dir, "ledgerpulse.sqlite")) ? settingsStore() : null;
}

interface StoredSettings {
  values: Record<string, string>;
  /** Secret keys whose ciphertext no longer decrypts (TOKEN_ENCRYPTION_KEY changed). */
  undecryptable: string[];
}

function readStoredSettings(store: OperationalStore | null = existingSettingsStore()): StoredSettings {
  const values: Record<string, string> = {};
  const undecryptable: string[] = [];
  for (const row of store?.listAppSettings() ?? []) {
    if (!aiSettingDescriptor(row.key)) continue;
    if (!row.encrypted) {
      values[row.key] = row.value;
      continue;
    }
    try {
      values[row.key] = decryptSecret(row.value);
    } catch {
      undecryptable.push(row.key);
    }
  }
  return { values, undecryptable };
}

/**
 * process.env overlaid with Admin Console values. With `strict`, an undecryptable secret is
 * an error instead of silently falling back to the environment.
 */
export function aiEnv(options: { strict?: boolean; store?: OperationalStore } = {}): LlmEnv {
  const { values, undecryptable } = readStoredSettings(options.store);
  if (options.strict && undecryptable.length > 0) {
    throw new Error(
      `Admin setting ${undecryptable.join(", ")} cannot be decrypted with the current TOKEN_ENCRYPTION_KEY. Enter it again in the Admin Console.`
    );
  }
  return { ...process.env, ...values };
}

const SECRET_TOKEN = /^\S{1,1024}$/;

/** Validate and normalize one value; throws with a user-facing reason. */
export function validateSettingValue(descriptor: AiSettingDescriptor, raw: string): string {
  const value = raw.trim();
  switch (descriptor.key) {
    case "LLM_BASE_URL":
      parseBaseUrl(value);
      return value;
    case "LLM_API_KEY":
    case "BRAVE_SEARCH_API_KEY":
      if (!SECRET_TOKEN.test(value)) throw new Error("must be a single token without spaces");
      return value;
    case "LLM_HEADERS":
      parseHeaders(value);
      return value;
    case "LLM_MODEL":
    case "LLM_ANALYSIS_MODEL":
    case "LLM_RESEARCH_MODEL":
      return validateModelId(value);
    case "WEB_SEARCH_PROVIDER":
      return parseWebSearchProvider(value);
    case "BRAVE_SEARCH_ENDPOINT":
      return parseBraveEndpoint(value);
    case "BRAVE_SEARCH_COST_PER_1K":
      return String(parseBraveCost(value));
    case "LLM_PRICING":
      parsePricingOverrides(value);
      return value;
    default:
      throw new Error("is not an editable setting");
  }
}

export class SettingsValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid settings: ${issues.join("; ")}`);
    this.name = "SettingsValidationError";
  }
}

/**
 * Apply a patch from the Admin Console. A null or blank value removes the override, so the
 * environment value (or the default) applies again. All values are validated before
 * anything is written; secrets are encrypted before they reach the database.
 */
export function saveAiSettings(
  patch: Record<string, string | null>,
  options: { userId: string; store?: OperationalStore }
): { changedKeys: string[] } {
  const store = options.store ?? settingsStore();
  const issues: string[] = [];
  const changes: Array<{ key: string; value: string | null; encrypted: boolean }> = [];

  for (const [key, raw] of Object.entries(patch)) {
    const descriptor = aiSettingDescriptor(key);
    if (!descriptor) {
      issues.push(`${key}: unknown setting`);
      continue;
    }
    if (raw === null || raw.trim() === "") {
      changes.push({ key, value: null, encrypted: false });
      continue;
    }
    try {
      const value = validateSettingValue(descriptor, raw);
      const secret = descriptor.kind === "secret";
      changes.push({ key, value: secret ? encryptSecret(value) : value, encrypted: secret });
    } catch (err) {
      issues.push(`${key}: ${err instanceof Error ? err.message : "invalid value"}`);
    }
  }
  if (issues.length > 0) {
    throw new SettingsValidationError(issues);
  }

  store.writeAppSettings(changes);
  const changedKeys = changes.map((change) => change.key);
  if (changedKeys.length > 0) {
    // Key names only: values (and especially secrets) never enter the audit trail.
    store.logEvent({
      userId: options.userId,
      eventType: "admin_settings_updated",
      message: `Updated AI settings: ${changedKeys.join(", ")}.`,
      severity: "info",
      details: { keys: changedKeys },
    });
  }
  return { changedKeys };
}

export interface AiSettingState {
  key: string;
  source: "admin" | "env" | "default";
  /** Environment variable that supplied the value when source is "env". */
  envName: string | null;
  /** Effective value for non-secret settings; always null for secrets. */
  value: string | null;
  configured: boolean;
  error: string | null;
}

/** What the Admin Console shows. Secret values never leave the server. */
export function aiSettingsState(store?: OperationalStore): { settings: AiSettingState[]; configError: string | null } {
  const { values, undecryptable } = readStoredSettings(store ?? existingSettingsStore());

  const settings = AI_SETTINGS.map((descriptor): AiSettingState => {
    const secret = descriptor.kind === "secret";
    if (undecryptable.includes(descriptor.key)) {
      return {
        key: descriptor.key,
        source: "admin",
        envName: null,
        value: null,
        configured: false,
        error: "Cannot be decrypted with the current TOKEN_ENCRYPTION_KEY. Enter it again.",
      };
    }

    let source: AiSettingState["source"] = "default";
    let envName: string | null = null;
    let effective = descriptor.defaultValue;
    if (values[descriptor.key] !== undefined) {
      source = "admin";
      effective = values[descriptor.key];
    } else {
      for (const name of [descriptor.key, ...descriptor.envAliases]) {
        const fromEnv = process.env[name]?.trim();
        if (fromEnv) {
          source = "env";
          envName = name;
          effective = fromEnv;
          break;
        }
      }
    }

    let error: string | null = null;
    if (source !== "default" && effective) {
      try {
        validateSettingValue(descriptor, effective);
      } catch (err) {
        error = err instanceof Error ? err.message : "Invalid value";
      }
    }

    return {
      key: descriptor.key,
      source,
      envName,
      value: secret ? null : effective,
      configured: effective.length > 0,
      error,
    };
  });

  let configError: string | null = null;
  try {
    resolveAiConfig({ ...process.env, ...values });
  } catch (err) {
    configError = err instanceof Error ? err.message : "Invalid AI configuration";
  }
  if (!configError && undecryptable.length > 0) {
    configError = `Admin setting ${undecryptable.join(", ")} cannot be decrypted; enter it again.`;
  }
  return { settings, configError };
}
