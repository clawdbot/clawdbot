import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";

const VOICE_TRANSCRIPT_MAX_CHARS = 8_000;
const VOICE_TRANSCRIPT_QUEUE_MAX_PENDING = 40;
export const VOICE_TRANSCRIPT_MAX_UNRESOLVED = VOICE_TRANSCRIPT_QUEUE_MAX_PENDING + 1;
const VOICE_TRANSCRIPT_QUEUE_MAX_PENDING_CHARS =
  VOICE_TRANSCRIPT_QUEUE_MAX_PENDING * VOICE_TRANSCRIPT_MAX_CHARS;
const VOICE_TRANSCRIPT_QUEUE_OVERFLOW_MESSAGE =
  "Voice transcript persistence could not keep up; the realtime session was stopped.";

export function normalizeVoiceTranscriptText(text: string): string {
  return truncateUtf16Safe(text.trim(), VOICE_TRANSCRIPT_MAX_CHARS);
}

export const VOICE_TRANSCRIPT_QUEUE_POLICY = {
  maxPendingCount: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING,
  overflowMessage: VOICE_TRANSCRIPT_QUEUE_OVERFLOW_MESSAGE,
  createQueue: () =>
    new BoundedSerialQueue({
      maxPendingCount: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING,
      maxPendingWeight: VOICE_TRANSCRIPT_QUEUE_MAX_PENDING_CHARS,
    }),
} as const;

type VoiceTranscriptOperationOwner = {
  queue: BoundedSerialQueue;
  closePromise?: Promise<void>;
};

class VoiceTranscriptOperationRegistry {
  private readonly owners = new Map<string, VoiceTranscriptOperationOwner>();

  constructor(
    private readonly queuePolicy: Pick<typeof VOICE_TRANSCRIPT_QUEUE_POLICY, "createQueue">,
  ) {}

  private getOrCreate(key: string): VoiceTranscriptOperationOwner {
    const existing = this.owners.get(key);
    if (existing) {
      return existing;
    }
    const created = { queue: this.queuePolicy.createQueue() };
    this.owners.set(key, created);
    return created;
  }

  private cleanup(key: string, owner: VoiceTranscriptOperationOwner): void {
    if (
      this.owners.get(key) === owner &&
      !owner.closePromise &&
      owner.queue.isIdle &&
      !owner.queue.didOverflow
    ) {
      this.owners.delete(key);
    }
  }

  async run<T>(
    key: string,
    operation: () => Promise<T>,
    options: { weight?: number; waitForCapacity?: boolean } = {},
  ): Promise<T> {
    while (true) {
      const owner = this.getOrCreate(key);
      if (owner.closePromise) {
        if (options.waitForCapacity !== true) {
          throw new Error("voice transcript persistence session is closing");
        }
        try {
          await owner.closePromise;
        } catch {
          // Control work retries on a fresh owner after a failed close releases this one.
        }
        continue;
      }
      // Control work may wait for the accepted transcript prefix, but must not
      // be the event that seals transcript admission. Real overflow stays terminal.
      const admission = owner.queue.enqueue(operation, {
        weight: options.weight,
        sealOnOverflow: options.waitForCapacity !== true,
      });
      if (admission.accepted) {
        void admission.completion.then(
          () => this.cleanup(key, owner),
          () => this.cleanup(key, owner),
        );
        return await admission.completion;
      }
      if (owner.queue.didOverflow || options.waitForCapacity !== true) {
        throw new Error(
          owner.queue.didOverflow
            ? "voice transcript persistence queue capacity exceeded"
            : "voice transcript persistence session is closed",
        );
      }
      if (admission.reason !== "capacity") {
        throw new Error("voice transcript persistence session is closed");
      }
      await owner.queue.flush();
      this.cleanup(key, owner);
    }
  }

  async close(key: string, operation: () => Promise<void>): Promise<void> {
    const owner = this.getOrCreate(key);
    if (!owner.closePromise) {
      // Seal synchronously so no transcript can enter behind the close barrier.
      owner.queue.seal();
      owner.closePromise = owner.queue.flush({ requireSuccess: true }).then(operation);
    }
    try {
      await owner.closePromise;
    } finally {
      if (this.owners.get(key) === owner) {
        this.owners.delete(key);
      }
    }
  }

  clear(): void {
    this.owners.clear();
  }
}

export function createVoiceTranscriptOperationRegistry(
  queuePolicy: Pick<typeof VOICE_TRANSCRIPT_QUEUE_POLICY, "createQueue">,
): VoiceTranscriptOperationRegistry {
  return new VoiceTranscriptOperationRegistry(queuePolicy);
}
