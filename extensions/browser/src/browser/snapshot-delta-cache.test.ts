import { describe, expect, it } from "vitest";
import { finalizeRoleSnapshot } from "./pw-role-snapshot.js";
import type { BrowserRouteContext, BrowserServerState } from "./server-context.types.js";
import {
  clearSnapshotKeysForTab,
  getPreviousSnapshotKeys,
  recordSnapshotKeys,
  type SnapshotDeltaFamily,
} from "./snapshot-delta-cache.js";

const family: SnapshotDeltaFamily = { identity: "role", interactive: true };

function createContext(state: BrowserServerState = {} as BrowserServerState): BrowserRouteContext {
  return { state: () => state } as BrowserRouteContext;
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

  it("marks new elements across requests sharing one browser runtime", () => {
    const state = {} as BrowserServerState;
    const firstRequest = createContext(state);
    const secondRequest = createContext(state);
    const scope = cacheScope("pw:document-1");

    recordSnapshotKeys(firstRequest, {
      ...scope,
      refs: { e1: { role: "button", name: "Save" } },
    });

    const snapshot = finalizeRoleSnapshot({
      snapshot: ['- button "Save" [ref=e7]', '- alert "Required" [ref=e8]'].join("\n"),
      refs: {
        e7: { role: "button", name: "Save" },
        e8: { role: "alert", name: "Required" },
      },
      delta: { mode: "role", previousKeys: getPreviousSnapshotKeys(secondRequest, scope) },
    });

    expect(snapshot.snapshot).toContain('- alert "Required" [ref=e8] [new]');
    expect(snapshot.newElements).toBe(1);
  });

  it("does not reuse snapshot baselines after a browser runtime restart", () => {
    const previousRuntime = createContext();
    const restartedRuntime = createContext();
    const scope = cacheScope("pw:document-1");

    recordSnapshotKeys(previousRuntime, {
      ...scope,
      refs: { e1: { role: "button", name: "Save" } },
    });

    expect(getPreviousSnapshotKeys(restartedRuntime, scope)).toBeUndefined();
  });

  it.each([
    { name: "profile", scope: { profile: "other" } },
    { name: "tab", scope: { targetId: "tab-2" } },
    { name: "snapshot options", scope: { family: { ...family, compact: true } } },
  ])("isolates snapshot baselines by $name", ({ scope: alternateScope }) => {
    const state = {} as BrowserServerState;
    const firstRequest = createContext(state);
    const secondRequest = createContext(state);
    const scope = cacheScope("pw:document-1");

    recordSnapshotKeys(firstRequest, {
      ...scope,
      refs: { e1: { role: "button", name: "Save" } },
    });

    expect(getPreviousSnapshotKeys(secondRequest, { ...scope, ...alternateScope })).toBeUndefined();
  });

  it("clears a closed tab's baseline from a later browser request", () => {
    const state = {} as BrowserServerState;
    const snapshotRequest = createContext(state);
    const closeRequest = createContext(state);
    const laterRequest = createContext(state);
    const scope = cacheScope("pw:document-1");
    const otherTab = { ...scope, targetId: "tab-2" };

    for (const tabScope of [scope, otherTab]) {
      recordSnapshotKeys(snapshotRequest, {
        ...tabScope,
        refs: { e1: { role: "button", name: "Save" } },
      });
    }

    clearSnapshotKeysForTab(closeRequest, scope.profile, scope.targetId);

    expect(getPreviousSnapshotKeys(laterRequest, scope)).toBeUndefined();
    expect(getPreviousSnapshotKeys(laterRequest, otherTab)).toBeInstanceOf(Set);
  });

  it("evicts the oldest snapshot baseline after the 32-entry runtime limit", () => {
    const state = {} as BrowserServerState;
    const firstRequest = createContext(state);
    const secondRequest = createContext(state);

    for (let index = 0; index < 33; index += 1) {
      recordSnapshotKeys(firstRequest, {
        ...cacheScope("pw:document-1"),
        targetId: `tab-${index}`,
        refs: { e1: { role: "button", name: "Save" } },
      });
    }

    expect(
      getPreviousSnapshotKeys(secondRequest, {
        ...cacheScope("pw:document-1"),
        targetId: "tab-0",
      }),
    ).toBeUndefined();
    expect(
      getPreviousSnapshotKeys(secondRequest, {
        ...cacheScope("pw:document-1"),
        targetId: "tab-32",
      }),
    ).toBeInstanceOf(Set);
  });
});
