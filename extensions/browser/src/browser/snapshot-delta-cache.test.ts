import { describe, expect, it } from "vitest";
import { annotateRoleSnapshotDelta } from "./pw-role-snapshot.js";
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

function cacheScope(url: string) {
  return { profile: "openclaw", targetId: "tab-1", url, family };
}

describe("snapshot delta cache", () => {
  it("starts an unmarked baseline after navigation", () => {
    const ctx = createContext();
    recordSnapshotKeys(ctx, {
      ...cacheScope("https://example.com/first"),
      refs: { e1: { role: "button", name: "Save" } },
    });

    const previousKeys = getPreviousSnapshotKeys(ctx, cacheScope("https://example.com/second"));
    const snapshot = annotateRoleSnapshotDelta({
      snapshot: '- button "Continue" [ref=e1]',
      refs: { e1: { role: "button", name: "Continue" } },
      mode: "role",
      previousKeys,
    });

    expect(previousKeys).toBeUndefined();
    expect(snapshot.snapshot).toBe('- button "Continue" [ref=e1]');
    expect(snapshot.newElements).toBeUndefined();
  });

  it("marks elements added on a same-URL snapshot", () => {
    const ctx = createContext();
    const scope = cacheScope("https://example.com/form");
    recordSnapshotKeys(ctx, {
      ...scope,
      refs: { e1: { role: "button", name: "Save" } },
    });

    const snapshot = annotateRoleSnapshotDelta({
      snapshot: ['- button "Save" [ref=e7]', '- alert "Required" [ref=e8]'].join("\n"),
      refs: {
        e7: { role: "button", name: "Save" },
        e8: { role: "alert", name: "Required" },
      },
      mode: "role",
      previousKeys: getPreviousSnapshotKeys(ctx, scope),
    });

    expect(snapshot.snapshot).toContain('- alert "Required" [ref=e8] [new]');
    expect(snapshot.newElements).toBe(1);
  });
});
