import type { WorkerLiveEvent } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { type WorkerConnection, WorkerConnectionInterruptedError } from "./worker-connection.js";
import { fenceForOwnershipError, isTerminalConnection } from "./worker-rpc-client-shared.js";

type WorkerLiveEventClientOptions = {
  runEpoch: number;
  initialAckedSeq?: number;
  maxBufferedEvents?: number;
};

type BufferedLiveEvent = {
  seq: number;
  runId: string;
  event: WorkerLiveEvent;
  blockedAck?: number;
  // Claim the old send high-water once so the Gateway clears speculative
  // preview gaps before an authoritative terminal retry is renumbered.
  resyncFromSeq?: number;
  completion?: Deferred;
};

// Keep worker requests below the Gateway's 16-frame ingress ceiling while allowing
// preview delivery to advance independently of any one cumulative ACK.
const MAX_IN_FLIGHT = 8;

export class WorkerLiveEventClient {
  private readonly buffered: BufferedLiveEvent[] = [];
  private readonly inFlight = new Set<BufferedLiveEvent>();
  private readonly unsubscribers: Array<() => void>;
  private ackedSeqValue: number;
  private nextSeqValue: number;
  private maxSentSeqValue: number;
  private replayGeneration = 0;
  private lastResync: { ackedSeq: number; expectedSeq: number } | undefined;
  // A preview may fail before finishing is enqueued; retain its send high-water
  // so that later terminal delivery still clears the resulting sequence gap.
  private terminalResyncFromSeq: number | undefined;
  private previewDegraded = false;
  private disposed = false;

  constructor(
    private readonly connection: WorkerConnection,
    private readonly options: WorkerLiveEventClientOptions,
  ) {
    this.ackedSeqValue = options.initialAckedSeq ?? 0;
    this.nextSeqValue = this.ackedSeqValue + 1;
    this.maxSentSeqValue = this.ackedSeqValue;
    this.unsubscribers = [
      connection.onReady(() => this.pump()),
      connection.onTerminalError((error) => this.rejectAll(error)),
    ];
  }

  enqueuePreview(runId: string, event: WorkerLiveEvent): boolean {
    if (this.disposed || this.previewDegraded || isTerminalConnection(this.connection)) {
      return false;
    }
    if (this.buffered.length >= (this.options.maxBufferedEvents ?? 1_024)) {
      this.degradePreviews();
      return false;
    }
    try {
      this.buffered.push({
        seq: this.nextSeqValue,
        runId,
        event: structuredClone(event),
      });
    } catch {
      this.degradePreviews();
      return false;
    }
    this.nextSeqValue += 1;
    this.pump();
    return true;
  }

  emitTerminal(runId: string, event: WorkerLiveEvent): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("worker live-event client disposed"));
    }
    const completion = createDeferredCore();
    const terminalResyncFromSeq = this.terminalResyncFromSeq;
    if (terminalResyncFromSeq !== undefined) {
      this.terminalResyncFromSeq = undefined;
    }
    this.buffered.push({
      seq: this.nextSeqValue,
      runId,
      event: structuredClone(event),
      ...(terminalResyncFromSeq === undefined ? {} : { resyncFromSeq: terminalResyncFromSeq }),
      completion,
    });
    this.nextSeqValue += 1;
    this.pump();
    return completion.promise;
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

  private pump(): void {
    if (this.disposed || this.buffered.length === 0) {
      return;
    }
    for (const entry of this.buffered) {
      if (this.inFlight.size >= MAX_IN_FLIGHT) {
        break;
      }
      if (this.inFlight.has(entry)) {
        continue;
      }
      if (entry.blockedAck === this.ackedSeqValue) {
        continue;
      }
      this.inFlight.add(entry);
      void this.send(entry);
    }
    if (this.inFlight.size === 0 && this.buffered[0]?.blockedAck === this.ackedSeqValue) {
      const head = this.buffered[0]!;
      this.handleFailure(
        head,
        new Error(
          `worker live-event acknowledgement did not advance (seq=${head.seq} runId=${head.runId} ackedSeq=${this.ackedSeqValue} buffered=${this.buffered.length} runEpoch=${this.options.runEpoch})`,
        ),
      );
      this.pump();
    }
  }

  private async send(entry: BufferedLiveEvent): Promise<void> {
    const generation = this.replayGeneration;
    const sentSeq = entry.seq;
    this.maxSentSeqValue = Math.max(this.maxSentSeqValue, sentSeq);
    try {
      await this.connection.waitForReady();
      const response = await this.connection.requestLiveEvent({
        runEpoch: this.options.runEpoch,
        lastAckedSeq: entry.resyncFromSeq ?? this.ackedSeqValue,
        seq: sentSeq,
        runId: entry.runId,
        event: entry.event,
      });
      if (generation !== this.replayGeneration || !this.buffered.includes(entry)) {
        return;
      }
      if (response.ok) {
        if (response.payload.ackedSeq > this.maxSentSeqValue) {
          throw new Error("worker live-event acknowledgement is outside sent range");
        }
        if (response.payload.ackedSeq > this.ackedSeqValue) {
          this.lastResync = undefined;
          this.ackThrough(response.payload.ackedSeq);
        } else {
          entry.blockedAck = response.payload.ackedSeq;
        }
        return;
      }
      if (response.error.details.reason === "resync-required") {
        if (response.error.details.ackedSeq > this.maxSentSeqValue) {
          throw new Error("worker live-event resync acknowledged an unsent event");
        }
        const cursor = {
          ackedSeq: response.error.details.ackedSeq,
          expectedSeq: response.error.details.expectedSeq,
        };
        if (
          this.lastResync?.ackedSeq === cursor.ackedSeq &&
          this.lastResync.expectedSeq === cursor.expectedSeq
        ) {
          throw new Error("worker live-event resync did not advance");
        }
        this.lastResync = cursor;
        this.resync(cursor.ackedSeq, cursor.expectedSeq);
        return;
      }
      fenceForOwnershipError(this.connection, response.error);
      throw new Error(`${response.error.message}: ${response.error.details.reason}`);
    } catch (error) {
      if (
        error instanceof WorkerConnectionInterruptedError &&
        !isTerminalConnection(this.connection)
      ) {
        return;
      }
      const failure = error instanceof Error ? error : new Error(String(error));
      this.handleFailure(entry, failure);
    } finally {
      this.inFlight.delete(entry);
      this.pump();
    }
  }

  private ackThrough(ackedSeq: number): void {
    this.ackedSeqValue = Math.max(this.ackedSeqValue, ackedSeq);
    const pendingIndex = this.buffered.findIndex((entry) => entry.seq > this.ackedSeqValue);
    const acknowledged = this.buffered.splice(
      0,
      pendingIndex < 0 ? this.buffered.length : pendingIndex,
    );
    for (const entry of acknowledged) {
      entry.completion?.resolve();
    }
  }

  private resync(ackedSeq: number, expectedSeq: number): void {
    if (expectedSeq !== ackedSeq + 1) {
      this.rejectAll(new Error("worker live-event resync cursor is inconsistent"));
      return;
    }
    this.replayGeneration += 1;
    if (ackedSeq >= this.ackedSeqValue) {
      this.ackThrough(ackedSeq);
    } else {
      this.ackedSeqValue = ackedSeq;
    }
    let seq = expectedSeq;
    for (const entry of this.buffered) {
      entry.seq = seq;
      delete entry.blockedAck;
      delete entry.resyncFromSeq;
      seq += 1;
    }
    this.nextSeqValue = seq;
    this.maxSentSeqValue = ackedSeq;
  }

  private handleFailure(entry: BufferedLiveEvent, error: Error): void {
    if (!entry.completion && !isTerminalConnection(this.connection)) {
      this.degradePreviews();
    } else {
      this.rejectAll(error);
    }
  }

  private degradePreviews(): void {
    this.previewDegraded = true;
    this.replayGeneration += 1;
    this.lastResync = undefined;
    const resyncFromSeq = Math.max(this.terminalResyncFromSeq ?? 0, this.maxSentSeqValue);
    const terminal = this.buffered.find((entry) => entry.completion);
    this.buffered.length = 0;
    if (terminal) {
      delete terminal.blockedAck;
      terminal.resyncFromSeq = resyncFromSeq;
      this.buffered.push(terminal);
    }
    this.terminalResyncFromSeq = terminal ? undefined : resyncFromSeq;
  }

  private rejectAll(error: Error): void {
    const buffered = this.buffered.splice(0);
    for (const entry of buffered) {
      entry.completion?.reject(error);
    }
  }
}
