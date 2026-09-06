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
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTarget } from "../../gateway/session-utils.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  classifySessionKeyShape,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { resolveAgentSessionDirs } from "../session-dirs.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";

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

export async function resolveRestartRecoveryStorePaths(
  params: Parameters<typeof discoverRestartRecoveryStorePaths>[0],
): Promise<string[]> {
  const stateDir = params.stateDir ?? resolveStateDir(process.env);
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  // Startup recovery needs running rows; shutdown must also mark queued turns
  // whose session still carries a prior terminal status.
  return (await discoverRestartRecoveryStorePaths(params)).filter((storePath) =>
    hasSessionEntriesByStatusReadOnly({ env, storePath }, ["running"]),
  );
}

export function resolveRestartRecoveryDispatchTarget(params: {
  cfg?: OpenClawConfig;
  sessionKey: string;
  storePath: string;
}): { agentId: string; sessionKey: string } | undefined {
  // Global keys lose their agent prefix; the canonical per-agent store still owns it.
  // Fixed stores and qualified aliases retain their existing logical-owner route.
  const storeAgentId =
    isPerAgentSessionStoreConfig(params.cfg?.session?.store) &&
    classifySessionKeyShape(params.sessionKey) === "legacy_or_alias"
      ? resolveUnsuffixedSqliteTargetFromSessionStorePath(params.storePath).agentId
      : undefined;
  if (!params.cfg) {
    return {
      agentId: resolveAgentIdFromSessionKey(
        params.sessionKey,
        storeAgentId ?? LEGACY_IMPLICIT_AGENT_ID,
      ),
      sessionKey: params.sessionKey,
    };
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.sessionKey,
      ...(storeAgentId ? { agentId: storeAgentId } : {}),
    });
    return !params.cfg.session?.store ||
      path.resolve(target.storePath) === path.resolve(params.storePath)
      ? { agentId: target.agentId, sessionKey: target.canonicalKey }
      : undefined;
  } catch (err) {
    mainSessionRecoveryLog.warn(
      `failed to resolve recovery store for ${params.sessionKey}: ${String(err)}`,
    );
    return undefined;
  }
}

/** Captures the durable continuation that a completed requester turn yielded to. */
export function captureYieldedMainSessionContinuation(params: {
  cfg?: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): (() => boolean) | undefined {
  // A prepared final may not have reached its queue yet; main recovery still owns that debt.
  if (
    params.entry.status !== "running" ||
    params.entry.pendingFinalDelivery !== undefined ||
    normalizeFiniteTimestamp(params.entry.endedAt) === undefined
  ) {
    return undefined;
  }
  const requester = resolveRestartRecoveryDispatchTarget(params);
  if (!requester) {
    return undefined;
  }
  const listRuns = () =>
    listSubagentRunsForRequester(requester.sessionKey, {
      requesterAgentId: requester.agentId,
    });
  const owner = listRuns().find(
    (run) =>
      !run.collect &&
      run.expectsCompletionMessage === true &&
      !run.requesterTurnRunId &&
      run.requesterSettleWake?.requesterYieldBatch === true &&
      run.requesterSettleWake.rearmGeneration !== undefined &&
      run.requesterSettleWake.batchRunIds?.includes(run.runId),
  );
  if (!owner) {
    return undefined;
  }
  // The wake is pending/dispatching debt; completion removes it even for an abandoned batch.
  // Child delivery alone does not settle the visible final owed by a yielded requester.
  const wake = owner.requesterSettleWake;
  const rearmGeneration = wake?.rearmGeneration;
  return () =>
    listRuns().includes(owner) &&
    !owner.requesterTurnRunId &&
    owner.requesterSettleWake === wake &&
    wake?.rearmGeneration === rearmGeneration;
}
