import type { WorkerLiveEventParams } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { setActiveEmbeddedRunLifecycleGeneration } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
  type EmbeddedAgentQueueHandle,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createAgentRunRestartAbortError,
  createAgentRunSupersededAbortError,
} from "../../agents/run-termination.js";
import type { SessionPlacementTurnParams } from "../../agents/session-placement-admission.js";
import {
  getAgentEventLifecycleGeneration,
  isAgentEventLifecycleGenerationCurrent,
} from "../../infra/agent-events.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
  markDiagnosticOwnedToolActivity,
  markDiagnosticRunProgress,
} from "../../logging/diagnostic-run-activity.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { sameWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";

export type ActiveWorkerTurn = {
  claim: WorkerSessionTurnClaim;
  sessionKey: string;
  signal: AbortSignal;
  recoverTerminal?: () => string | undefined;
  dispose: () => void;
};

type WorkerRunOwner = {
  claim: WorkerSessionTurnClaim;
  record: (event: WorkerLiveEventParams["event"]) => void;
};

const activeOwners = new Map<string, WorkerRunOwner>();

export function createWorkerTurnRunOwner(params: {
  placements: WorkerSessionPlacementStore;
  claim: WorkerSessionTurnClaim;
  turn: SessionPlacementTurnParams;
  sessionKey: string;
}): ActiveWorkerTurn {
  const { claim, turn, sessionKey } = params;
  const controller = new AbortController();
  const signal = turn.abortSignal
    ? AbortSignal.any([turn.abortSignal, controller.signal])
    : controller.signal;
  let closed = false;
  const lifecycleGeneration = turn.lifecycleGeneration ?? getAgentEventLifecycleGeneration();
  const startedAtMs = Date.now();
  const deadlineAtMs = startedAtMs + turn.timeoutMs;
  const diagnosticOwner = createDiagnosticEmbeddedRunOwner({
    sessionId: claim.sessionId,
    sessionKey,
    runId: claim.runId,
  });
  const cancel = (reason?: "user_abort" | "restart" | "superseded") => {
    controller.abort(
      reason === "restart"
        ? createAgentRunRestartAbortError()
        : reason === "superseded"
          ? createAgentRunSupersededAbortError()
          : undefined,
    );
  };
  const owner: WorkerRunOwner = {
    claim,
    record: (event) => {
      if (
        activeOwners.get(claim.sessionId) !== owner ||
        signal.aborted ||
        !isAgentEventLifecycleGenerationCurrent(lifecycleGeneration) ||
        !params.placements.validateTurnClaim(claim)
      ) {
        return;
      }
      if (event.kind === "tool" && event.payload.phase !== "update") {
        markDiagnosticOwnedToolActivity(diagnosticOwner, {
          toolName: event.payload.name,
          toolCallId: event.payload.toolCallId,
          phase: event.payload.phase === "start" ? "start" : "end",
          // The host owns this already-enforced run budget. A remote tool cannot
          // choose an exemption or extend its parent while provisioning a child.
          deadlineAtMs,
        });
      } else {
        markDiagnosticRunProgress({
          sessionId: claim.sessionId,
          sessionKey,
          runId: claim.runId,
          reason: `worker:${event.kind}`,
        });
      }
    },
  };
  const queueMessage = async () => {
    throw new Error("Cloud worker turns do not support message injection");
  };
  const handle = {
    kind: "embedded",
    runId: claim.runId,
    startedAtMs,
    diagnosticOwner,
    closeDiagnostics: () => {
      closed = true;
      closeDiagnosticEmbeddedRunOwner(diagnosticOwner);
      if (activeOwners.get(claim.sessionId) === owner) {
        activeOwners.delete(claim.sessionId);
      }
    },
    queueMessage,
    messageInjection: { isAvailable: () => false, queueMessage },
    isStreaming: () => false,
    isStopped: () => closed || signal.aborted,
    isAborted: () => signal.aborted,
    isAbortable: () => !closed && !signal.aborted,
    isCompacting: () => false,
    cancel,
    abort: cancel,
  } satisfies EmbeddedAgentQueueHandle;
  setActiveEmbeddedRunLifecycleGeneration(handle, lifecycleGeneration);
  turn.replyOperation?.attachBackend(handle);
  setActiveEmbeddedRun(claim.sessionId, handle, sessionKey, turn.sessionFile, turn.agentId);
  if (!signal.aborted) {
    activeOwners.set(claim.sessionId, owner);
  }
  return {
    claim,
    sessionKey,
    signal,
    dispose: () => clearActiveEmbeddedRun(claim.sessionId, handle, sessionKey, turn.sessionFile),
  };
}

// Capture before buffering or notifying listeners: neither a reused run ID nor
// a replacement owner may receive an earlier turn's delayed diagnostic event.
export function captureWorkerTurnDiagnosticRecorder(identity: WorkerConnectionIdentity) {
  const owner = identity.sessionId ? activeOwners.get(identity.sessionId) : undefined;
  return owner &&
    identity.turnClaim?.owner.kind === "worker" &&
    sameWorkerSessionTurnClaim(owner.claim, identity.turnClaim)
    ? owner.record
    : undefined;
}
