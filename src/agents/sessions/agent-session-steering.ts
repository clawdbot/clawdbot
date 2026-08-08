import { createDeferred, type Deferred } from "../../shared/deferred.js";
import type { AgentMessage } from "../runtime/index.js";

export type AgentSessionSteerReceipt = {
  accepted: Promise<void>;
  committed: Promise<void>;
  cancel(): boolean;
};

type QueueReceipt = { cancel(): boolean };
type SteeringItem = {
  accepted?: Deferred;
  committed?: Deferred;
  enqueue?: () => QueueReceipt;
  message?: AgentMessage;
  queueReceipt?: QueueReceipt;
  text: string;
};
export class AgentSessionSteering {
  private readonly pending: SteeringItem[] = [];
  private readonly byMessage = new Map<AgentMessage, SteeringItem>();

  constructor(private readonly onChange: () => void) {}

  reserve(text: string) {
    const accepted = createDeferred();
    const committed = createDeferred();
    void accepted.promise.catch(() => {});
    void committed.promise.catch(() => {});
    const item: SteeringItem = { accepted, committed, text };
    this.pending.push(item);
    this.onChange();
    return {
      receipt: {
        accepted: accepted.promise,
        committed: committed.promise,
        cancel: () => this.cancel(item),
      },
      admit: (preparedText: string, message: AgentMessage, enqueue: () => QueueReceipt) => {
        if (!this.pending.includes(item) || item.enqueue || item.queueReceipt) {
          return false;
        }
        Object.assign(item, { text: preparedText, message, enqueue });
        this.drain();
        this.onChange();
        return true;
      },
      reject: (error: unknown) => {
        if (this.pending.includes(item) && !item.queueReceipt) {
          this.fail(item, error);
          this.drain();
          this.onChange();
        }
      },
    };
  }

  start(message: AgentMessage): boolean {
    const item = this.byMessage.get(message);
    if (!item) {
      return false;
    }
    if (this.removePending(item)) {
      this.onChange();
    }
    return true;
  }

  resolve(message: AgentMessage): void {
    this.settle(message);
  }
  reject(message: AgentMessage, error: unknown): void {
    this.settle(message, error);
  }

  clear(): string[] {
    const cleared: string[] = [];
    let changed = false;
    for (const item of this.pending.slice()) {
      if (item.queueReceipt && !item.queueReceipt.cancel()) {
        this.removePending(item);
        changed = true;
        continue;
      }
      cleared.push(item.text);
      this.fail(item, new Error("queued steering message was cleared"));
      changed = true;
    }
    this.drain();
    if (changed) {
      this.onChange();
    }
    return cleared;
  }

  dispose(): void {
    for (const item of new Set([...this.pending, ...this.byMessage.values()])) {
      item.queueReceipt?.cancel();
      this.fail(item, new Error("agent session was disposed"));
    }
  }

  get pendingTexts(): string[] {
    return this.pending.map((item) => item.text);
  }
  get pendingCount(): number {
    return this.pending.length;
  }

  private settle(message: AgentMessage, error?: unknown): void {
    const item = this.byMessage.get(message);
    if (!item) {
      return;
    }
    const notify = this.removePending(item);
    this.byMessage.delete(message);
    if (error === undefined) {
      item.committed?.resolve(undefined);
    } else {
      item.committed?.reject(error);
    }
    if (notify) {
      this.onChange();
    }
  }

  private removePending(item: SteeringItem): boolean {
    const index = this.pending.indexOf(item);
    if (index < 0) {
      return false;
    }
    this.pending.splice(index, 1);
    return true;
  }

  private fail(item: SteeringItem, error: unknown): void {
    this.removePending(item);
    if (item.message) {
      this.byMessage.delete(item.message);
    }
    if (!item.queueReceipt) {
      item.accepted?.reject(error);
    }
    item.committed?.reject(error);
  }

  private drain(): void {
    while (true) {
      const item = this.pending.find((candidate) => !candidate.queueReceipt);
      if (!item?.enqueue || !item.message) {
        return;
      }
      try {
        item.queueReceipt = item.enqueue();
        item.enqueue = undefined;
        this.byMessage.set(item.message, item);
        item.accepted?.resolve(undefined);
      } catch (error) {
        this.fail(item, error);
      }
    }
  }

  private cancel(item: SteeringItem): boolean {
    if (!this.pending.includes(item)) {
      return false;
    }
    if (item.queueReceipt && !item.queueReceipt.cancel()) {
      this.removePending(item);
      this.onChange();
      return false;
    }
    this.fail(item, new Error("queued steering message was cancelled"));
    this.drain();
    this.onChange();
    return true;
  }
}
