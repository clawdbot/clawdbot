import { createHmac, randomBytes } from "node:crypto";
import { resolvePositiveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { splitCommandArgs } from "openclaw/plugin-sdk/process-runtime";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  asOptionalRecord as readRecord,
  normalizeOptionalString as readNonEmptyString,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { OpenClawExecAsk, OpenClawExecSecurity } from "./config-contracts.js";
import type { CodexServiceTier } from "./protocol.js";

const START_OPTIONS_KEY_SECRET_SYMBOL = Symbol.for("openclaw.codexAppServerStartOptionsKeySecret");
const START_OPTIONS_KEY_SECRET = getStartOptionsKeySecret();
const PLAIN_DECIMAL_NUMBER_RE = /^[+-]?(?:(?:\d+\.?\d*)|(?:\.\d+))$/;

export { readNonEmptyString, readRecord };

export function normalizeCodexServiceTier(value: unknown): CodexServiceTier | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed.toLowerCase();
  if (normalized === "fast" || normalized === "priority") {
    return "priority";
  }
  if (normalized === "flex") {
    return "flex";
  }
  return trimmed;
}

export function isCodexFastServiceTier(value: unknown): boolean {
  return normalizeCodexServiceTier(value) === "priority";
}

export function normalizePositiveNumber(value: unknown, fallback: number): number {
  return resolvePositiveTimerTimeoutMs(value, fallback);
}

export function normalizeHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(value)
      .map(
        ([key, child]) =>
          [
            key.trim(),
            normalizeCodexAppServerSecretInput({
              value: child,
              path: `plugins.entries.codex.config.appServer.headers.${key}`,
            }),
          ] as const,
      )
      .filter((entry): entry is readonly [string, string] => Boolean(entry[0] && entry[1])),
  );
}

export function normalizeCodexAppServerSecretInput(params: {
  value: unknown;
  path: string;
}): string | undefined {
  return normalizeResolvedSecretInputString(params);
}

export function readBooleanEnv(value: string | undefined): boolean | undefined {
  return parseBooleanValue(value);
}

export function readExecSecurity(value: unknown): OpenClawExecSecurity | undefined {
  return value === "deny" || value === "allowlist" || value === "full" ? value : undefined;
}

export function readExecAsk(value: unknown): OpenClawExecAsk | undefined {
  return value === "off" || value === "on-miss" || value === "always" ? value : undefined;
}

export function readNumberEnv(value: string | undefined): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !PLAIN_DECIMAL_NUMBER_RE.test(trimmed)) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveArgs(configArgs: unknown, envArgs: string | undefined): string[] {
  if (Array.isArray(configArgs)) {
    return configArgs
      .map((entry) => readNonEmptyString(entry))
      .filter((entry): entry is string => entry !== undefined);
  }
  // v2026.9.1 string overrides preserve backslashes and accept unfinished quotes;
  // applying shell escaping or strict quote validation would change existing argv.
  return splitCommandArgs(typeof configArgs === "string" ? configArgs : (envArgs ?? ""), {
    allowUnclosedQuotes: true,
  });
}

export function hashSecretForKey(value: string | undefined, label: string): string | null {
  if (!value) {
    return null;
  }
  return createHmac("sha256", START_OPTIONS_KEY_SECRET)
    .update(label)
    .update("\0")
    .update(value)
    .digest("hex");
}

function getStartOptionsKeySecret(): Buffer {
  const globalState = globalThis as typeof globalThis & {
    [START_OPTIONS_KEY_SECRET_SYMBOL]?: Buffer;
  };
  globalState[START_OPTIONS_KEY_SECRET_SYMBOL] ??= randomBytes(32);
  return globalState[START_OPTIONS_KEY_SECRET_SYMBOL];
}
