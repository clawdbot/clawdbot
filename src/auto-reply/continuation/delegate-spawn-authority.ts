import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  SpawnSubagentAdmissionCancelledError,
  type SpawnSubagentAdmissionAuthority,
} from "../../agents/subagents/spawn/subagent-spawn-contract.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import { registerContinuationDispatchClaim } from "./continuation-dispatch-claims.js";
import {
  revalidatePendingDelegateForSpawn,
  type DelegateSpawnFenceController,
} from "./delegate-store.js";

type DelegateClaim = {
  flowId?: string;
  expectedRevision?: number;
  task: string;
};

type OwnerLifecycleIdentity = Pick<SessionEntry, "lifecycleRevision" | "sessionId">;

export function createContinuationOwnerSessionLoader(
  ownerSessionKey: string,
): () => SessionEntry | undefined {
  const cfg = getRuntimeConfig();
  const agentId = resolveSessionAgentId({ sessionKey: ownerSessionKey, config: cfg });
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  return () => loadSessionEntry({ storePath, sessionKey: ownerSessionKey });
}

export function registerContinuationDelegateDispatchClaim(params: {
  controller: DelegateSpawnFenceController;
  delegate: DelegateClaim;
  loadOwnerSessionEntry: () => SessionEntry | undefined;
  ownerSessionKey: string;
}): {
  authority: SpawnSubagentAdmissionAuthority;
  release: () => void;
} {
  const { flowId, expectedRevision } = params.delegate;
  if (!flowId || expectedRevision === undefined) {
    throw new SpawnSubagentAdmissionCancelledError(
      "Continuation delegate source metadata is incomplete.",
    );
  }
  const activeClaim = registerContinuationDispatchClaim({
    sessionKey: params.ownerSessionKey,
    flowId,
  });
  const lifecycleGeneration = getAgentEventLifecycleGeneration();
  const ownerIdentity = params.loadOwnerSessionEntry();
  const assertCurrent = (): void => {
    if (
      activeClaim.controller.signal.aborted ||
      !activeClaim.isActive() ||
      !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration)
    ) {
      throw new SpawnSubagentAdmissionCancelledError("Continuation delegate admission closed.");
    }
    const fence = revalidatePendingDelegateForSpawn(params.delegate, params.controller);
    if (!fence.allowed) {
      throw new SpawnSubagentAdmissionCancelledError(fence.summary);
    }
    if (ownerIdentity) {
      const currentOwner = params.loadOwnerSessionEntry();
      if (!isSameOwnerLifecycle(currentOwner, ownerIdentity)) {
        throw new SpawnSubagentAdmissionCancelledError(
          "Continuation delegate source session lifecycle changed.",
        );
      }
    }
  };
  return {
    authority: {
      signal: activeClaim.controller.signal,
      source: {
        ownerSessionKey: params.ownerSessionKey,
        flowId,
        expectedRevision,
      },
      assertCurrent,
    },
    release: activeClaim.release,
  };
}

function isSameOwnerLifecycle(
  current: SessionEntry | undefined,
  expected: OwnerLifecycleIdentity,
): boolean {
  return (
    current?.sessionId === expected.sessionId &&
    current.lifecycleRevision === expected.lifecycleRevision
  );
}
