import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import type { SpawnSubagentMode } from "./subagent-spawn.types.js";

export function createSubagentSpawnLifecycleEmitter(params: {
  hookRunner: SubagentLifecycleHookRunner | null;
  childSessionKey: string;
  requesterInternalKey: string;
  progressOrigin: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
    channelId?: string;
    messageId?: string | number;
  };
  targetAgentId: string;
  label?: string;
  requesterOrigin?: DeliveryContext;
  requestThreadBinding: boolean;
  spawnMode: SpawnSubagentMode;
  resolvedModelMetadata: {
    resolvedModel?: string;
    resolvedProvider?: string;
  };
}): (hookRunId: string) => Promise<void> {
  // "spawned"/"started" hooks mean an accepted Gateway run. Direct runs emit
  // after the shared pipeline; queued collectors emit from the scheduler start.
  return async (hookRunId: string) => {
    if (params.hookRunner?.hasHooks("subagent_progress")) {
      try {
        await params.hookRunner.runSubagentProgress(
          {
            phase: "started",
            runId: hookRunId,
            childSessionKey: params.childSessionKey,
            requester: params.progressOrigin,
          },
          {
            runId: hookRunId,
            childSessionKey: params.childSessionKey,
            requesterSessionKey: params.requesterInternalKey,
          },
        );
      } catch {
        // Presentation hooks are best-effort after durable registration.
      }
    }
    if (params.hookRunner?.hasHooks("subagent_spawned")) {
      try {
        await params.hookRunner.runSubagentSpawned(
          {
            runId: hookRunId,
            childSessionKey: params.childSessionKey,
            agentId: params.targetAgentId,
            label: params.label,
            requester: {
              channel: params.requesterOrigin?.channel,
              accountId: params.requesterOrigin?.accountId,
              to: params.requesterOrigin?.to,
              threadId: params.requesterOrigin?.threadId,
            },
            threadRequested: params.requestThreadBinding,
            mode: params.spawnMode,
            ...params.resolvedModelMetadata,
          },
          {
            runId: hookRunId,
            childSessionKey: params.childSessionKey,
            requesterSessionKey: params.requesterInternalKey,
          },
        );
      } catch {
        // Spawn stays accepted if lifecycle presentation fails.
      }
    }
  };
}
