// Plugin-managed reserved spawn adapter. Service-specific lease state stays in plugins.
import { randomUUID } from "node:crypto";
import { parseExecApprovalFollowupApprovalId } from "../agents/bash-tools.exec-approval-followup-state.js";
import {
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
} from "../agents/subagent-registry.js";
import { cleanupProvisionalSession } from "../agents/subagent-spawn-cleanup.js";
import type { SpawnSubagentResult } from "../agents/subagent-spawn-contract.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { isValidAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { reserveReservedSubagentDedupeEntry } from "./server-methods/agent-dedupe.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";

type ReservedSubagentIdentityClaims = {
  runIds: Set<string>;
  childSessionKeys: Set<string>;
};

type ReservedSubagentCleanupHolder = {
  timer?: ReturnType<typeof setTimeout>;
  release: () => void;
};

const RESERVED_SUBAGENT_IDENTITY_CLAIMS_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntime.reservedSubagentIdentityClaims",
);
const RESERVED_SUBAGENT_CLEANUP_HOLDERS_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntime.reservedSubagentCleanupHolders",
);

function reservedSubagentCleanupHolderKey(params: {
  runId: string;
  childSessionKey: string;
}): string {
  return `${params.runId}\0${params.childSessionKey}`;
}

function retainReservedSubagentCleanupHolder(params: {
  runId: string;
  childSessionKey: string;
  releaseGatewayDedupeReservation: () => void;
  releaseIdentityClaim: () => void;
}): void {
  const holders = resolveGlobalSingleton<Map<string, ReservedSubagentCleanupHolder>>(
    RESERVED_SUBAGENT_CLEANUP_HOLDERS_KEY,
    () => new Map(),
  );
  const key = reservedSubagentCleanupHolderKey(params);
  if (holders.has(key)) {
    return;
  }
  let released = false;
  const holder: ReservedSubagentCleanupHolder = {
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (holder.timer) {
        clearTimeout(holder.timer);
      }
      holders.delete(key);
      params.releaseGatewayDedupeReservation();
      params.releaseIdentityClaim();
    },
  };
  const retryDelayMs = isFastTestRuntimeEnv() ? 1 : 1_000;
  const retryDeletion = async () => {
    if (released) {
      return;
    }
    const deleted = await cleanupProvisionalSession(params.childSessionKey, {
      emitLifecycleHooks: false,
      deleteTranscript: true,
    });
    if (deleted) {
      holder.release();
      return;
    }
    holder.timer = setTimeout(() => {
      void retryDeletion();
    }, retryDelayMs);
    holder.timer.unref?.();
  };
  holders.set(key, holder);
  holder.timer = setTimeout(() => {
    void retryDeletion();
  }, retryDelayMs);
  holder.timer.unref?.();
}

function hasIndeterminateReservedCleanup(result: SpawnSubagentResult): boolean {
  return result.reservedCleanup?.sessionDeletion === "indeterminate";
}

function claimReservedSubagentIdentities(params: { runId: string; childSessionKey: string }): {
  claimToken: string;
  release: () => void;
} {
  const claims = resolveGlobalSingleton<ReservedSubagentIdentityClaims>(
    RESERVED_SUBAGENT_IDENTITY_CLAIMS_KEY,
    () => ({
      runIds: new Set(),
      childSessionKeys: new Set(),
    }),
  );
  if (claims.runIds.has(params.runId)) {
    throw new Error("reserved subagent runId is already claimed.");
  }
  if (claims.childSessionKeys.has(params.childSessionKey)) {
    throw new Error("reserved subagent childSessionKey is already claimed.");
  }
  claims.runIds.add(params.runId);
  claims.childSessionKeys.add(params.childSessionKey);
  const claimToken = randomUUID();
  let released = false;
  return {
    claimToken,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      claims.runIds.delete(params.runId);
      claims.childSessionKeys.delete(params.childSessionKey);
    },
  };
}

function assertReservedSubagentIdentitiesAvailable(params: {
  runId: string;
  childSessionKey: string;
}): void {
  if (getAgentRunContext(params.runId)) {
    throw new Error("reserved subagent runId is already active.");
  }
  if (hasSubagentRunIdentity(params.runId)) {
    throw new Error("reserved subagent runId already exists.");
  }
  if (getLatestSubagentRunByChildSessionKey(params.childSessionKey)) {
    throw new Error("reserved subagent childSessionKey already exists.");
  }
}

export const spawnReservedSubagent: PluginRuntime["subagent"]["spawnReserved"] = async (params) => {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId =
    typeof scope?.pluginId === "string" && scope.pluginId.trim()
      ? scope.pluginId.trim()
      : undefined;
  if (!pluginId) {
    throw new Error("spawnReserved requires an active plugin runtime scope.");
  }
  const requesterSessionKey = params.requesterSessionKey.trim();
  const targetAgentId = params.targetAgentId.trim();
  const childSessionKey = params.childSessionKey.trim();
  const runId = params.runId.trim();
  const task = params.task.trim();
  if (
    requesterSessionKey !== params.requesterSessionKey ||
    normalizeSessionKeyPreservingOpaquePeerIds(requesterSessionKey) !== requesterSessionKey ||
    !parseAgentSessionKey(requesterSessionKey)
  ) {
    throw new Error("spawnReserved requesterSessionKey must be a canonical agent session key.");
  }
  if (targetAgentId !== params.targetAgentId || !isValidAgentId(targetAgentId)) {
    throw new Error("spawnReserved targetAgentId is invalid.");
  }
  if (
    !childSessionKey ||
    childSessionKey !== params.childSessionKey ||
    normalizeSessionKeyPreservingOpaquePeerIds(childSessionKey) !== childSessionKey ||
    !runId ||
    runId !== params.runId
  ) {
    throw new Error("spawnReserved childSessionKey and runId must be non-empty canonical values.");
  }
  if (parseExecApprovalFollowupApprovalId(runId)) {
    throw new Error("spawnReserved runId uses a backend-reserved namespace.");
  }
  if (!task) {
    throw new Error("spawnReserved task must be non-empty.");
  }
  const gatewayContext = scope?.context ?? getFallbackGatewayContext();
  if (!gatewayContext) {
    throw new Error("spawnReserved requires a live Gateway context.");
  }
  const identityClaim = claimReservedSubagentIdentities({
    runId,
    childSessionKey,
  });
  let releaseGatewayDedupeReservation = () => {};
  let releaseClaimsOnReturn = true;
  try {
    assertReservedSubagentIdentitiesAvailable({
      runId,
      childSessionKey,
    });
    releaseGatewayDedupeReservation = reserveReservedSubagentDedupeEntry({
      dedupe: gatewayContext.dedupe,
      runId,
      sessionKey: childSessionKey,
      pluginRuntimeOwnerId: pluginId,
      claimToken: identityClaim.claimToken,
    });
    const { spawnSubagentDirect } = await import("../agents/subagent-spawn.js");
    const result = await spawnSubagentDirect(
      {
        task,
        agentId: targetAgentId,
        ...(params.taskName !== undefined ? { taskName: params.taskName } : {}),
        ...(params.label !== undefined ? { label: params.label } : {}),
        mode: "run",
        ...(params.cleanup !== undefined ? { cleanup: params.cleanup } : {}),
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.lightContext !== undefined ? { lightContext: params.lightContext } : {}),
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: requesterSessionKey,
        authorizedTargetAgentId: targetAgentId,
        preallocatedChildSessionKey: childSessionKey,
        preallocatedRunId: runId,
        pluginOwnerId: pluginId,
        reservedSubagentClaimToken: identityClaim.claimToken,
      },
    );
    if (result.status !== "accepted") {
      if (hasIndeterminateReservedCleanup(result)) {
        retainReservedSubagentCleanupHolder({
          runId,
          childSessionKey,
          releaseGatewayDedupeReservation,
          releaseIdentityClaim: identityClaim.release,
        });
        releaseClaimsOnReturn = false;
      }
      throw new Error(result.error?.trim() || `reserved subagent spawn ${result.status}`);
    }
    if (result.childSessionKey !== childSessionKey || result.runId !== runId) {
      throw new Error("reserved subagent spawn returned different child or run identities.");
    }
    return {
      childSessionKey: result.childSessionKey,
      runId: result.runId,
      mode: "run",
    };
  } finally {
    if (releaseClaimsOnReturn) {
      releaseGatewayDedupeReservation();
      identityClaim.release();
    }
  }
};
