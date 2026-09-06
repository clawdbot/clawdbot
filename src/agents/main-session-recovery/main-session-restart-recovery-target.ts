import path from "node:path";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveUnsuffixedSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
import { isPerAgentSessionStoreConfig } from "../../config/sessions/session-store-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewaySessionStoreTarget } from "../../gateway/session-utils-store-lookup.js";
import {
  LEGACY_IMPLICIT_AGENT_ID,
  classifySessionKeyShape,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { listSubagentRunsForRequester } from "../subagents/registry/subagent-registry-read.js";
import {
  mainSessionRecoveryLog,
  normalizeFiniteTimestamp,
} from "./main-session-restart-recovery-shared.js";

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
