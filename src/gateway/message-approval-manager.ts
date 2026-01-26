import { randomUUID } from "node:crypto";

export type MessageApprovalDecision = "allow" | "deny";

export type MessageApprovalRequestPayload = {
  action: string;
  channel: string;
  to: string;
  message?: string | null;
  mediaUrl?: string | null;
  agentId?: string | null;
  sessionKey?: string | null;
};

export type MessageApprovalRecord = {
  id: string;
  request: MessageApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
  resolvedAtMs?: number;
  decision?: MessageApprovalDecision;
  resolvedBy?: string | null;
};

type PendingEntry = {
  record: MessageApprovalRecord;
  resolve: (decision: MessageApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class MessageApprovalManager {
  private pending = new Map<string, PendingEntry>();

  create(
    request: MessageApprovalRequestPayload,
    timeoutMs: number,
    id?: string | null,
  ): MessageApprovalRecord {
    const now = Date.now();
    const resolvedId = id && id.trim().length > 0 ? id.trim() : `msg-${randomUUID()}`;
    const record: MessageApprovalRecord = {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs: now + timeoutMs,
    };
    return record;
  }

  async waitForDecision(
    record: MessageApprovalRecord,
    timeoutMs: number,
  ): Promise<MessageApprovalDecision | null> {
    return await new Promise<MessageApprovalDecision | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(record.id);
        resolve(null);
      }, timeoutMs);
      this.pending.set(record.id, { record, resolve, reject, timer });
    });
  }

  resolve(
    recordId: string,
    decision: MessageApprovalDecision,
    resolvedBy?: string | null,
  ): boolean {
    const pending = this.pending.get(recordId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = Date.now();
    pending.record.decision = decision;
    pending.record.resolvedBy = resolvedBy ?? null;
    this.pending.delete(recordId);
    pending.resolve(decision);
    return true;
  }

  getSnapshot(recordId: string): MessageApprovalRecord | null {
    const entry = this.pending.get(recordId);
    return entry?.record ?? null;
  }
}
