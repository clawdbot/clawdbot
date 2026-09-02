import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAbortError } from "../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { registerAgentRunCapacityWait } from "../infra/agent-run-capacity-wait.js";
import { retainQueuedAgentRunContext } from "../infra/agent-run-registry.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { resolveSessionLane } from "./embedded-agent-runner/lanes.js";
import { resolveEmbeddedRunSessionLanePolicy } from "./embedded-agent-runner/run/lane-runtime.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import type { SandboxContext } from "./sandbox/types.js";
import { settleRequesterAfterSessionSpawns } from "./subagents/registry/subagent-registry.js";

export type LocalTurnPlacementClaim = {
  sessionId: string;
  agentId?: string;
  sessionKey?: string;
  runId: string;
};

export type SessionPlacementTurnParams = RunEmbeddedAgentParams & { sessionFile: string };

type SessionPlacementSandboxParams = {
  agentId: string;
  config?: OpenClawConfig;
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
};

export type SessionPlacementAdmissionProvider = {
  assertCompactionSuccessorAllowed: (params: {
    currentTarget: SessionTranscriptRuntimeTarget;
    successorSessionId: string;
  }) => void;
  recoverTerminalTurn?: (session: { sessionId: string; sessionKey?: string }) => string | undefined;
  executeLocalTurn: <T>(claim: LocalTurnPlacementClaim, runLocal: () => Promise<T>) => Promise<T>;
  executeTurn: (
    claim: LocalTurnPlacementClaim,
    params: SessionPlacementTurnParams,
    runLocal: () => Promise<EmbeddedAgentRunResult>,
    onAdmitted?: () => void,
  ) => Promise<EmbeddedAgentRunResult>;
};

type PlacementSandboxAdmissionProvider = SessionPlacementAdmissionProvider & {
  resolveSandbox?: (params: SessionPlacementSandboxParams) => Promise<SandboxContext | null>;
};

type SessionPlacementAdmissionState = {
  provider?: PlacementSandboxAdmissionProvider;
};

// Runtime chunks share one provider. The identity guard keeps an older gateway
// shutdown from clearing a newer lifecycle's admission gate.
const state = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPlacementAdmissionState"),
  (): SessionPlacementAdmissionState => ({}),
);
export function installSessionPlacementAdmissionProvider(
  provider: SessionPlacementAdmissionProvider,
): () => void {
  state.provider = provider as PlacementSandboxAdmissionProvider;
  return () => {
    if (state.provider === provider) {
      state.provider = undefined;
    }
  };
}

/** Captures the exact placement owner, including standalone absence, before awaited work. */
export function captureSessionPlacementCompactionSuccessorAssertion(): SessionPlacementAdmissionProvider["assertCompactionSuccessorAllowed"] {
  const provider = state.provider;
  return (params) => {
    if (state.provider !== provider) {
      throw new Error("session placement owner changed during compaction successor acceptance");
    }
    provider?.assertCompactionSuccessorAllowed(params);
  };
}

export async function withSessionPlacementTurnAdmission(
  claim: LocalTurnPlacementClaim,
  params: SessionPlacementTurnParams,
  task: () => Promise<EmbeddedAgentRunResult>,
  onAdmitted?: () => void,
): Promise<EmbeddedAgentRunResult> {
  let admitted = false;
  const admitTurn = () => {
    if (admitted) {
      return;
    }
    admitted = true;
    onAdmitted?.();
  };
  // Providers may execute locally or remotely; both must release queue ownership
  // only when their actual execution path has acquired its placement claim.
  const runAdmittedLocalTurn = () => {
    admitTurn();
    return task();
  };
  const provider = state.provider;
  const result = provider
    ? await provider.executeTurn(claim, params, runAdmittedLocalTurn, admitTurn)
    : await runAdmittedLocalTurn();
  if (result.meta.executionTrace?.runner === "cli") {
    settleYieldedRequesterAfterPlacementRelease(claim, result);
  }
  return result;
}

/** Serializes direct CLI turns with every runtime before acquiring placement ownership. */
export async function withLocalSessionPlacementTurnSettlement(
  claim: LocalTurnPlacementClaim,
  task: () => Promise<EmbeddedAgentRunResult>,
  options: Pick<
    RunEmbeddedAgentParams,
    "abortSignal" | "lifecycleGeneration" | "trigger" | "inputProvenance"
  > = {},
): Promise<EmbeddedAgentRunResult> {
  const provider = state.provider;
  const lifecycleGeneration =
    options.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(claim.runId);
  const assertCurrent = () => {
    if (options.abortSignal?.aborted) {
      throw options.abortSignal.reason instanceof Error
        ? options.abortSignal.reason
        : createAbortError("Operation aborted", { cause: options.abortSignal.reason });
    }
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    if (state.provider !== provider) {
      throw createAbortError("session placement owner changed during turn admission");
    }
  };
  assertCurrent();
  const releaseQueuedContext = retainQueuedAgentRunContext(claim.runId, lifecycleGeneration);
  let releaseCapacityWait: (() => void) | undefined;
  try {
    return await enqueueCommandInLane(
      resolveSessionLane(claim.sessionKey?.trim() || claim.sessionId),
      async () => {
        assertCurrent();
        const runLocal = () => {
          // Placement admission can itself await work. A cancelled or replaced
          // queue owner must never execute through the captured provider.
          assertCurrent();
          releaseCapacityWait?.();
          releaseQueuedContext?.("admitted");
          return task();
        };
        const result = provider
          ? await provider.executeLocalTurn(claim, runLocal)
          : await runLocal();
        settleYieldedRequesterAfterPlacementRelease(claim, result);
        return result;
      },
      {
        priority: resolveEmbeddedRunSessionLanePolicy(options.trigger, options.inputProvenance)
          .priority,
        onQueued: () => {
          releaseCapacityWait = registerAgentRunCapacityWait(claim.runId, lifecycleGeneration);
        },
      },
    );
  } finally {
    releaseCapacityWait?.();
    releaseQueuedContext?.("abandoned");
  }
}

function settleYieldedRequesterAfterPlacementRelease(
  claim: LocalTurnPlacementClaim,
  result: EmbeddedAgentRunResult,
): void {
  if (!claim.sessionKey || result.meta.yielded !== true || !result.acceptedSessionSpawns?.length) {
    return;
  }
  settleRequesterAfterSessionSpawns({
    requesterSessionKey: claim.sessionKey,
    requesterAgentId: claim.agentId,
    requesterTurnRunId: claim.runId,
    requesterYielded: true,
    acceptedSessionSpawns: result.acceptedSessionSpawns,
  });
}

/** Resolves an authoritative sandbox only when the live placement owns remote execution. */
export async function resolveSessionPlacementSandbox(
  params: SessionPlacementSandboxParams,
): Promise<SandboxContext | null> {
  return (await state.provider?.resolveSandbox?.(params)) ?? null;
}

/** The current placement owner alone can settle a proven terminal worker turn. */
export function recoverTerminalSessionPlacementTurn(session: {
  sessionId: string;
  sessionKey?: string;
}): string | undefined {
  return state.provider?.recoverTerminalTurn?.(session);
}
