import { Buffer } from "node:buffer";

// Providers commonly cap native calls at 1,024, while the relay can retain both
// a provider id and a synthetic owner-facing alias for one lifecycle.
export const MAX_RELAY_TOOL_CALL_IDENTITIES = 2_048;
export const MAX_RELAY_TOOL_CALL_IDENTITY_BYTES = 1024 * 1024;

type RelayToolCallEntry = {
  agentCompleted?: true;
  providerCompleted?: true;
  cancelledTurnId?: string;
};

export class RelayToolCallLedger {
  // Identities remain for the session lifetime even when individual terminal
  // facts clear, so late events cannot regain admission after capacity pressure.
  private readonly entries = new Map<string, RelayToolCallEntry>();
  private retainedBytes = 0;
  private overflowReported = false;

  constructor(
    private readonly options: {
      onOverflow: () => void;
      maxEntries?: number;
      maxBytes?: number;
    },
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(callId: string): boolean {
    return this.entries.has(callId);
  }

  tryAdmit(callIds: Iterable<string>): boolean {
    const uniqueCallIds = new Set(callIds);
    const additions: Array<{ callId: string; bytes: number }> = [];
    let additionBytes = 0;
    for (const callId of uniqueCallIds) {
      if (callId && !this.entries.has(callId)) {
        const bytes = Buffer.byteLength(callId, "utf8");
        additions.push({ callId, bytes });
        additionBytes += bytes;
      }
    }
    const maxEntries = this.options.maxEntries ?? MAX_RELAY_TOOL_CALL_IDENTITIES;
    const maxBytes = this.options.maxBytes ?? MAX_RELAY_TOOL_CALL_IDENTITY_BYTES;
    if (
      this.entries.size + additions.length > maxEntries ||
      this.retainedBytes + additionBytes > maxBytes
    ) {
      if (!this.overflowReported) {
        this.overflowReported = true;
        this.options.onOverflow();
      }
      return false;
    }
    for (const addition of additions) {
      this.entries.set(addition.callId, {});
      this.retainedBytes += addition.bytes;
    }
    return true;
  }

  private mark(callIds: Iterable<string>, mutate: (entry: RelayToolCallEntry) => void): boolean {
    const retainedCallIds = [...callIds];
    if (!this.tryAdmit(retainedCallIds)) {
      return false;
    }
    for (const callId of retainedCallIds) {
      const entry = this.entries.get(callId);
      if (entry) {
        mutate(entry);
      }
    }
    return true;
  }

  isAgentCompleted(callId: string): boolean {
    return this.entries.get(callId)?.agentCompleted === true;
  }

  markAgentCompleted(callIds: Iterable<string>): boolean {
    return this.mark(callIds, (entry) => {
      // Completion is terminal for the owner-facing call. Do not let stale
      // cancellation metadata route a later result through cancellation again.
      entry.agentCompleted = true;
      delete entry.cancelledTurnId;
    });
  }

  deleteAgentCompleted(callId: string): void {
    delete this.entries.get(callId)?.agentCompleted;
  }

  isProviderCompleted(callId: string): boolean {
    return this.entries.get(callId)?.providerCompleted === true;
  }

  markProviderCompleted(callIds: Iterable<string>): boolean {
    return this.mark(callIds, (entry) => {
      entry.providerCompleted = true;
    });
  }

  deleteProviderCompleted(callId: string): void {
    delete this.entries.get(callId)?.providerCompleted;
  }

  clearProviderCompleted(): void {
    for (const entry of this.entries.values()) {
      delete entry.providerCompleted;
    }
  }

  hasCancelled(callId: string): boolean {
    return this.entries.get(callId)?.cancelledTurnId !== undefined;
  }

  cancelledTurnId(callId: string): string | undefined {
    return this.entries.get(callId)?.cancelledTurnId;
  }

  markCancelled(callIds: Iterable<string>, turnId: string): boolean {
    return this.mark(callIds, (entry) => {
      // The first cancel owns the original turn until completion. Retries and
      // late cancellation events must not replace or revive that lifecycle fact.
      if (!entry.agentCompleted && entry.cancelledTurnId === undefined) {
        entry.cancelledTurnId = turnId;
      }
    });
  }

  deleteCancelled(callId: string): void {
    delete this.entries.get(callId)?.cancelledTurnId;
  }

  cancelledCallIds(): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.cancelledTurnId !== undefined)
      .map(([callId]) => callId);
  }

  clearCancelled(): void {
    for (const entry of this.entries.values()) {
      delete entry.cancelledTurnId;
    }
  }
}
