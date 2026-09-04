import { randomUUID } from "node:crypto";
import type { AgentRunDelegatedAuthority } from "./agent-run-authority.types.js";

export type AgentRunApprovalClosureReason = "approval-scope-closed" | "run-aborted";

type ApprovalLease = {
  authority: AgentRunDelegatedAuthority;
  parent: AgentRunDelegatedAuthority;
  signals: readonly AbortSignal[];
  close: (reason?: AgentRunApprovalClosureReason) => void;
};

/** Owns subordinate claims and signal listeners; the registry validates their admitted parent. */
export class AgentRunApprovalLeases {
  private readonly leases = new Map<string, ApprovalLease>();

  constructor(
    private readonly onClose: (
      authority: AgentRunDelegatedAuthority,
      reason: AgentRunApprovalClosureReason,
    ) => void,
  ) {}

  claim(
    parent: AgentRunDelegatedAuthority,
    inputSignals: readonly AbortSignal[],
  ): AgentRunDelegatedAuthority {
    const signals = Object.freeze([...new Set(inputSignals)]);
    for (const signal of signals) {
      signal.throwIfAborted();
    }
    for (const lease of this.leases.values()) {
      if (
        lease.parent === parent &&
        lease.signals.length === signals.length &&
        signals.every((signal) => lease.signals.includes(signal))
      ) {
        return lease.authority;
      }
    }
    const authority = Object.freeze({ ...parent, claimId: randomUUID() });
    const close = (reason: AgentRunApprovalClosureReason = "approval-scope-closed") => {
      if (!this.leases.delete(authority.claimId)) {
        return;
      }
      for (const signal of signals) {
        signal.removeEventListener("abort", onAbort);
      }
      // Approval closure must not revoke whole-run resources such as secret egress.
      this.onClose(authority, reason);
    };
    const onAbort = () => close();
    this.leases.set(authority.claimId, { authority, parent, signals, close });
    for (const signal of signals) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    return authority;
  }

  isActive(parent: AgentRunDelegatedAuthority, claimId: string): boolean {
    const lease = this.leases.get(claimId);
    return lease?.parent === parent && lease.signals.every((signal) => !signal.aborted);
  }

  release(claimId: string): boolean {
    const lease = this.leases.get(claimId);
    lease?.close();
    return lease !== undefined;
  }

  close(parent?: AgentRunDelegatedAuthority): void {
    for (const lease of this.leases.values()) {
      if (!parent || lease.parent === parent) {
        lease.close("run-aborted");
      }
    }
  }
}
