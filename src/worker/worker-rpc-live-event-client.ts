import type {
  WorkerLiveEvent,
  WorkerLiveEventResult,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  type WorkerConnection,
  WorkerConnectionInterruptedError,
  WorkerConnectionStoppedError,
  WorkerFencedError,
} from "./worker-connection.js";
import type { LiveResponseError } from "./worker-rpc-client-shared.js";
import { fenceForOwnershipError, isTerminalConnection } from "./worker-rpc-client-shared.js";

class WorkerLiveEventError extends Error {
  constructor(readonly response: LiveResponseError) {
    super(response.message);
    this.name = "WorkerLiveEventError";
  }

  get reason(): LiveResponseError["details"]["reason"] {
    return this.response.details.reason;
  }
}

type WorkerLiveEventClientOptions = {
  runEpoch: number;
  initialAckedSeq?: number;
  maxBufferedEvents?: number;
};

type BufferedLiveEvent = {
  seq: number;
  runId: string;
  event: WorkerLiveEvent;
  lastResync?: { ackedSeq: number; expectedSeq: number };
  resolve: (result: WorkerLiveEventResult) => void;
  reject: (error: Error) => void;
};

export class WorkerLiveEventClient {
  private readonly buffered: BufferedLiveEvent[] = [];
  private readonly unsubscribers: Array<() => void>;
  private ackedSeqValue: number;
  private nextSeqValue: number;
  private draining = false;
  private disposed = false;

  constructor(
    private readonly connection: WorkerConnection,
    private readonly options: WorkerLiveEventClientOptions,
  ) {
    this.ackedSeqValue = options.initialAckedSeq ?? 0;
    this.nextSeqValue = this.ackedSeqValue + 1;
    this.unsubscribers = [
      connection.onReady(() => this.scheduleDrain()),
      connection.onStateChange((state) => {
        if (state.kind === "fenced") {
          this.rejectAll(new WorkerFencedError(state.reason));
        } else if (state.kind === "failed") {
          this.rejectAll(state.error);
        } else if (state.kind === "stopped") {
          this.rejectAll(new WorkerConnectionStoppedError());
        }
      }),
    ];
  }

  get ackedSeq(): number {
    return this.ackedSeqValue;
  }

  get unackedCount(): number {
    return this.buffered.length;
  }

  emit(runId: string, event: WorkerLiveEvent): Promise<WorkerLiveEventResult> {
    if (this.disposed) {
      return Promise.reject(new Error("worker live-event client disposed"));
    }
    if (this.buffered.length >= (this.options.maxBufferedEvents ?? 1_024)) {
      return Promise.reject(new Error("worker live-event buffer capacity exceeded"));
    }
    return new Promise((resolve, reject) => {
      this.buffered.push({
        seq: this.nextSeqValue,
        runId,
        event: structuredClone(event),
        resolve,
        reject,
      });
      this.nextSeqValue += 1;
      this.scheduleDrain();
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    this.rejectAll(new Error("worker live-event client disposed"));
  }

  private scheduleDrain(): void {
    if (this.draining || this.disposed || this.buffered.length === 0) {
      return;
    }
    this.draining = true;
    void this.drain()
      .catch((error: unknown) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.draining = false;
        if (!this.disposed && this.buffered.length > 0) {
          this.scheduleDrain();
        }
      });
  }

  private async drain(): Promise<void> {
    while (!this.disposed && this.buffered.length > 0) {
      const current = this.buffered[0];
      if (!current) {
        return;
      }
      try {
        await this.connection.waitForReady();
        const response = await this.connection.requestLiveEvent({
          runEpoch: this.options.runEpoch,
          lastAckedSeq: this.ackedSeqValue,
          seq: current.seq,
          runId: current.runId,
          event: current.event,
        });
        if (response.ok) {
          if (
            response.payload.ackedSeq < this.ackedSeqValue ||
            response.payload.ackedSeq > current.seq
          ) {
            this.rejectAll(new Error("worker live-event acknowledgement is outside sent range"));
            return;
          }
          const previousAck = this.ackedSeqValue;
          this.ackThrough(response.payload.ackedSeq);
          if (this.ackedSeqValue === previousAck && this.buffered[0] === current) {
            this.rejectAll(
              new Error(
                `worker live-event acknowledgement did not advance (seq=${current.seq} runId=${current.runId} ackedSeq=${response.payload.ackedSeq} previousAck=${previousAck} buffered=${this.buffered.length} runEpoch=${this.options.runEpoch})`,
              ),
            );
            return;
          }
          continue;
        }
        if (response.error.details.reason === "resync-required") {
          if (response.error.details.ackedSeq > current.seq) {
            this.rejectAll(new Error("worker live-event resync acknowledged an unsent event"));
            return;
          }
          const cursor = {
            ackedSeq: response.error.details.ackedSeq,
            expectedSeq: response.error.details.expectedSeq,
          };
          if (
            current.lastResync?.ackedSeq === cursor.ackedSeq &&
            current.lastResync.expectedSeq === cursor.expectedSeq
          ) {
            throw new Error("worker live-event resync did not advance");
          }
          current.lastResync = cursor;
          this.resync(response.error.details.ackedSeq, response.error.details.expectedSeq);
          continue;
        }
        fenceForOwnershipError(this.connection, response.error);
        this.rejectAll(new WorkerLiveEventError(response.error));
        return;
      } catch (error) {
        if (
          error instanceof WorkerConnectionInterruptedError &&
          !isTerminalConnection(this.connection)
        ) {
          return;
        }
        throw error;
      }
    }
  }

  private ackThrough(ackedSeq: number): void {
    this.ackedSeqValue = Math.max(this.ackedSeqValue, ackedSeq);
    while (true) {
      const entry = this.buffered[0];
      if (!entry || entry.seq > this.ackedSeqValue) {
        return;
      }
      this.buffered.shift();
      entry.resolve({ ackedSeq: this.ackedSeqValue });
    }
  }

  private resync(ackedSeq: number, expectedSeq: number): void {
    if (expectedSeq !== ackedSeq + 1) {
      this.rejectAll(new Error("worker live-event resync cursor is inconsistent"));
      return;
    }
    if (ackedSeq >= this.ackedSeqValue) {
      this.ackThrough(ackedSeq);
    } else {
      this.ackedSeqValue = ackedSeq;
    }
    let seq = expectedSeq;
    for (const entry of this.buffered) {
      entry.seq = seq;
      seq += 1;
    }
    this.nextSeqValue = seq;
  }

  private rejectAll(error: Error): void {
    const buffered = this.buffered.splice(0);
    for (const entry of buffered) {
      entry.reject(error);
    }
  }
}
