import { describe, expect, it } from "vitest";
import { finalizeRoleSnapshot } from "./pw-role-snapshot.js";
import type { BrowserRouteContext } from "./server-context.types.js";
import {
  getPreviousSnapshotKeys,
  recordSnapshotKeys,
  type SnapshotDeltaFamily,
} from "./snapshot-delta-cache.js";

const family: SnapshotDeltaFamily = { identity: "role", interactive: true };

function createContext(): BrowserRouteContext {
  return {} as BrowserRouteContext;
}

function cacheScope(documentIdentity: string) {
  return { profile: "openclaw", targetId: "tab-1", documentIdentity, family };
}

describe("snapshot delta cache", () => {
  it("starts an unmarked baseline after a same-URL reload", () => {
    const ctx = createContext();
    recordSnapshotKeys(ctx, {
      ...cacheScope("pw:document-1"),
      refs: { e1: { role: "button", name: "Save" } },
    });

    const previousKeys = getPreviousSnapshotKeys(ctx, cacheScope("pw:document-2"));
    const snapshot = finalizeRoleSnapshot({
      snapshot: '- button "Continue" [ref=e1]',
      refs: { e1: { role: "button", name: "Continue" } },
      delta: { mode: "role", previousKeys },
    });

    expect(previousKeys).toBeUndefined();
    expect(snapshot.snapshot).toBe('- button "Continue" [ref=e1]');
    expect(snapshot.newElements).toBeUndefined();
  });

  it("marks elements added in the same document", () => {
    const ctx = createContext();
    const scope = cacheScope("pw:document-1");
    recordSnapshotKeys(ctx, {
      ...scope,
      refs: { e1: { role: "button", name: "Save" } },
    });

    const snapshot = finalizeRoleSnapshot({
      snapshot: ['- button "Save" [ref=e7]', '- alert "Required" [ref=e8]'].join("\n"),
      refs: {
        e7: { role: "button", name: "Save" },
        e8: { role: "alert", name: "Required" },
      },
      delta: { mode: "role", previousKeys: getPreviousSnapshotKeys(ctx, scope) },
    });

    expect(snapshot.snapshot).toContain('- alert "Required" [ref=e8] [new]');
    expect(snapshot.newElements).toBe(1);
  });
});
