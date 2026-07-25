import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  type InternalSessionEntry as SessionEntry,
  resolveAllAgentSessionStoreTargetsSync,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isMainRestartRecoveryCandidate } from "./main-session-recovery-state.js";
import { resolveAgentSessionDirs } from "./session-dirs.js";

export const log = createSubsystemLogger("main-session-restart-recovery");
export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const MAX_RECOVERY_RETRIES = 3;
export const RETRY_BACKOFF_MULTIPLIER = 2;
export const UNRESUMABLE_SESSION_NOTICE =
  "I was interrupted by a gateway restart and couldn't safely resume the previous turn. " +
  "Please send that last request again and I'll pick it up cleanly.";

export type ExpectedRestartRecoveryTarget = {
  canonicalSessionKey?: string;
  sessionId: string;
  sessionKey: string;
};

export type ExhaustedRestartRecoveryTarget = ExpectedRestartRecoveryTarget & {
  storePath: string;
};

export function shouldSkipMainRecovery(entry: SessionEntry, sessionKey: string): boolean {
  return !isMainRestartRecoveryCandidate(entry, sessionKey);
}

export function normalizeStringSet(values: Iterable<string> | undefined): Set<string> {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

export function normalizeFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function hasCurrentProcessOwner(params: {
  activeSessionIds: Set<string>;
  activeSessionKeys: Set<string>;
  entry: SessionEntry;
  sessionKey: string;
}): boolean {
  if (params.activeSessionIds.has(params.entry.sessionId)) {
    return true;
  }
  return params.activeSessionIds.size === 0 && params.activeSessionKeys.has(params.sessionKey);
}

export async function resolveRestartRecoveryStorePaths(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
}): Promise<string[]> {
  const storePaths = new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
    storePaths.add(path.join(sessionsDir, "sessions.json"));
  }
  if (params.cfg) {
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
      storePaths.add(path.resolve(target.storePath));
    }
  }
  return [...storePaths].toSorted((a, b) => a.localeCompare(b));
}
