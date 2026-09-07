import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../../config/paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
  resolveAllAgentSessionStoreTargetsSync,
} from "../../config/sessions.js";
import { hasSessionEntriesByStatusReadOnly } from "../../config/sessions/session-accessor.js";
import { listDurableSqliteTargetOwnersForSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveAgentSessionDirs } from "../session-dirs.js";

export const mainSessionRecoveryLog = createSubsystemLogger("main-session-restart-recovery");
export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const MAX_RECOVERY_RETRIES = 3;
export const RETRY_BACKOFF_MULTIPLIER = 2;
export type ExpectedRestartRecoveryTarget = {
  canonicalSessionKey?: string;
  sessionId: string;
  sessionKey: string;
};

export type ExhaustedRestartRecoveryTarget = ExpectedRestartRecoveryTarget & {
  storePath: string;
  /** Durable SQLite owner partition that owns the exhausted row. */
  agentId?: string;
};

export function resolveRestartRecoveryTerminalClientRunId(
  entry: Pick<SessionEntry, "restartRecoveryDeliverySourceRunId" | "restartRecoverySourceIngress">,
): string | undefined {
  return entry.restartRecoverySourceIngress === "control-ui"
    ? normalizeOptionalString(entry.restartRecoveryDeliverySourceRunId)
    : undefined;
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

export const normalizeFiniteTimestamp = asFiniteNumber;

type RestartRecoveryStoreTarget = {
  storePath: string;
  /** Durable SQLite owner partition that contains running rows. Undefined means the store's default owner. */
  agentId?: string;
};

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

export async function discoverRestartRecoveryStorePaths(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
}): Promise<string[]> {
  const storePaths = new Set<string>();
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  if (params.cfg) {
    // Recovery must not reopen a deleted or otherwise unconfigured agent database merely
    // because its old directory still exists on disk. Those stores are intentionally fenced
    // by the deletion journal, and stale auth-probe directories are not agent roster entries.
    const configuredAgentIds = listConfiguredSessionStoreAgentIds(params.cfg);
    const configuredStorePaths = new Set(
      configuredAgentIds.map((agentId) =>
        path.resolve(resolveSessionStorePathCore(params.cfg?.session?.store, { agentId, env })),
      ),
    );
    const configuredAgentIdSet = new Set(configuredAgentIds);
    for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env })) {
      const storePath = path.resolve(target.storePath);
      // Fixed configured stores can retain a durable owner whose ID differs from the
      // current roster entry. The validated path is the configuration fact; the target's
      // owner label is not evidence that the path itself is unconfigured.
      if (!configuredAgentIdSet.has(target.agentId) && !configuredStorePaths.has(storePath)) {
        continue;
      }
      storePaths.add(storePath);
    }
  } else {
    for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
      storePaths.add(path.join(sessionsDir, "sessions.json"));
    }
  }
  return [...storePaths].toSorted((a, b) => a.localeCompare(b));
}

export async function resolveRestartRecoveryStorePaths(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
}): Promise<RestartRecoveryStoreTarget[]> {
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  // Startup recovery needs running rows; shutdown must also mark queued turns
  // whose session still carries a prior terminal status.
  // Agent databases also hold auth and model-catalog state. Enter the writer
  // lane only when the session owner proves that a running row may need repair.
  // Fixed stores partition rows across per-agent SQLite siblings, so a running
  // session under any durable owner keeps the store in the recovery scan.
  const targets: RestartRecoveryStoreTarget[] = [];
  for (const storePath of await discoverRestartRecoveryStorePaths(params)) {
    const owners = listDurableSqliteTargetOwnersForSessionStorePath(storePath);
    if (owners.length === 0) {
      if (hasSessionEntriesByStatusReadOnly({ env, storePath }, ["running"])) {
        targets.push({ storePath });
      }
      continue;
    }
    for (const agentId of owners) {
      if (hasSessionEntriesByStatusReadOnly({ env, storePath, agentId }, ["running"])) {
        targets.push({ storePath, agentId });
      }
    }
  }
  return targets.toSorted((a, b) => {
    const byPath = a.storePath.localeCompare(b.storePath);
    return byPath !== 0 ? byPath : (a.agentId ?? "").localeCompare(b.agentId ?? "");
  });
}
