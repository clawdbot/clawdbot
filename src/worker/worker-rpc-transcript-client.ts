import type {
  WorkerTranscriptCommitRequestFrame,
  WorkerTranscriptCommitResult,
  WorkerTranscriptMessage,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { isWorkerTranscriptMessageFrameSafe } from "./transcript-message.js";
import { type WorkerConnection, WorkerConnectionInterruptedError } from "./worker-connection.js";
import type { TranscriptResponseError } from "./worker-rpc-client-shared.js";
import { fenceForOwnershipError, isTerminalConnection } from "./worker-rpc-client-shared.js";

const TRANSCRIPT_SIZE_FRAME_ID = "00000000-0000-4000-8000-000000000000";

class WorkerTranscriptCommitError extends Error {
  constructor(
    readonly response: TranscriptResponseError,
    message = response.message,
  ) {
    super(message);
    this.name = "WorkerTranscriptCommitError";
  }

  get reason(): TranscriptResponseError["details"]["reason"] {
    return this.response.details.reason;
  }
}

type WorkerTranscriptCommitClientOptions = {
  runEpoch: number;
  baseLeafId: string | null;
  initialSeq?: number;
};

export class WorkerTranscriptCommitClient {
  private baseLeafIdValue: string | null;
  private nextSeqValue: number;
  private queue: Promise<void> = Promise.resolve();
  private terminalFailure: WorkerTranscriptCommitError | undefined;

  constructor(
    private readonly connection: WorkerConnection,
    private readonly options: WorkerTranscriptCommitClientOptions,
  ) {
    this.baseLeafIdValue = options.baseLeafId;
    this.nextSeqValue = options.initialSeq ?? 1;
  }

  get baseLeafId(): string | null {
    return this.baseLeafIdValue;
  }

  get nextSeq(): number {
    return this.nextSeqValue;
  }

  commit(messages: readonly WorkerTranscriptMessage[]): Promise<WorkerTranscriptCommitResult> {
    const snapshot = structuredClone(messages);
    const operation = this.queue.then(() => this.commitBatches(snapshot));
    this.queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private async commitBatches(
    messages: readonly WorkerTranscriptMessage[],
  ): Promise<WorkerTranscriptCommitResult> {
    if (messages.length === 0) {
      throw new Error("worker transcript commit requires at least one message");
    }
    const entryIds: string[] = [];
    let offset = 0;
    while (offset < messages.length) {
      const batch = this.takeFittingBatch(messages.slice(offset));
      const result = await this.commitBatch(batch);
      entryIds.push(...result.entryIds);
      offset += batch.length;
    }
    const newLeafId = this.baseLeafIdValue;
    if (newLeafId === null) {
      throw new Error("worker transcript commit did not advance the base leaf");
    }
    return { entryIds, newLeafId };
  }

  private takeFittingBatch(
    messages: readonly WorkerTranscriptMessage[],
  ): WorkerTranscriptMessage[] {
    let batch: WorkerTranscriptMessage[] = [];
    for (const message of messages) {
      if (!isWorkerTranscriptMessageFrameSafe(message)) {
        throw new Error("worker transcript message exceeds the protocol payload limit");
      }
      const candidate = [...batch, message];
      const frame: WorkerTranscriptCommitRequestFrame = {
        type: "req",
        id: TRANSCRIPT_SIZE_FRAME_ID,
        method: "worker.transcript.commit",
        params: {
          runEpoch: this.options.runEpoch,
          seq: this.nextSeqValue,
          baseLeafId: this.baseLeafIdValue,
          messages: candidate,
        },
      };
      if (Buffer.byteLength(JSON.stringify(frame), "utf8") > WORKER_PROTOCOL_MAX_PAYLOAD_BYTES) {
        if (batch.length === 0) {
          throw new Error("worker transcript message exceeds the protocol payload limit");
        }
        break;
      }
      batch = candidate;
    }
    return batch;
  }

  private async commitBatch(
    messages: readonly WorkerTranscriptMessage[],
  ): Promise<WorkerTranscriptCommitResult> {
    if (this.terminalFailure) {
      throw this.terminalFailure;
    }
    const request = {
      runEpoch: this.options.runEpoch,
      seq: this.nextSeqValue,
      baseLeafId: this.baseLeafIdValue,
      messages: [...messages],
    };
    while (true) {
      await this.connection.waitForReady();
      try {
        const response = await this.connection.requestTranscriptCommit(request);
        if (response.ok) {
          this.baseLeafIdValue = response.payload.newLeafId;
          this.nextSeqValue = request.seq + 1;
          return response.payload;
        }
        if (response.error.details.reason === "stale-base-leaf") {
          // A stale base consumes this ledger seq. Retrying against a new leaf
          // would append output built from stale context; milestone 3 must relaunch.
          this.nextSeqValue = request.seq + 1;
          this.terminalFailure = new WorkerTranscriptCommitError(
            response.error,
            "Worker transcript base changed; uncommitted messages were not committed; relaunch required.",
          );
          throw this.terminalFailure;
        }
        fenceForOwnershipError(this.connection, response.error);
        throw new WorkerTranscriptCommitError(response.error);
      } catch (error) {
        if (
          error instanceof WorkerConnectionInterruptedError &&
          !isTerminalConnection(this.connection)
        ) {
          continue;
        }
        throw error;
      }
    }
  }
}
