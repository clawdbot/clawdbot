import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  listConfiguredSessionStoreAgentIds,
  resolveStorePath,
  type InternalSessionEntry as SessionEntry,
  resolveAllAgentSessionStoreTargetsSync,
} from "../../config/sessions.js";
import {
  hasSessionEntriesByStatusReadOnly,
  type SessionTranscriptTurnExpectedState,
} from "../../config/sessions/session-accessor.js";
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
};

export function buildRestartRecoveryExpectedState(
  entry: SessionEntry,
  mainRestartRecovery?: { cycleId: string; revision: number },
): SessionTranscriptTurnExpectedState {
  const expectedMainRestartRecovery = mainRestartRecovery ?? entry.mainRestartRecovery;
  return {
    abortedLastRun: entry.abortedLastRun,
    mainRestartRecoveryCycleId: expectedMainRestartRecovery?.cycleId,
    mainRestartRecoveryRevision: expectedMainRestartRecovery?.revision,
    restartRecoveryBeforeAgentReplyState: entry.restartRecoveryBeforeAgentReplyState,
    restartRecoveryDeliveryReceiptState: entry.restartRecoveryDeliveryReceiptState,
    restartRecoveryDeliveryToolCallId: entry.restartRecoveryDeliveryToolCallId,
    restartRecoveryDeliveryRequestFingerprint: entry.restartRecoveryDeliveryRequestFingerprint,
    restartRecoveryDeliveryRunId: entry.restartRecoveryDeliveryRunId,
    restartRecoveryDeliverySourceRunId: entry.restartRecoveryDeliverySourceRunId,
    restartRecoveryRequesterAccountId: entry.restartRecoveryRequesterAccountId,
    restartRecoveryRequesterSenderId: entry.restartRecoveryRequesterSenderId,
    restartRecoverySameChannelThreadRequired: entry.restartRecoverySameChannelThreadRequired,
    restartRecoverySourceIngress: entry.restartRecoverySourceIngress,
    restartRecoverySourceReplyDeliveryMode: entry.restartRecoverySourceReplyDeliveryMode,
    restartRecoveryTerminalRunIds: entry.restartRecoveryTerminalRunIds,
    status: entry.status,
  };
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
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  if (params.cfg) {
    // Recovery must not reopen a deleted or otherwise unconfigured agent database merely
    // because its old directory still exists on disk. Those stores are intentionally fenced
    // by the deletion journal, and stale auth-probe directories are not agent roster entries.
    const configuredAgentIds = listConfiguredSessionStoreAgentIds(params.cfg);
    const configuredStorePaths = new Set(
      configuredAgentIds.map((agentId) =>
        path.resolve(resolveStorePath(params.cfg?.session?.store, { agentId, env })),
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
  // Agent databases also hold auth and model-catalog state. Enter the writer
  // lane only when the session owner proves that a running row may need repair.
  return [...storePaths]
    .filter((storePath) => hasSessionEntriesByStatusReadOnly({ env, storePath }, ["running"]))
    .toSorted((a, b) => a.localeCompare(b));
}
