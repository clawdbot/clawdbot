import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import {
  WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  type WorkerInferenceCancelParams,
  type WorkerInferenceCancelResult,
  type WorkerInferenceErrorReason,
  type WorkerInferenceEventFrame,
  type WorkerInferenceEventParams,
  type WorkerInferenceStartParams,
  type WorkerInferenceStartResult,
  type WorkerInferenceTerminalFrame,
  type WorkerInferenceTerminalOutcome,
  validateWorkerInferenceEventFrame,
  validateWorkerInferenceTerminalFrame,
  validateWorkerInferenceTerminalOutcome,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import type { OpenClawConfig } from "../../config/types.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { boundedJsonUtf8Bytes } from "../../infra/json-utf8-bytes.js";
import { runWithGatewayIndependentRootWorkContinuation } from "../../process/gateway-work-admission.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerInferenceSessionDrain } from "./inference-control-internal.js";
import {
  createWorkerInferenceStore,
  type WorkerInferenceStore,
  type WorkerInferenceTurnInput,
} from "./inference-store.js";
import {
  serializeWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";

const DEFAULT_REQUEST_MAX_BYTES = WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES;
// One active turn plus one provider that ignored abort. This prevents repeated
// cancel/restart from creating unbounded provider work without wedging the session forever.
const MAX_PROVIDER_OPERATIONS_PER_SESSION = 2;

type WorkerInferenceFenceReason = Extract<
  WorkerInferenceErrorReason,
  "epoch-mismatch" | "session-not-attached"
>;

export type WorkerInferenceSink = {
  connectionId: string;
  send(frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame): void;
};

export type WorkerInferenceExecutor = (params: {
  identity: WorkerConnectionIdentity;
  request: WorkerInferenceStartParams;
  signal: AbortSignal;
  emit: (event: WorkerInferenceEventParams["event"]) => void;
  isCurrent(): boolean;
  config?: OpenClawConfig;
}) => Promise<WorkerInferenceTerminalOutcome>;

type RevalidateInference = () => WorkerInferenceFenceReason | null;

function safeRevalidate(revalidate?: RevalidateInference): WorkerInferenceErrorReason | null {
  try {
    return revalidate?.() ?? null;
  } catch {
    return "provider-error";
  }
}

type WorkerInferenceStartApplicationResult =
  | {
      ok: true;
      result: WorkerInferenceStartResult;
      launch(): void;
    }
  | { ok: false; reason: WorkerInferenceErrorReason };

type WorkerInferenceCancelApplicationResult =
  | { ok: true; result: WorkerInferenceCancelResult }
  | { ok: false; reason: WorkerInferenceErrorReason };

type ActiveInference = {
  claimKey: string;
  identity: WorkerConnectionIdentity;
  request: WorkerInferenceStartParams;
  requestHash: string;
  storeInput: WorkerInferenceTurnInput;
  sink: WorkerInferenceSink;
  revalidate?: RevalidateInference;
  controller: AbortController;
  seq: number;
  streamedBytes: number;
  launched: boolean;
  settled: boolean;
  abortReason?: WorkerInferenceErrorReason;
};

function trySend(
  sink: WorkerInferenceSink,
  frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame,
): boolean {
  try {
    sink.send(frame);
    return true;
  } catch {
    return false;
  }
}

function terminalError(
  reason: WorkerInferenceErrorReason,
  outcome?: WorkerInferenceTerminalOutcome,
): WorkerInferenceTerminalOutcome {
  const usage =
    outcome?.type === "done"
      ? outcome.message.usage
      : outcome?.type === "error"
        ? outcome.usage
        : undefined;
  const message = (() => {
    switch (reason) {
      case "model-not-approved":
        return "Model is not approved";
      case "invalid-context":
        return "Inference context is invalid";
      case "epoch-mismatch":
        return "Inference ownership changed";
      case "session-not-attached":
        return "Session is not attached";
      case "provider-error":
        return "Provider request failed";
      case "cancelled":
        return "Inference cancelled";
    }
    return "Provider request failed";
  })();
  return {
    type: "error",
    reason,
    message,
    ...(usage ? { usage } : {}),
  };
}

function validFrameBytes(
  frame: WorkerInferenceEventFrame | WorkerInferenceTerminalFrame,
  validate: (data: unknown) => boolean,
): number | null {
  const measured = boundedJsonUtf8Bytes(frame, WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES);
  if (
    measured.complete &&
    measured.bytes <= WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES &&
    validate(frame)
  ) {
    return measured.bytes;
  }
  return null;
}

function terminalFrame(
  entry: ActiveInference,
  outcome: WorkerInferenceTerminalOutcome,
  seq = entry.seq + 1,
): WorkerInferenceTerminalFrame {
  return {
    type: "event",
    event: "worker.inference.terminal",
    payload: {
      runEpoch: entry.request.runEpoch,
      sessionId: entry.request.sessionId,
      runId: entry.request.runId,
      turnId: entry.request.turnId,
      seq,
      outcome,
    },
  };
}

function normalizeTerminalOutcome(
  entry: ActiveInference,
  outcome: WorkerInferenceTerminalOutcome,
): WorkerInferenceTerminalOutcome {
  if (
    !validateWorkerInferenceTerminalOutcome(outcome) ||
    validFrameBytes(terminalFrame(entry, outcome), validateWorkerInferenceTerminalFrame) === null
  ) {
    return terminalError("provider-error");
  }
  return outcome;
}

function matchesIdentity(
  identity: WorkerConnectionIdentity,
  request: WorkerInferenceStartParams | WorkerInferenceCancelParams,
): WorkerInferenceErrorReason | null {
  const claim = identity.turnClaim;
  if (
    !claim ||
    identity.sessionId !== request.sessionId ||
    identity.runId !== request.runId ||
    claim.sessionId !== request.sessionId ||
    claim.runId !== request.runId
  ) {
    return "session-not-attached";
  }
  if (identity.ownerEpoch !== request.runEpoch) {
    return "epoch-mismatch";
  }
  return null;
}

export function createWorkerInferenceManager(options: {
  execute: WorkerInferenceExecutor;
  store?: WorkerInferenceStore;
  getConfig?: () => OpenClawConfig;
  requestMaxBytes?: number;
  streamMaxBytes?: number;
  stopDrainMs?: number;
}) {
  const store = options.store ?? createWorkerInferenceStore();
  const requestMaxBytes = options.requestMaxBytes ?? DEFAULT_REQUEST_MAX_BYTES;
  const streamMaxBytes = options.streamMaxBytes ?? WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES;
  const active = new Map<string, ActiveInference>();
  const operations = new Map<Promise<void>, string>();
  const drainingSessionIds = new Set<string>();
  let stopping = false;
  store.recoverPending(terminalError("provider-error"));

  const processFence = (entry: ActiveInference): WorkerInferenceErrorReason | null => {
    if (entry.abortReason) {
      return entry.abortReason;
    }
    const bindingError = matchesIdentity(entry.identity, entry.request);
    if (bindingError) {
      return bindingError;
    }
    if (active.get(entry.claimKey) !== entry) {
      return "cancelled";
    }
    return null;
  };

  const durableFence = (entry: ActiveInference): WorkerInferenceErrorReason | null => {
    const currentError = processFence(entry);
    if (currentError) {
      return currentError;
    }
    const revalidationError = safeRevalidate(entry.revalidate);
    if (revalidationError) {
      entry.abortReason = revalidationError;
      entry.controller.abort();
      return revalidationError;
    }
    return null;
  };

  const abortEntry = (entry: ActiveInference, reason: WorkerInferenceErrorReason): void => {
    if (!entry.abortReason) {
      entry.abortReason = reason;
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort();
    }
  };

  const sendTerminal = (entry: ActiveInference, outcome: WorkerInferenceTerminalOutcome): void => {
    entry.seq += 1;
    trySend(entry.sink, terminalFrame(entry, outcome, entry.seq));
  };

  const settleAbort = (entry: ActiveInference, reason: WorkerInferenceErrorReason): boolean => {
    if (entry.settled) {
      return true;
    }
    abortEntry(entry, reason);
    let outcome: WorkerInferenceTerminalOutcome;
    try {
      outcome = store.complete({
        ...entry.storeInput,
        outcome: terminalError(entry.abortReason ?? reason),
      });
    } catch {
      return false;
    }
    entry.settled = true;
    if (active.get(entry.claimKey) === entry) {
      active.delete(entry.claimKey);
      sendTerminal(entry, outcome);
    }
    return true;
  };

  const finish = (entry: ActiveInference, rawOutcome: WorkerInferenceTerminalOutcome): void => {
    if (entry.settled) {
      return;
    }
    const fence = durableFence(entry);
    const outcome = normalizeTerminalOutcome(
      entry,
      fence ? terminalError(fence, rawOutcome) : rawOutcome,
    );
    let storedOutcome: WorkerInferenceTerminalOutcome;
    try {
      storedOutcome = store.complete({ ...entry.storeInput, outcome });
    } catch {
      entry.settled = true;
      if (active.get(entry.claimKey) === entry) {
        active.delete(entry.claimKey);
      }
      return;
    }
    entry.settled = true;
    if (active.get(entry.claimKey) === entry) {
      active.delete(entry.claimKey);
      sendTerminal(entry, storedOutcome);
    }
  };

  const executeEntry = async (entry: ActiveInference): Promise<void> => {
    const initialFence = durableFence(entry);
    if (initialFence) {
      finish(entry, terminalError(initialFence));
      return;
    }
    let outcome: WorkerInferenceTerminalOutcome;
    try {
      const config = options.getConfig?.();
      outcome = await options.execute({
        identity: entry.identity,
        request: entry.request,
        signal: entry.controller.signal,
        emit: (event) => {
          const fence = durableFence(entry);
          if (fence) {
            abortEntry(entry, fence);
            return;
          }
          const nextSeq = entry.seq + 1;
          const frame: WorkerInferenceEventFrame = {
            type: "event",
            event: "worker.inference.event",
            payload: {
              runEpoch: entry.request.runEpoch,
              sessionId: entry.request.sessionId,
              runId: entry.request.runId,
              turnId: entry.request.turnId,
              seq: nextSeq,
              event,
            },
          };
          const frameBytes = validFrameBytes(frame, validateWorkerInferenceEventFrame);
          if (frameBytes === null || entry.streamedBytes + frameBytes > streamMaxBytes) {
            settleAbort(entry, "provider-error");
            return;
          }
          if (!trySend(entry.sink, frame)) {
            settleAbort(entry, "provider-error");
            return;
          }
          entry.streamedBytes += frameBytes;
          entry.seq = nextSeq;
        },
        isCurrent: () => durableFence(entry) === null,
        ...(config ? { config } : {}),
      });
    } catch {
      outcome = terminalError(entry.abortReason ?? "provider-error");
    }
    finish(entry, outcome);
  };

  const launchEntry = (entry: ActiveInference): void => {
    if (entry.launched || entry.settled) {
      return;
    }
    entry.launched = true;
    const operation = runWithGatewayIndependentRootWorkContinuation(() =>
      executeEntry(entry),
    ).catch(() => {
      finish(entry, terminalError(entry.abortReason ?? "provider-error"));
    });
    operations.set(operation, entry.request.sessionId);
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation),
    );
  };

  const start = (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerInferenceStartParams;
    sink: WorkerInferenceSink;
    revalidate?: RevalidateInference;
  }): WorkerInferenceStartApplicationResult => {
    if (stopping || drainingSessionIds.has(params.request.sessionId)) {
      return { ok: false, reason: "cancelled" };
    }
    const identityError = matchesIdentity(params.identity, params.request);
    if (identityError) {
      return { ok: false, reason: identityError };
    }
    const revalidationError = safeRevalidate(params.revalidate);
    if (revalidationError) {
      return { ok: false, reason: revalidationError };
    }
    const measured = boundedJsonUtf8Bytes(params.request, requestMaxBytes);
    if (!measured.complete || measured.bytes > requestMaxBytes) {
      return { ok: false, reason: "invalid-context" };
    }
    const serialized = stableStringify(params.request);
    const claim = params.identity.turnClaim!;
    const claimKey = serializeWorkerSessionTurnClaim(claim);
    const hash = createHash("sha256").update(`${claimKey}\0${serialized}`).digest("hex");
    const existing = active.get(claimKey);
    if (existing) {
      if (
        existing.request.turnId === params.request.turnId &&
        existing.requestHash === hash &&
        !existing.settled
      ) {
        const retryEntry = existing;
        retryEntry.identity = params.identity;
        retryEntry.sink = params.sink;
        if (params.revalidate) {
          retryEntry.revalidate = params.revalidate;
        } else {
          delete retryEntry.revalidate;
        }
        return {
          ok: true,
          result: { status: "accepted" },
          launch: () => launchEntry(retryEntry),
        };
      }
      const staleFence = durableFence(existing);
      if (!staleFence) {
        return { ok: false, reason: "invalid-context" };
      }
      settleAbort(existing, staleFence);
      return { ok: false, reason: "invalid-context" };
    }
    for (const concurrent of active.values()) {
      if (concurrent.request.sessionId !== params.request.sessionId) {
        continue;
      }
      const staleFence = durableFence(concurrent);
      if (!staleFence) {
        return { ok: false, reason: "invalid-context" };
      }
      settleAbort(concurrent, staleFence);
      return { ok: false, reason: "invalid-context" };
    }
    const storeInput: WorkerInferenceTurnInput = {
      environmentId: params.identity.environmentId,
      sessionId: params.request.sessionId,
      runEpoch: params.request.runEpoch,
      runId: params.request.runId,
      turnId: params.request.turnId,
      requestHash: hash,
    };
    let begin: ReturnType<WorkerInferenceStore["begin"]>;
    try {
      begin = store.begin(storeInput);
    } catch {
      return { ok: false, reason: "provider-error" };
    }
    if (begin.kind === "rejected") {
      return { ok: false, reason: "invalid-context" };
    }
    const replayResult = (
      cachedOutcome: WorkerInferenceTerminalOutcome,
    ): WorkerInferenceStartApplicationResult => {
      let launched = false;
      return {
        ok: true,
        result: { status: "replayed" },
        launch: () => {
          if (launched) {
            return;
          }
          launched = true;
          const fence = safeRevalidate(params.revalidate);
          const frame: WorkerInferenceTerminalFrame = {
            type: "event",
            event: "worker.inference.terminal",
            payload: {
              runEpoch: params.request.runEpoch,
              sessionId: params.request.sessionId,
              runId: params.request.runId,
              turnId: params.request.turnId,
              seq: 1,
              outcome: fence ? terminalError(fence) : cachedOutcome,
            },
          };
          trySend(params.sink, frame);
        },
      };
    };
    if (begin.kind === "replay") {
      return replayResult(begin.outcome);
    }
    if (begin.kind === "recover") {
      const outcome = terminalError("provider-error");
      let storedOutcome: WorkerInferenceTerminalOutcome;
      try {
        storedOutcome = store.complete({ ...storeInput, outcome });
      } catch {
        return { ok: false, reason: "provider-error" };
      }
      return replayResult(storedOutcome);
    }
    let runningForSession = 0;
    for (const sessionId of operations.values()) {
      if (sessionId === params.request.sessionId) {
        runningForSession += 1;
      }
    }
    if (runningForSession >= MAX_PROVIDER_OPERATIONS_PER_SESSION) {
      try {
        return replayResult(
          store.complete({ ...storeInput, outcome: terminalError("provider-error") }),
        );
      } catch {
        return { ok: false, reason: "provider-error" };
      }
    }
    const entry: ActiveInference = {
      claimKey,
      identity: params.identity,
      request: params.request,
      requestHash: hash,
      storeInput,
      sink: params.sink,
      ...(params.revalidate ? { revalidate: params.revalidate } : {}),
      controller: new AbortController(),
      seq: 0,
      streamedBytes: 0,
      launched: false,
      settled: false,
    };
    active.set(claimKey, entry);
    return {
      ok: true,
      result: { status: "accepted" },
      launch: () => launchEntry(entry),
    };
  };

  const cancel = (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerInferenceCancelParams;
    revalidate?: RevalidateInference;
  }): WorkerInferenceCancelApplicationResult => {
    const identityError = matchesIdentity(params.identity, params.request);
    if (identityError) {
      return { ok: false, reason: identityError };
    }
    const revalidationError = safeRevalidate(params.revalidate);
    if (revalidationError) {
      return { ok: false, reason: revalidationError };
    }
    const claimKey = serializeWorkerSessionTurnClaim(params.identity.turnClaim!);
    const entry = active.get(claimKey);
    if (entry?.request.turnId === params.request.turnId) {
      if (!settleAbort(entry, "cancelled")) {
        return { ok: false, reason: "provider-error" };
      }
    } else {
      try {
        store.cancelPending({
          environmentId: params.identity.environmentId,
          sessionId: params.request.sessionId,
          runEpoch: params.request.runEpoch,
          runId: params.request.runId,
          turnId: params.request.turnId,
          outcome: terminalError("cancelled"),
        });
      } catch {
        return { ok: false, reason: "provider-error" };
      }
    }
    return { ok: true, result: { status: "cancelled" } };
  };

  const cancelWhere = (
    predicate: (entry: ActiveInference) => boolean,
    reason: WorkerInferenceErrorReason,
    onCancel?: (entry: ActiveInference) => void,
  ): boolean => {
    let terminalPersistenceFailed = false;
    for (const entry of active.values()) {
      if (predicate(entry)) {
        onCancel?.(entry);
        terminalPersistenceFailed = !settleAbort(entry, reason) || terminalPersistenceFailed;
      }
    }
    return terminalPersistenceFailed;
  };

  const cancelEnvironment = (
    environmentId: string,
    reason: WorkerInferenceErrorReason = "session-not-attached",
  ): void => {
    cancelWhere((entry) => entry.identity.environmentId === environmentId, reason);
  };

  const cancelClaim = (claim: WorkerSessionTurnClaim): void => {
    const claimKey = serializeWorkerSessionTurnClaim(claim);
    cancelWhere((entry) => entry.claimKey === claimKey, "session-not-attached");
  };

  const cancelSession = (sessionId: string, runId?: string): string[] => {
    const cancelledRunIds = new Set<string>();
    cancelWhere(
      (entry) =>
        entry.request.sessionId === sessionId &&
        (runId === undefined || entry.request.runId === runId),
      "cancelled",
      (entry) => cancelledRunIds.add(entry.request.runId),
    );
    return [...cancelledRunIds].toSorted();
  };

  const hasSession = (sessionId: string, runId?: string): boolean => {
    for (const entry of active.values()) {
      if (
        entry.request.sessionId === sessionId &&
        (runId === undefined || entry.request.runId === runId)
      ) {
        return true;
      }
    }
    return false;
  };

  const hasSessionOperation = (sessionId: string): boolean => {
    for (const operationSessionId of operations.values()) {
      if (operationSessionId === sessionId) {
        return true;
      }
    }
    return false;
  };

  const beginSessionDrain = (sessionId: string): WorkerInferenceSessionDrain => {
    if (drainingSessionIds.has(sessionId)) {
      throw new Error(`Worker inference drain already owns session ${sessionId}`);
    }
    // Block first so cancellation cannot race a replacement provider operation.
    drainingSessionIds.add(sessionId);
    const terminalPersistenceFailed = cancelWhere(
      (entry) => entry.request.sessionId === sessionId,
      "cancelled",
    );
    const providerOperations: Promise<void>[] = [];
    for (const [operation, operationSessionId] of operations) {
      if (operationSessionId === sessionId) {
        providerOperations.push(operation);
      }
    }
    let released = false;
    return {
      drained: Promise.allSettled(providerOperations).then(() => {
        if (terminalPersistenceFailed) {
          throw new Error(`Worker inference terminal persistence failed for session ${sessionId}`);
        }
      }),
      hasWork: () => hasSession(sessionId) || hasSessionOperation(sessionId),
      release: () => {
        if (released) {
          return;
        }
        released = true;
        drainingSessionIds.delete(sessionId);
      },
    };
  };

  const resolveSessionIdForRunId = (runId: string): string | undefined => {
    const sessionIds = new Set<string>();
    for (const entry of active.values()) {
      if (entry.request.runId === runId) {
        sessionIds.add(entry.request.sessionId);
      }
    }
    return sessionIds.size === 1 ? sessionIds.values().next().value : undefined;
  };

  const stop = async (): Promise<void> => {
    stopping = true;
    cancelWhere(() => true, "provider-error");
    await withTimeout(
      Promise.allSettled(operations.keys()),
      options.stopDrainMs ?? 5_000,
      "Worker inference shutdown",
    ).catch(() => undefined);
  };

  const manager = {
    start,
    cancel,
    cancelEnvironment,
    cancelClaim,
    cancelSession,
    hasSession,
    resolveSessionIdForRunId,
    stop,
  };
  // Archive-only control stays non-enumerable so the manager's inferred contract remains stable.
  Object.defineProperty(manager, "beginSessionDrain", { value: beginSessionDrain });
  return manager;
}
