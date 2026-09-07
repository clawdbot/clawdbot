import path from "node:path";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStateDir } from "../../config/paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveSessionStorePathCore,
  type InternalSessionEntry as SessionEntry,
  resolveAllAgentSessionStoreTargetsSync,
  type SessionStoreTarget,
} from "../../config/sessions.js";
import { hasSessionEntriesByStatusReadOnly } from "../../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { LEGACY_IMPLICIT_AGENT_ID } from "../../routing/session-key.js";
import { resolveAgentSessionDirs } from "../session-dirs.js";

export const mainSessionRecoveryLog = createSubsystemLogger("main-session-restart-recovery");
export const DEFAULT_RECOVERY_DELAY_MS = 5_000;
export const MAX_RECOVERY_RETRIES = 3;
export const RETRY_BACKOFF_MULTIPLIER = 2;
export type ExpectedRestartRecoveryTarget = {
  agentId?: string;
  canonicalSessionKey?: string;
  sessionId: string;
  sessionKey: string;
};

export type ExhaustedRestartRecoveryTarget = ExpectedRestartRecoveryTarget & {
  storePath: string;
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

export async function discoverRestartRecoveryStoreTargets(params: {
  cfg?: OpenClawConfig;
  stateDir?: string;
  statuses?: Parameters<typeof hasSessionEntriesByStatusReadOnly>[1];
}): Promise<SessionStoreTarget[]> {
  const storeTargets: SessionStoreTarget[] = [];
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
      storeTargets.push({ ...target, storePath });
    }
  } else {
    for (const sessionsDir of await resolveAgentSessionDirs(stateDir)) {
      const storePath = path.join(sessionsDir, "sessions.json");
      storeTargets.push({
        agentId:
          resolveSqliteTargetFromSessionStorePath(storePath).agentId ?? LEGACY_IMPLICIT_AGENT_ID,
        storePath,
      });
    }
  }
  return storeTargets
    .filter(
      (target) =>
        !params.statuses || hasSessionEntriesByStatusReadOnly({ ...target, env }, params.statuses),
    )
    .toSorted(
      (a, b) => a.storePath.localeCompare(b.storePath) || a.agentId.localeCompare(b.agentId),
    );
}
