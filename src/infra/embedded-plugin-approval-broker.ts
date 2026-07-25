// Provides the process-local plugin approval path used by embedded TUI runs.
import { randomUUID } from "node:crypto";
import type { ExecApprovalDecision } from "./exec-approvals.js";
import { resolveCanonicalPluginApprovalRequestAllowedDecisions } from "./plugin-approval-canonical-decisions.js";
import type {
  PluginApprovalRequest,
  PluginApprovalRequestPayload,
  PluginApprovalResolved,
} from "./plugin-approvals.js";

type PendingApproval = {
  record: PluginApprovalRequest;
  timer: ReturnType<typeof setTimeout>;
  resolve: (decision: ExecApprovalDecision | null) => void;
  reject: (error: unknown) => void;
};

type ApprovalEvent =
  | { event: "plugin.approval.requested"; payload: PluginApprovalRequest }
  | { event: "plugin.approval.resolved"; payload: PluginApprovalResolved }
  | { event: "plugin.approval.removed"; payload: { id: string } };

let activeBroker: EmbeddedPluginApprovalBroker | null = null;

export class EmbeddedPluginApprovalBroker {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(event: ApprovalEvent) => void>();

  subscribe(listener: (event: ApprovalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listPending(): PluginApprovalRequest[] {
    return [...this.pending.values()].map((entry) => entry.record);
  }

  async request(params: {
    request: PluginApprovalRequestPayload;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ id: string; decision: ExecApprovalDecision | null }> {
    if (params.signal?.aborted) {
      throw params.signal.reason ?? new Error("approval request aborted");
    }
    const id = `plugin:${randomUUID()}`;
    const createdAtMs = Date.now();
    const record: PluginApprovalRequest = {
      id,
      request: params.request,
      createdAtMs,
      expiresAtMs: createdAtMs + params.timeoutMs,
    };
    let resolve!: (decision: ExecApprovalDecision | null) => void;
    let reject!: (error: unknown) => void;
    const decision = new Promise<ExecApprovalDecision | null>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const timer = setTimeout(() => {
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      this.pending.delete(id);
      entry.resolve(null);
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    }, params.timeoutMs);
    timer.unref?.();
    this.pending.set(id, { record, timer, resolve, reject });

    const abort = () => {
      const entry = this.pending.get(id);
      if (!entry) {
        return;
      }
      clearTimeout(entry.timer);
      this.pending.delete(id);
      entry.reject(params.signal?.reason ?? new Error("approval request aborted"));
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    };
    params.signal?.addEventListener("abort", abort, { once: true });

    this.emit({ event: "plugin.approval.requested", payload: record });
    try {
      return { id, decision: await decision };
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
  }

  resolve(id: string, decision: ExecApprovalDecision): boolean {
    const entry = this.pending.get(id);
    if (
      !entry ||
      !resolveCanonicalPluginApprovalRequestAllowedDecisions(entry.record.request).includes(
        decision,
      )
    ) {
      return false;
    }
    clearTimeout(entry.timer);
    this.pending.delete(id);
    entry.resolve(decision);
    this.emit({
      event: "plugin.approval.resolved",
      payload: {
        id,
        decision,
        resolvedBy: "tui:embedded",
        ts: Date.now(),
        request: entry.record.request,
      },
    });
    return true;
  }

  stop(reason: unknown = new Error("embedded plugin approval broker stopped")): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private emit(event: ApprovalEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

export function setEmbeddedPluginApprovalBroker(broker: EmbeddedPluginApprovalBroker | null): void {
  activeBroker = broker;
}

export function clearEmbeddedPluginApprovalBroker(broker: EmbeddedPluginApprovalBroker): void {
  if (activeBroker === broker) {
    activeBroker = null;
  }
}

export function getEmbeddedPluginApprovalBroker(): EmbeddedPluginApprovalBroker | null {
  return activeBroker;
}
