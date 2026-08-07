import type { AgentMessage } from "../runtime/index.js";

export type AgentSessionSteerReceipt = {
  committed: Promise<void>;
  cancel(): boolean;
};

type AgentQueueReceipt = {
  cancel(): boolean;
};

type SteeringItem = {
  text: string;
  message: AgentMessage;
  started: boolean;
  queueReceipt?: AgentQueueReceipt;
  receipt?: AgentSessionSteerReceipt;
  resolveCommitted?: () => void;
  rejectCommitted?: (error: unknown) => void;
};

export class AgentSessionSteering {
  private items: SteeringItem[] = [];

  constructor(private readonly onChange: () => void) {}

  add(text: string, message: AgentMessage): void;
  add(
    text: string,
    message: AgentMessage,
    queueReceipt: AgentQueueReceipt,
  ): AgentSessionSteerReceipt;
  add(
    text: string,
    message: AgentMessage,
    queueReceipt?: AgentQueueReceipt,
  ): AgentSessionSteerReceipt | void {
    const item: SteeringItem = { text, message, started: false, queueReceipt };
    if (queueReceipt) {
      let resolveCommitted!: () => void;
      let rejectCommitted!: (error: unknown) => void;
      const committed = new Promise<void>((resolve, reject) => {
        resolveCommitted = resolve;
        rejectCommitted = reject;
      });
      // Cleanup may reject before the active-run waiter starts awaiting.
      void committed.catch(() => {});
      item.resolveCommitted = resolveCommitted;
      item.rejectCommitted = rejectCommitted;
      item.receipt = {
        committed,
        cancel: () => this.cancel(item),
      };
    }

    this.items.push(item);
    this.onChange();
    return item.receipt;
  }

  start(message: AgentMessage): boolean {
    const item = this.find(message);
    if (!item) {
      return false;
    }
    if (!item.started) {
      item.started = true;
      this.onChange();
    }
    return true;
  }

  resolve(message: AgentMessage): void {
    const item = this.find(message);
    if (!item) {
      return;
    }
    this.remove(item);
    item.resolveCommitted?.();
    if (!item.started) {
      this.onChange();
    }
  }

  reject(message: AgentMessage, error: unknown): void {
    const item = this.find(message);
    if (!item) {
      return;
    }
    this.rejectItem(item, error);
    this.onChange();
  }

  clear(): string[] {
    const cleared: string[] = [];
    for (const item of this.items.slice()) {
      if (item.started) {
        continue;
      }
      if (item.queueReceipt && !item.queueReceipt.cancel()) {
        // A drained entry remains owned by transcript persistence.
        item.started = true;
        continue;
      }
      cleared.push(item.text);
      this.rejectItem(item, new Error("queued steering message was cleared"));
    }
    return cleared;
  }

  dispose(): void {
    for (const item of this.items.slice()) {
      item.queueReceipt?.cancel();
      this.rejectItem(item, new Error("agent session was disposed"));
    }
  }

  get pendingTexts(): string[] {
    return this.items.filter((item) => !item.started).map((item) => item.text);
  }

  get pendingCount(): number {
    return this.items.reduce((count, item) => count + (item.started ? 0 : 1), 0);
  }

  private find(message: AgentMessage): SteeringItem | undefined {
    return this.items.find((item) => item.message === message);
  }

  private remove(item: SteeringItem): void {
    const index = this.items.indexOf(item);
    if (index !== -1) {
      this.items.splice(index, 1);
    }
  }

  private rejectItem(item: SteeringItem, error: unknown): void {
    this.remove(item);
    item.rejectCommitted?.(error);
  }

  private cancel(item: SteeringItem): boolean {
    if (!item.queueReceipt?.cancel()) {
      return false;
    }
    this.rejectItem(item, new Error("queued steering message was cancelled"));
    this.onChange();
    return true;
  }
}
