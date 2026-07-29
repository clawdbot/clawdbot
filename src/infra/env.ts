// Normalizes env flag values and logs env warnings lazily.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SubsystemLogger } from "../logging/subsystem.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
export { isFastTestRuntimeEnv, isVitestRuntimeEnv } from "./test-runtime-env.js";

let log: SubsystemLogger | null = null;
const loadLog = createLazyPromise(
  () =>
    import("../logging/subsystem.js").then(({ createSubsystemLogger }) =>
      createSubsystemLogger("env"),
    ),
  { cacheRejections: true },
);
const loggedEnv = new Set<string>();
const ENV_NORMALIZATION_KEY_GROUPS = [["ZAI_API_KEY", "Z_AI_API_KEY"]] as const;

async function getLog(): Promise<SubsystemLogger> {
  if (!log) {
    log = await loadLog();
  }
  return log;
}

type AcceptedEnvOption = {
  key: string;
  description: string;
  value?: string;
  redact?: boolean;
};

function formatEnvValue(value: string, redact?: boolean): string {
  if (redact) {
    return "<redacted>";
  }
  const singleLine = value.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${truncateUtf16Safe(singleLine, 160)}…`;
}

/** Logs an accepted env option once, with optional redaction for sensitive values. */
export function logAcceptedEnvOption(option: AcceptedEnvOption): void {
  if (process.env.VITEST || process.env.NODE_ENV === "test") {
    return;
  }
  if (loggedEnv.has(option.key)) {
    return;
  }
  const rawValue = option.value ?? process.env[option.key];
  if (!rawValue || !rawValue.trim()) {
    return;
  }
  loggedEnv.add(option.key);
  void getLog()
    .then((logger) => {
      logger.info(
        `env: ${option.key}=${formatEnvValue(rawValue, option.redact)} (${option.description})`,
      );
    })
    .catch(() => {
      // Best-effort diagnostics only.
    });
}

/** Normalizes the legacy Z_AI_API_KEY spelling into the canonical ZAI_API_KEY env var. */
export function normalizeZaiEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (!env.ZAI_API_KEY?.trim() && env.Z_AI_API_KEY?.trim()) {
    env.ZAI_API_KEY = env.Z_AI_API_KEY;
  }
}

/** Expands env keys to include aliases that process-wide normalization treats as equivalent. */
export function expandEnvNormalizationKeys(keys: Iterable<string>): Set<string> {
  const expanded = new Set<string>();
  for (const key of keys) {
    for (const normalizedKey of resolveEnvNormalizationKeys(key)) {
      expanded.add(normalizedKey);
    }
  }
  return expanded;
}

/** Resolves one env key to its canonical-first runtime normalization group. */
export function resolveEnvNormalizationKeys(key: string): readonly string[] {
  const normalizedKey = process.platform === "win32" ? key.toUpperCase() : key;
  return (
    ENV_NORMALIZATION_KEY_GROUPS.find((group) =>
      group.some((candidate) => candidate === normalizedKey),
    ) ?? [normalizedKey]
  );
}

/** Interprets common human/operator truthy env strings. */
export function isTruthyEnvValue(value?: string): boolean {
  if (typeof value !== "string") {
    return false;
  }
  switch (normalizeLowercaseStringOrEmpty(value)) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    default:
      return false;
  }
}

/** Applies process-wide env normalization before runtime configuration is read. */
export function normalizeEnv(): void {
  normalizeZaiEnv(process.env);
}
