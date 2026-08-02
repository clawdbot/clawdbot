// Provides the process-local plugin approval path used by embedded TUI runs.
import { randomUUID } from "node:crypto";
import { notifyListeners } from "../shared/listeners.js";
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
    onRegistered?: (registration: { id: string }) => void;
  }): Promise<{ outcome: "resolved"; decision: ExecApprovalDecision } | { outcome: "timed-out" }> {
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
    const awaitDecision = async () => {
      const result = await decision;
      if (params.signal?.aborted) {
        throw params.signal.reason ?? new Error("approval request aborted");
      }
      return result === null
        ? { outcome: "timed-out" as const }
        : { outcome: "resolved" as const, decision: result };
    };
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
    const pendingEntry = { record, timer, resolve, reject };
    this.pending.set(id, pendingEntry);

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
    try {
      params.onRegistered?.({ id });
    } catch (error) {
      if (this.pending.get(id) === pendingEntry) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve(null);
        this.emit({ event: "plugin.approval.removed", payload: { id } });
      }
      throw error;
    }
    if (this.pending.get(id) !== pendingEntry) {
      return await awaitDecision();
    }
    if (params.signal?.aborted) {
      clearTimeout(timer);
      this.pending.delete(id);
      resolve(null);
      this.emit({ event: "plugin.approval.removed", payload: { id } });
      throw params.signal.reason ?? new Error("approval request aborted");
    }
    params.signal?.addEventListener("abort", abort, { once: true });
    this.emit({ event: "plugin.approval.requested", payload: record });
    try {
      return await awaitDecision();
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
    // Stop one embedded-backend lifecycle generation. The broker intentionally
    // remains reusable so a stopped TUI backend can subscribe and run again.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(reason);
      this.emit({ event: "plugin.approval.removed", payload: { id } });
    }
    this.pending.clear();
    this.listeners.clear();
  }

  private emit(event: ApprovalEvent): void {
    notifyListeners(this.listeners, event);
  }
}
