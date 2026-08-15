import type {
  WorkerConnectParams,
  WorkerLiveEventParams,
  WorkerProtocolCloseReason,
  WorkerSessionsSendParams,
  WorkerSessionsSpawnParams,
  WorkerSessionToolResult,
  WorkerTranscriptCommitErrorReason,
  WorkerTranscriptCommitParams,
  WorkerTranscriptCommitResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceCancelParams,
  WorkerInferenceCancelResult,
  WorkerInferenceErrorReason,
  WorkerInferenceStartParams,
  WorkerInferenceStartResult,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import type { WorkerSessionToolName } from "../../worker/tool-authority.js";
import {
  admitWorkerConnection,
  resolveLocalWorkerBuild,
  validateWorkerConnectionIdentity,
  type ExpectedWorkerBuild,
  type WorkerConnectionIdentity,
} from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createWorkerInferenceManager, type WorkerInferenceSink } from "./inference.js";
import type { WorkerLiveEventApplicationResult, WorkerLiveEventReceiver } from "./live-events.js";
import type {
  WorkerPlacementTurnBinding,
  WorkerSessionPlacementGate,
} from "./placement-worker-gate.js";
import type { WorkerEnvironmentStore } from "./store.js";

type WorkerProcessTurnBinding = WorkerPlacementTurnBinding & {
  credentialHash: string;
};

type WorkerTerminalTurnFence = WorkerProcessTurnBinding & {
  transcriptSeq: number;
  liveSeq: number;
};

type WorkerPendingTerminalTurnFence = WorkerProcessTurnBinding & {
  terminalLiveSeq: number;
};

type WorkerTurnRequest =
  | { kind: "inference" }
  | { kind: "live"; seq: number }
  | { kind: "transcript"; seq: number }
  | { kind: "session-tool" };

type WorkerTranscriptCommitApplicationResult =
  | { ok: true; result: WorkerTranscriptCommitResult }
  | { ok: false; reason: WorkerTranscriptCommitErrorReason };

type WorkerTranscriptCommitServiceResult =
  | WorkerTranscriptCommitApplicationResult
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerLiveEventServiceResult =
  | WorkerLiveEventApplicationResult
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerInferenceStartServiceResult =
  | {
      ok: true;
      result: WorkerInferenceStartResult;
      launch: () => void;
    }
  | { ok: false; reason: WorkerInferenceErrorReason }
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerInferenceCancelServiceResult =
  | { ok: true; result: WorkerInferenceCancelResult }
  | { ok: false; reason: WorkerInferenceErrorReason }
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerSessionToolServiceResult =
  | { ok: true; result: WorkerSessionToolResult }
  | { ok: false; closeReason: WorkerProtocolCloseReason }
  | { ok: false; reason: WorkerProtocolCloseReason };

type WorkerTurnRpcOptions = {
  store: WorkerEnvironmentStore;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  applyTranscriptCommit?: (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerTranscriptCommitParams;
  }) => Promise<WorkerTranscriptCommitApplicationResult>;
  liveEvents?: Pick<WorkerLiveEventReceiver, "apply">;
  placementStore?: WorkerSessionPlacementGate;
  executeSessionTool?: (
    params:
      | {
          identity: WorkerConnectionIdentity;
          toolName: "sessions_spawn";
          request: WorkerSessionsSpawnParams;
          signal?: AbortSignal;
        }
      | {
          identity: WorkerConnectionIdentity;
          toolName: "sessions_send";
          request: WorkerSessionsSendParams;
          signal?: AbortSignal;
        },
  ) => Promise<WorkerSessionToolResult>;
  inference: ReturnType<typeof createWorkerInferenceManager>;
  isStopping: () => boolean;
  now: () => number;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerTurnRpc(options: WorkerTurnRpcOptions) {
  const { store } = options;
  const inference = options.inference;
  const now = options.now;
  const withLock = options.withLock;
  const observedAckCursors = new Map<string, WorkerTerminalTurnFence>();
  const pendingTerminalTurnFences = new Map<string, WorkerPendingTerminalTurnFence>();
  const terminalTurnFences = new Map<string, WorkerTerminalTurnFence>();

  const placementBinding = (
    identity: WorkerConnectionIdentity,
  ): WorkerPlacementTurnBinding | undefined => {
    if (!identity.sessionId || !identity.runId) {
      return undefined;
    }
    return {
      sessionId: identity.sessionId,
      environmentId: identity.environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: identity.runId,
    };
  };

  const processTurnBinding = (
    identity: WorkerConnectionIdentity,
  ): WorkerProcessTurnBinding | undefined => {
    const placement = placementBinding(identity);
    return placement ? { ...placement, credentialHash: identity.credentialHash } : undefined;
  };

  const matchesTurnBinding = (
    left: WorkerProcessTurnBinding,
    right: WorkerProcessTurnBinding,
  ): boolean =>
    left.sessionId === right.sessionId &&
    left.environmentId === right.environmentId &&
    left.ownerEpoch === right.ownerEpoch &&
    left.runId === right.runId &&
    safeEqualSecret(left.credentialHash, right.credentialHash);

  const recordAckCursor = (
    binding: WorkerProcessTurnBinding,
    cursor: { transcriptSeq: number } | { liveSeq: number },
  ): WorkerTerminalTurnFence => {
    const current = observedAckCursors.get(binding.sessionId);
    const currentTurn = current && matchesTurnBinding(current, binding) ? current : undefined;
    const next: WorkerTerminalTurnFence = {
      ...binding,
      transcriptSeq:
        "transcriptSeq" in cursor
          ? Math.max(currentTurn?.transcriptSeq ?? 0, cursor.transcriptSeq)
          : (currentTurn?.transcriptSeq ?? 0),
      liveSeq:
        "liveSeq" in cursor
          ? Math.max(currentTurn?.liveSeq ?? 0, cursor.liveSeq)
          : (currentTurn?.liveSeq ?? 0),
    };
    observedAckCursors.set(binding.sessionId, next);
    return next;
  };

  const observedAckCursorFor = (
    binding: WorkerProcessTurnBinding,
  ): WorkerTerminalTurnFence | undefined => {
    const observed = observedAckCursors.get(binding.sessionId);
    return observed && matchesTurnBinding(observed, binding) ? observed : undefined;
  };

  const validateWorkerPlacement = (
    identity: WorkerConnectionIdentity,
  ): { durableClaim: boolean; valid: boolean } => {
    if (!options.placementStore) {
      return { durableClaim: false, valid: true };
    }
    if (identity.sessionId === null && identity.runId === null) {
      return { durableClaim: false, valid: true };
    }
    const binding = placementBinding(identity);
    const valid = binding ? options.placementStore.validateWorkerTurn(binding) : false;
    return { durableClaim: valid, valid };
  };

  const isTerminalLiveEvent = (request: WorkerLiveEventParams): boolean =>
    request.event.kind === "lifecycle" &&
    (request.event.payload.phase === "finishing" ||
      request.event.payload.phase === "end" ||
      (request.event.payload.phase === "error" &&
        (request.event.payload.aborted === true ||
          request.event.payload.fallbackExhaustedFailure === true)));

  const validateAttachedWorkerRequest = (
    identity: WorkerConnectionIdentity,
    runEpoch: number,
    request: WorkerTurnRequest,
  ):
    | { ok: true }
    | { ok: false; closeReason: WorkerProtocolCloseReason }
    | { ok: false; reason: "epoch-mismatch" | "session-not-attached" } => {
    if (options.isStopping()) {
      return { ok: false, closeReason: "environment-unavailable" };
    }
    const placement = validateWorkerPlacement(identity);
    if (!placement.valid) {
      return { ok: false, closeReason: "placement-mismatch" };
    }
    const turnBinding = processTurnBinding(identity);
    const terminalFence = identity.sessionId
      ? terminalTurnFences.get(identity.sessionId)
      : undefined;
    if (turnBinding && terminalFence && matchesTurnBinding(terminalFence, turnBinding)) {
      const isReplay =
        (request.kind === "transcript" && request.seq <= terminalFence.transcriptSeq) ||
        (request.kind === "live" && request.seq <= terminalFence.liveSeq);
      if (!isReplay) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
    }
    const credential = store.getCredential(identity.environmentId);
    if (!credential || !safeEqualSecret(credential.credentialHash, identity.credentialHash)) {
      return { ok: false, closeReason: "credential-replaced" };
    }
    // TTL limits unattached admission. An exact durable turn stays usable,
    // including reconnects, until its terminal ACK or placement fence.
    if (now() >= credential.expiresAtMs && !placement.durableClaim) {
      return { ok: false, closeReason: "credential-expired" };
    }
    const environment = store.get(identity.environmentId);
    if (!environment || environment.destroyRequestedAtMs !== null) {
      return { ok: false, closeReason: "environment-unavailable" };
    }
    if (
      runEpoch !== identity.ownerEpoch ||
      runEpoch !== credential.ownerEpoch ||
      runEpoch !== environment.ownerEpoch
    ) {
      return { ok: false, reason: "epoch-mismatch" };
    }
    if (
      environment.state !== "attached" ||
      !identity.sessionId ||
      credential.sessionId !== identity.sessionId ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== identity.sessionId
    ) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (turnBinding && terminalFence && !matchesTurnBinding(terminalFence, turnBinding)) {
      // Credential rotation identifies a new process turn even when a caller
      // intentionally reuses its durable run id (for example, cron sessions).
      terminalTurnFences.delete(turnBinding.sessionId);
    }
    return { ok: true };
  };

  const commitTranscript = (
    identity: WorkerConnectionIdentity,
    request: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitServiceResult> =>
    withLock(identity.environmentId, async () => {
      const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
        kind: "transcript",
        seq: request.seq,
      });
      if (!binding.ok) {
        return binding;
      }
      if (!options.applyTranscriptCommit) {
        return { ok: false, closeReason: "gateway-unavailable" };
      }
      const result = await options.applyTranscriptCommit({ identity, request });
      // Transcript persistence awaits outside the placement transaction. Revalidate the durable
      // claim before exposing an ACK so reclamation cannot admit both owners for one session.
      const currentBinding = validateAttachedWorkerRequest(identity, request.runEpoch, {
        kind: "transcript",
        seq: request.seq,
      });
      if (!currentBinding.ok) {
        return currentBinding;
      }
      // Stale base is a terminal sequenced outcome. Advance its durable cursor
      // so the next worker commit cannot reuse the consumed sequence number.
      if (result.ok || result.reason === "stale-base-leaf") {
        const placement = placementBinding(identity);
        const processTurn = processTurnBinding(identity);
        if (!placement || !processTurn) {
          return { ok: false, closeReason: "placement-mismatch" };
        }
        options.placementStore?.updateAckCursors({ ...placement, transcriptSeq: request.seq });
        recordAckCursor(processTurn, { transcriptSeq: request.seq });
      }
      return result;
    });

  const executeSessionTool = async (
    identity: WorkerConnectionIdentity,
    toolName: WorkerSessionToolName,
    request: WorkerSessionsSpawnParams | WorkerSessionsSendParams,
    signal?: AbortSignal,
  ): Promise<WorkerSessionToolServiceResult> => {
    const validate = () => {
      const requestAdmission = validateAttachedWorkerRequest(identity, identity.ownerEpoch, {
        kind: "session-tool",
      });
      if (!requestAdmission.ok) {
        return "closeReason" in requestAdmission
          ? requestAdmission
          : { ok: false as const, closeReason: "placement-mismatch" as const };
      }
      const binding = placementBinding(identity);
      if (!binding || !options.placementStore?.isWorkerTurnToolAuthorized(binding, toolName)) {
        return { ok: false as const, closeReason: "method-not-allowed" as const };
      }
      return { ok: true as const };
    };
    const admitted = validate();
    if (!admitted.ok) {
      return admitted;
    }
    if (!options.executeSessionTool) {
      return { ok: false, reason: "gateway-unavailable" };
    }
    let result: WorkerSessionToolResult;
    try {
      result = await options.executeSessionTool(
        toolName === "sessions_spawn"
          ? {
              identity,
              toolName,
              request: request as WorkerSessionsSpawnParams,
              ...(signal ? { signal } : {}),
            }
          : {
              identity,
              toolName,
              request: request as WorkerSessionsSendParams,
              ...(signal ? { signal } : {}),
            },
      );
    } catch {
      return { ok: false, reason: "gateway-unavailable" };
    }
    // The tool may have awaited provider provisioning or another session turn.
    // Never return its result after the source turn or placement was revoked.
    const current = validate();
    return current.ok ? { ok: true, result } : current;
  };

  const applyLiveEvent = (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
  ): WorkerLiveEventServiceResult => {
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "live",
      seq: request.seq,
    });
    if (!binding.ok) {
      if ("closeReason" in binding) {
        return binding;
      }
      return { ok: false, details: { reason: binding.reason } };
    }
    if (request.runId !== identity.runId) {
      return { ok: false, closeReason: "placement-mismatch" };
    }
    if (!options.liveEvents) {
      return { ok: false, closeReason: "gateway-unavailable" };
    }
    // The caller holds the environment lock, preserving order with transcript
    // commits and the terminal mutation fence while this synchronous receiver runs.
    const result = options.liveEvents.apply({ identity, request });
    if (result.ok) {
      const processTurn = processTurnBinding(identity);
      if (!processTurn) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
      recordAckCursor(processTurn, { liveSeq: result.result.ackedSeq });
    }
    return result;
  };

  const pushLiveEvent = async (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
  ): Promise<WorkerLiveEventServiceResult> => {
    return await withLock(identity.environmentId, async () => {
      const placement = placementBinding(identity);
      const processTurn = processTurnBinding(identity);
      const observed = processTurn ? observedAckCursorFor(processTurn) : undefined;
      const wasNewSequence = request.seq > (observed?.liveSeq ?? 0);
      const result = applyLiveEvent(identity, request);
      if (!result.ok || !placement || !processTurn) {
        return result;
      }
      const pending = pendingTerminalTurnFences.get(placement.sessionId);
      if (pending && !matchesTurnBinding(pending, processTurn)) {
        pendingTerminalTurnFences.delete(placement.sessionId);
      }
      if (isTerminalLiveEvent(request) && wasNewSequence) {
        pendingTerminalTurnFences.set(placement.sessionId, {
          ...processTurn,
          terminalLiveSeq: request.seq,
        });
      }
      const terminal = pendingTerminalTurnFences.get(placement.sessionId);
      if (
        terminal &&
        matchesTurnBinding(terminal, processTurn) &&
        result.result.ackedSeq >= terminal.terminalLiveSeq
      ) {
        // Only finishing authority crosses the durable boundary. Its live cursor
        // and workspace-result recovery fence commit in one placement transaction.
        options.placementStore?.updateAckCursors({
          ...placement,
          liveSeq: result.result.ackedSeq,
        });
        // A gap fill can ACK a previously buffered terminal event. Fence from
        // the observed high-water marks, not only from the request carrying it.
        terminalTurnFences.set(
          placement.sessionId,
          observedAckCursorFor(processTurn) ??
            recordAckCursor(processTurn, { liveSeq: result.result.ackedSeq }),
        );
        pendingTerminalTurnFences.delete(placement.sessionId);
      }
      return result;
    });
  };

  const revalidateInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams | WorkerInferenceCancelParams,
  ): "epoch-mismatch" | "session-not-attached" | null => {
    if (request.sessionId !== identity.sessionId) {
      return "session-not-attached";
    }
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
    return binding.ok ? null : "reason" in binding ? binding.reason : "session-not-attached";
  };

  const startInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams,
    sink: WorkerInferenceSink,
  ): WorkerInferenceStartServiceResult => {
    if (request.sessionId !== identity.sessionId || request.runId !== identity.runId) {
      return { ok: false, reason: "session-not-attached" };
    }
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
    if (!binding.ok) {
      return binding;
    }
    return inference.start({
      identity,
      request,
      sink,
      revalidate: () => revalidateInference(identity, request),
    });
  };

  const cancelInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceCancelParams,
  ): WorkerInferenceCancelServiceResult => {
    if (request.sessionId !== identity.sessionId || request.runId !== identity.runId) {
      return { ok: false, reason: "session-not-attached" };
    }
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
    if (!binding.ok) {
      return binding;
    }
    return inference.cancel({
      identity,
      request,
      revalidate: () => revalidateInference(identity, request),
    });
  };

  return {
    admitWorker: async (admission: WorkerConnectParams["admission"]) => {
      if (options.isStopping()) {
        return { ok: false, reason: "environment-unavailable" } as const;
      }
      const preflightAtMs = now();
      const preflight = admitWorkerConnection({
        store,
        admission,
        expectedBuild: admission.handshake,
        nowMs: preflightAtMs,
        allowExpiredCredential: true,
      });
      if (!preflight.ok) {
        return preflight;
      }
      if (preflightAtMs >= preflight.identity.credentialExpiresAtMs) {
        const placement = placementBinding(preflight.identity);
        if (!placement || !options.placementStore?.validateWorkerTurn(placement)) {
          return { ok: false, reason: "credential-expired" } as const;
        }
      }
      let expectedBuild: ExpectedWorkerBuild;
      try {
        expectedBuild =
          resolveLocalWorkerBuild(store.get(admission.environmentId)?.bootstrapReceipt) ??
          (await options.prepareInstallation("bundle"));
      } catch {
        return { ok: false, reason: "environment-unavailable" } as const;
      }
      if (options.isStopping()) {
        return { ok: false, reason: "environment-unavailable" } as const;
      }
      const admittedAtMs = now();
      const admitted = admitWorkerConnection({
        store,
        admission,
        expectedBuild,
        nowMs: admittedAtMs,
        allowExpiredCredential: true,
      });
      if (!admitted.ok) {
        return admitted;
      }
      const expired = admittedAtMs >= admitted.identity.credentialExpiresAtMs;
      if (
        !options.placementStore ||
        (admitted.identity.sessionId === null && admitted.identity.runId === null)
      ) {
        return expired ? ({ ok: false, reason: "credential-expired" } as const) : admitted;
      }
      const placement = placementBinding(admitted.identity);
      if (!placement || !options.placementStore.validateWorkerTurn(placement)) {
        return {
          ok: false,
          reason: expired ? "credential-expired" : "placement-mismatch",
        } as const;
      }
      return admitted;
    },
    validateWorkerConnection: (identity: WorkerConnectionIdentity) => {
      if (options.isStopping()) {
        return "environment-unavailable" as const;
      }
      const placement = validateWorkerPlacement(identity);
      if (!placement.valid) {
        return "placement-mismatch" as const;
      }
      const environmentFailure = validateWorkerConnectionIdentity({
        store,
        identity,
        nowMs: now(),
      });
      if (
        environmentFailure &&
        !(environmentFailure === "credential-expired" && placement.durableClaim)
      ) {
        return environmentFailure;
      }
      return null;
    },
    commitTranscript,
    pushLiveEvent,
    executeSessionTool,
    startInference,
    cancelInference,
    cancelInferenceForSession: (params: { sessionId: string; runId?: string }): string[] =>
      inference.cancelSession(params.sessionId, params.runId),
    hasInferenceForSession: (sessionId: string, runId?: string): boolean =>
      inference.hasSession(sessionId, runId),
    resolveInferenceSessionForRunId: (runId: string): string | undefined =>
      inference.resolveSessionIdForRunId(runId),
    clear: () => {
      observedAckCursors.clear();
      pendingTerminalTurnFences.clear();
      terminalTurnFences.clear();
    },
  };
}
