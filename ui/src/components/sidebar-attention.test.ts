/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequest } from "../app/exec-approval.ts";
import {
  addDismissal,
  dismissalStoreKey,
  pruneDismissals,
  type SidebarAttentionKind,
} from "./sidebar-attention-dismissals.ts";
import { buildSidebarAttentionItems } from "./sidebar-attention-items.ts";

function approval(id: string): ExecApprovalRequest {
  return {
    id,
    kind: "exec",
    request: { command: "echo ok" },
    createdAtMs: 1,
    expiresAtMs: 2,
  };
}

function approvalItems(queue: readonly ExecApprovalRequest[]) {
  return buildSidebarAttentionItems({
    cronJobs: [],
    modelAuthStatus: null,
    approvalQueue: queue,
    now: 0,
  }).filter((item) => item.kind === "pendingApproval");
}

describe("pending approval attention", () => {
  it("builds a warning chip only while approvals are pending", () => {
    expect(approvalItems([])).toEqual([]);

    expect(approvalItems([approval("exec:b")])).toMatchObject([
      {
        kind: "pendingApproval",
        severity: "warning",
        icon: "shieldCheck",
        action: { kind: "openApprovals" },
      },
    ]);
  });

  it("sorts queue ids into a signature that changes for a new approval", () => {
    const first = approvalItems([approval("exec:b"), approval("exec:a")])[0];
    const changed = approvalItems([approval("exec:b"), approval("exec:a"), approval("exec:c")])[0];

    if (!first || !changed) {
      throw new Error("expected pending approval attention items");
    }

    expect(first.signature).toBe("exec:a\nexec:b");
    expect(changed.signature).toBe("exec:a\nexec:b\nexec:c");
    expect(pruneDismissals({ pendingApproval: first.signature }, [changed])).toEqual({});
  });
});

describe("pruneDismissals", () => {
  const chip = (kind: SidebarAttentionKind, signature: string) => ({ kind, signature });

  it("keeps a dismissal while the same entity set is still affected", () => {
    const dismissals = { cronFailed: "alpha\nbeta" };
    expect(pruneDismissals(dismissals, [chip("cronFailed", "alpha\nbeta")])).toBe(dismissals);
  });

  it("drops a dismissal when the affected set changes so the chip resurfaces", () => {
    expect(
      pruneDismissals({ cronFailed: "alpha", modelAuthExpired: "openai" }, [
        chip("cronFailed", "alpha\nbeta"),
        chip("modelAuthExpired", "openai"),
      ]),
    ).toEqual({ modelAuthExpired: "openai" });
  });

  it("drops a dismissal once the underlying state clears", () => {
    expect(pruneDismissals({ cronFailed: "alpha" }, [])).toEqual({});
  });
});

describe("addDismissal", () => {
  function createStorageMock(): Storage {
    const map = new Map<string, string>();
    return {
      get length() {
        return map.size;
      },
      clear: () => map.clear(),
      getItem: (key: string) => map.get(key) ?? null,
      key: (index: number) => [...map.keys()][index] ?? null,
      removeItem: (key: string) => void map.delete(key),
      setItem: (key: string, value: string) => void map.set(key, value),
    };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("merges with the persisted map so another tab's dismissal survives", () => {
    vi.stubGlobal("localStorage", createStorageMock());
    const key = dismissalStoreKey("ws://gateway.test");
    // Another tab dismissed a cron chip after this tab last loaded.
    localStorage.setItem(key, JSON.stringify({ cronFailed: "alpha" }));

    const next = addDismissal("ws://gateway.test", "modelAuthExpired", "openai");

    const expected = { cronFailed: "alpha", modelAuthExpired: "openai" };
    expect(next).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(key) ?? "null")).toEqual(expected);
  });
});
