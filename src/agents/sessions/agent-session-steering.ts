import type { AgentMessage } from "../runtime/index.js";

export type AgentSessionSteerReceipt = {
  committed: Promise<void>;
  cancel(): boolean;
};

type AgentQueueReceipt = {
  cancel(): boolean;
};

type SteeringState = "preparing" | "ready" | "queued" | "started" | "committed";

type SteeringItem = {
  text: string;
  state: SteeringState;
  enqueue?: () => AgentQueueReceipt;
  message?: AgentMessage;
  queueReceipt?: AgentQueueReceipt;
  resolveCommitted?: () => void;
  rejectCommitted?: (error: unknown) => void;
};

type AgentSessionSteerReservation = {
  receipt: AgentSessionSteerReceipt;
  admit(text: string, message: AgentMessage, enqueue: () => AgentQueueReceipt): boolean;
  reject(error: unknown): void;
};

export class AgentSessionSteering {
  private items: SteeringItem[] = [];

  constructor(private readonly onChange: () => void) {}

  reserve(text: string): AgentSessionSteerReservation {
    let resolveCommitted!: () => void;
    let rejectCommitted!: (error: unknown) => void;
    const committed = new Promise<void>((resolve, reject) => {
      resolveCommitted = resolve;
      rejectCommitted = reject;
    });
    // Cleanup may reject before the active-run waiter starts awaiting.
    void committed.catch(() => {});
    const item: SteeringItem = {
      text,
      state: "preparing",
      resolveCommitted,
      rejectCommitted,
    };
    const receipt: AgentSessionSteerReceipt = {
      committed,
      cancel: () => this.cancel(item),
    };
    this.items.push(item);
    this.onChange();
    return {
      receipt,
      admit: (preparedText, message, enqueue) => {
        if (!this.has(item) || item.state !== "preparing") {
          return false;
        }
        item.enqueue = enqueue;
        item.text = preparedText;
        item.message = message;
        item.state = "ready";
        this.drainReady();
        this.onChange();
        return true;
      },
      reject: (error) => {
        if (!this.has(item) || item.state !== "preparing") {
          return;
        }
        this.rejectItem(item, error);
        this.drainReady();
        this.onChange();
      },
    };
  }

  add(text: string, message: AgentMessage): void {
    this.items.push({ text, message, state: "queued" });
    this.onChange();
  }

  start(message: AgentMessage): boolean {
    const item = this.find(message);
    if (!item) {
      return false;
    }
    if (item.state === "queued") {
      item.state = "started";
      this.onChange();
    }
    return true;
  }

  resolve(message: AgentMessage): void {
    const item = this.find(message);
    if (!item) {
      return;
    }
    const wasPending = this.isPending(item);
    item.state = "committed";
    this.remove(item);
    item.resolveCommitted?.();
    if (wasPending) {
      this.onChange();
    }
  }

  reject(message: AgentMessage, error: unknown): void {
    const item = this.find(message);
    if (!item) {
      return;
    }
    const wasPending = this.isPending(item);
    this.rejectItem(item, error);
    if (wasPending) {
      this.onChange();
    }
  }

  clear(): string[] {
    const cleared: string[] = [];
    for (const item of this.items.slice()) {
      if (item.state === "started" || item.state === "committed") {
        continue;
      }
      if (item.state === "queued" && item.queueReceipt && !item.queueReceipt.cancel()) {
        // A drained entry remains owned by transcript persistence.
        item.state = "started";
        continue;
      }
      cleared.push(item.text);
      this.rejectItem(item, new Error("queued steering message was cleared"));
    }
    return cleared;
  }

  dispose(): void {
    const snapshot = this.items.slice();
    for (const item of snapshot) {
      item.queueReceipt?.cancel();
      this.rejectItem(item, new Error("agent session was disposed"));
    }
  }

  get pendingTexts(): string[] {
    return this.items.filter((item) => this.isPending(item)).map((item) => item.text);
  }

  get pendingCount(): number {
    return this.items.reduce((count, item) => count + (this.isPending(item) ? 1 : 0), 0);
  }

  private find(message: AgentMessage): SteeringItem | undefined {
    return this.items.find((item) => item.message === message);
  }

  private has(item: SteeringItem): boolean {
    return this.items.includes(item);
  }

  private isPending(item: SteeringItem): boolean {
    return item.state === "preparing" || item.state === "ready" || item.state === "queued";
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

  private drainReady(): void {
    while (true) {
      const next = this.items.find((item) => item.state === "preparing" || item.state === "ready");
      if (!next || next.state === "preparing") {
        return;
      }
      try {
        next.queueReceipt = next.enqueue?.();
        next.enqueue = undefined;
        next.state = "queued";
      } catch (error) {
        this.rejectItem(next, error);
      }
    }
  }

  private cancel(item: SteeringItem): boolean {
    if (!this.has(item) || item.state === "started" || item.state === "committed") {
      return false;
    }
    if (item.state === "queued" && item.queueReceipt && !item.queueReceipt.cancel()) {
      item.state = "started";
      this.onChange();
      return false;
    }
    this.rejectItem(item, new Error("queued steering message was cancelled"));
    this.drainReady();
    this.onChange();
    return true;
  }
}
