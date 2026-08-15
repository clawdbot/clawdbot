import type {
  WorkerInferenceCancelParams,
  WorkerInferenceCancelResult,
  WorkerInferenceEventParams,
  WorkerInferenceStartParams,
  WorkerInferenceTerminalOutcome,
  WorkerInferenceTerminalParams,
} from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  type WorkerConnection,
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection.js";
import type { InferenceResponseError } from "./worker-rpc-client-shared.js";
import { fenceForOwnershipError } from "./worker-rpc-client-shared.js";

class WorkerInferenceProxyError extends Error {
  constructor(readonly response: InferenceResponseError) {
    super(response.message);
    this.name = "WorkerInferenceProxyError";
  }

  get reason(): InferenceResponseError["details"]["reason"] {
    return this.response.details.reason;
  }
}

type WorkerInferenceHandlers = {
  onEvent?: (event: WorkerInferenceEventParams) => void;
  onStreamGap?: (gap: { expectedSeq: number; receivedSeq: number }) => void;
};

type InferenceOperation = {
  params: WorkerInferenceStartParams;
  handlers: WorkerInferenceHandlers;
  lastSeq: number;
  resumeRequested: boolean;
  startInFlight: boolean;
  settled: boolean;
  resolve: (outcome: WorkerInferenceTerminalOutcome) => void;
  reject: (error: Error) => void;
};

function inferenceKey(params: { sessionId: string; runId: string; turnId: string }): string {
  return `${params.sessionId}\u0000${params.runId}\u0000${params.turnId}`;
}

function matchesInferenceIdentity(
  operation: InferenceOperation,
  payload: WorkerInferenceEventParams | WorkerInferenceTerminalParams,
): boolean {
  return (
    payload.runEpoch === operation.params.runEpoch &&
    payload.sessionId === operation.params.sessionId &&
    payload.runId === operation.params.runId &&
    payload.turnId === operation.params.turnId
  );
}

export class WorkerInferenceProxyClient {
  private readonly operations = new Map<string, InferenceOperation>();
  private readonly unsubscribers: Array<() => void>;
  private disposed = false;

  constructor(private readonly connection: WorkerConnection) {
    this.unsubscribers = [
      connection.onReady(() => this.resume()),
      connection.onStateChange((state) => {
        if (state.kind === "fenced") {
          this.rejectAllOperations(new WorkerFencedError(state.reason));
        } else if (state.kind === "failed") {
          this.rejectAllOperations(state.error);
        } else if (state.kind === "stopped") {
          this.rejectAllOperations(new WorkerConnectionStoppedError());
        }
      }),
      connection.onInferenceEvent((frame) => this.handleEvent(frame.payload)),
      connection.onInferenceTerminal((frame) => this.handleTerminal(frame.payload)),
    ];
  }

  start(
    params: WorkerInferenceStartParams,
    handlers: WorkerInferenceHandlers = {},
  ): Promise<WorkerInferenceTerminalOutcome> {
    if (this.disposed) {
      return Promise.reject(new Error("worker inference client disposed"));
    }
    const snapshot = structuredClone(params);
    const key = inferenceKey(snapshot);
    if (this.operations.has(key)) {
      return Promise.reject(new Error("worker inference turn already active"));
    }
    return new Promise((resolve, reject) => {
      const operation: InferenceOperation = {
        params: snapshot,
        handlers,
        lastSeq: 0,
        resumeRequested: false,
        startInFlight: false,
        settled: false,
        resolve,
        reject,
      };
      this.operations.set(key, operation);
      this.scheduleStart(operation);
    });
  }

  async cancel(params: WorkerInferenceCancelParams): Promise<WorkerInferenceCancelResult> {
    const response = await this.connection.requestInferenceCancel(params);
    if (response.ok) {
      return response.payload;
    }
    fenceForOwnershipError(this.connection, response.error);
    throw new WorkerInferenceProxyError(response.error);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    for (const operation of this.operations.values()) {
      operation.settled = true;
      operation.reject(new Error("worker inference client disposed"));
    }
    this.operations.clear();
  }

  private resume(): void {
    for (const operation of this.operations.values()) {
      if (operation.startInFlight) {
        operation.resumeRequested = true;
        continue;
      }
      this.scheduleStart(operation);
    }
  }

  private scheduleStart(operation: InferenceOperation): void {
    if (operation.startInFlight || operation.settled || this.disposed) {
      return;
    }
    operation.startInFlight = true;
    void this.issueStart(operation);
  }

  private async issueStart(operation: InferenceOperation): Promise<void> {
    let interrupted = false;
    try {
      await this.connection.waitForReady();
      const response = await this.connection.requestInferenceStart(operation.params, (frame) => {
        if (frame.ok && frame.payload.status === "replayed") {
          operation.lastSeq = 0;
        }
      });
      if (!response.ok) {
        fenceForOwnershipError(this.connection, response.error);
        this.rejectOperation(operation, new WorkerInferenceProxyError(response.error));
        return;
      }
      operation.resumeRequested = false;
    } catch (error) {
      if (error instanceof WorkerConnectionInterruptedError) {
        interrupted = true;
      } else {
        this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
      }
    } finally {
      operation.startInFlight = false;
      if (interrupted && operation.resumeRequested && !operation.settled) {
        operation.resumeRequested = false;
        this.scheduleStart(operation);
      }
    }
  }

  private handleEvent(payload: WorkerInferenceEventParams): void {
    const operation = this.operations.get(inferenceKey(payload));
    if (!operation || operation.settled || !matchesInferenceIdentity(operation, payload)) {
      return;
    }
    this.applyEvent(operation, payload);
  }

  private applyEvent(operation: InferenceOperation, payload: WorkerInferenceEventParams): void {
    if (payload.seq <= operation.lastSeq) {
      return;
    }
    if (payload.seq !== operation.lastSeq + 1) {
      try {
        operation.handlers.onStreamGap?.({
          expectedSeq: operation.lastSeq + 1,
          receivedSeq: payload.seq,
        });
      } catch (error) {
        this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    operation.lastSeq = payload.seq;
    try {
      operation.handlers.onEvent?.(payload);
    } catch (error) {
      this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleTerminal(payload: WorkerInferenceTerminalParams): void {
    const operation = this.operations.get(inferenceKey(payload));
    if (!operation || operation.settled || !matchesInferenceIdentity(operation, payload)) {
      return;
    }
    this.applyTerminal(operation, payload);
  }

  private applyTerminal(
    operation: InferenceOperation,
    payload: WorkerInferenceTerminalParams,
  ): void {
    if (payload.seq <= operation.lastSeq) {
      return;
    }
    if (payload.seq !== operation.lastSeq + 1) {
      try {
        operation.handlers.onStreamGap?.({
          expectedSeq: operation.lastSeq + 1,
          receivedSeq: payload.seq,
        });
      } catch (error) {
        this.rejectOperation(operation, error instanceof Error ? error : new Error(String(error)));
        return;
      }
    }
    operation.lastSeq = payload.seq;
    operation.settled = true;
    this.operations.delete(inferenceKey(operation.params));
    operation.resolve(payload.outcome);
  }

  private rejectOperation(operation: InferenceOperation, error: Error): void {
    if (operation.settled) {
      return;
    }
    operation.settled = true;
    this.operations.delete(inferenceKey(operation.params));
    operation.reject(error);
  }

  private rejectAllOperations(error: Error): void {
    for (const operation of this.operations.values()) {
      this.rejectOperation(operation, error);
    }
  }
}
