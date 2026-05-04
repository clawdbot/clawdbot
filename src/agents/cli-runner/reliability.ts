import path from "node:path";
import type { CliBackendConfig } from "../../config/types.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
  CLI_WATCHDOG_MIN_TIMEOUT_MS,
} from "../cli-watchdog-defaults.js";
import type { EmbeddedRunTrigger } from "../pi-embedded-runner/run/params.js";

function pickWatchdogProfile(
  backend: CliBackendConfig,
  useResume: boolean,
  trigger?: EmbeddedRunTrigger,
): {
  noOutputTimeoutMs?: number;
  noOutputTimeoutRatio: number;
  minMs: number;
  maxMs: number;
} {
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;
  const defaults =
    trigger === "cron" && useResume && !configured
      ? CLI_FRESH_WATCHDOG_DEFAULTS
      : useResume
        ? CLI_RESUME_WATCHDOG_DEFAULTS
        : CLI_FRESH_WATCHDOG_DEFAULTS;

  const ratio = (() => {
    const value = configured?.noOutputTimeoutRatio;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.noOutputTimeoutRatio;
    }
    return Math.max(0.05, Math.min(0.95, value));
  })();
  const minMs = (() => {
    const value = configured?.minMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.minMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();
  const maxMs = (() => {
    const value = configured?.maxMs;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return defaults.maxMs;
    }
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(value));
  })();

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === "number" &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
  trigger?: EmbeddedRunTrigger;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume, params.trigger);
  // Keep watchdog below global timeout in normal cases.
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  if (profile.noOutputTimeoutMs !== undefined) {
    return Math.min(profile.noOutputTimeoutMs, cap);
  }
  const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
  const bounded = Math.min(profile.maxMs, Math.max(profile.minMs, computed));
  return Math.min(bounded, cap);
}

export function buildCliSupervisorScopeKey(params: {
  backend: CliBackendConfig;
  backendId: string;
  cliSessionId?: string;
}): string | undefined {
  const commandToken = normalizeLowercaseStringOrEmpty(path.basename(params.backend.command ?? ""));
  const backendToken = normalizeLowercaseStringOrEmpty(params.backendId);
  const sessionToken = params.cliSessionId?.trim();
  if (!sessionToken) {
    return undefined;
  }
  return `cli:${backendToken}:${commandToken}:${sessionToken}`;
}
