// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "./session-capability.test-support.ts";
import type { SessionListSnapshot } from "./session-capability.ts";

const SESSION_EVENT_REFRESH_DEBOUNCE_MS = 200;

function rowPinned(result: SessionsListResult | null, key: string): boolean {
  return result?.sessions.find((row) => row.key === key)?.pinned === true;
}

// Shape of `buildGatewaySessionEventFields`: every payload carries the server's
// current pin state, which is the pre-click value while a patch is in flight.
function sessionChangedPayload(key: string, pinned: boolean) {
  return {
    sessionKey: key,
    reason: "send",
    key,
    kind: "direct",
    updatedAt: 3,
    pinned,
    pinnedAt: pinned ? 2 : null,
  };
}

function pinHarness(options: {
  patchResponse: (call: number) => Promise<unknown>;
  serverPinned: () => boolean;
}) {
  const key = "agent:main:alpha";
  let patchCalls = 0;
  let listTs = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      patchCalls += 1;
      return await options.patchResponse(patchCalls);
    }
    if (method === "sessions.list") {
      listTs += 1;
      return sessionsResult(
        [{ key, kind: "direct", updatedAt: 1, pinned: options.serverPinned() }],
        listTs,
      );
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  const harness = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
  return { ...harness, key };
}

describe("session pin mutations", () => {
  it("keeps a pending pin through a stale Gateway event and its canonical refresh", async () => {
    vi.useFakeTimers();
    try {
      const committed = createDeferred<unknown>();
      let serverPinned = false;
      const { gateway, key, emitEvent } = pinHarness({
        patchResponse: () => committed.promise,
        serverPinned: () => serverPinned,
      });
      const sessions = createTestSessionCapability(gateway);

      await sessions.refresh({ force: true });
      const operation = sessions.patch(key, { pinned: true });
      expect(rowPinned(sessions.state.result, key)).toBe(true);

      // A routine turn event for the same row, still carrying the pre-patch pin
      // value, reaches both the direct merge and the canonical list refresh.
      const stalePayload = sessionChangedPayload(key, false);
      sessions.reconcileChanged(stalePayload);
      expect(rowPinned(sessions.state.result, key)).toBe(true);

      emitEvent({ type: "event", event: "sessions.changed", payload: stalePayload });
      await vi.advanceTimersByTimeAsync(SESSION_EVENT_REFRESH_DEBOUNCE_MS);
      expect(rowPinned(sessions.state.result, key)).toBe(true);

      serverPinned = true;
      committed.resolve({ ok: true, key, path: "", entry: {} });
      await expect(operation).resolves.toBeTruthy();
      expect(rowPinned(sessions.state.result, key)).toBe(true);
      sessions.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls a rejected unpin back across the primary and filtered lists", async () => {
    const { gateway, key } = pinHarness({
      patchResponse: () => Promise.reject(new Error("pin rejected")),
      serverPinned: () => true,
    });
    const sessions = createTestSessionCapability(gateway);
    // The archived/all sidebar reads its own snapshot, so the intent has to
    // reach that list and leave it on the same value the primary state shows.
    const filtered: SessionListSnapshot[] = [];
    const stopFiltered = sessions.subscribeList({ archivedFilter: "all" }, (snapshot) => {
      filtered.push(snapshot);
    });
    const filteredRowPinned = () => rowPinned(filtered.at(-1)?.result ?? null, key);

    await sessions.refresh({ force: true });
    await sessions.refreshList({ archivedFilter: "all", force: true });
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(filteredRowPinned()).toBe(true);

    const operation = sessions.patch(key, { pinned: false });
    expect(rowPinned(sessions.state.result, key)).toBe(false);
    expect(filteredRowPinned()).toBe(false);

    await expect(operation).rejects.toThrow("pin rejected");
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(filteredRowPinned()).toBe(true);
    expect(sessions.state.error).toContain("pin rejected");
    stopFiltered();
    sessions.dispose();
  });

  it("rolls a filtered-only row back to the pin the Gateway kept", async () => {
    const key = "agent:other:beta";
    const request = vi.fn(async (method: string, params?: { archived?: unknown }) => {
      if (method === "sessions.patch") {
        throw new Error("unpin rejected");
      }
      if (method === "sessions.list") {
        // Only the all-filtered sidebar publishes this row, so the rollback
        // baseline cannot come from the primary snapshot.
        return params?.archived === "all"
          ? sessionsResult([{ key, kind: "direct", updatedAt: 1, pinned: true, pinnedAt: 7 }], 1)
          : sessionsResult([], 1);
      }
      if (method === "sessions.subscribe") {
        return { subscribed: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const { gateway } = createGatewayHarness({ request } as unknown as GatewayBrowserClient);
    const sessions = createTestSessionCapability(gateway);
    const filtered: SessionListSnapshot[] = [];
    const stopFiltered = sessions.subscribeList({ archivedFilter: "all" }, (snapshot) => {
      filtered.push(snapshot);
    });
    const filteredRow = () => filtered.at(-1)?.result?.sessions.find((row) => row.key === key);

    await sessions.refresh({ force: true });
    await sessions.refreshList({ archivedFilter: "all", force: true });
    expect(sessions.state.result?.sessions).toHaveLength(0);
    expect(filteredRow()?.pinned).toBe(true);

    const operation = sessions.patch(key, { pinned: false });
    expect(filteredRow()?.pinned).toBe(false);

    await expect(operation).rejects.toThrow("unpin rejected");
    expect(filteredRow()?.pinned).toBe(true);
    expect(filteredRow()?.pinnedAt).toBe(7);
    stopFiltered();
    sessions.dispose();
  });

  it("rolls a failed unpin back to the pin an overlapping completion confirmed", async () => {
    const pinCommitted = createDeferred<unknown>();
    const unpinRejected = createDeferred<unknown>();
    let serverPinned = false;
    const { gateway, key } = pinHarness({
      patchResponse: (call) => (call === 1 ? pinCommitted.promise : unpinRejected.promise),
      serverPinned: () => serverPinned,
    });
    const sessions = createTestSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const pin = sessions.patch(key, { pinned: true });
    const unpin = sessions.patch(key, { pinned: false });
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    serverPinned = true;
    pinCommitted.resolve({ ok: true, key, path: "", entry: {} });
    await expect(pin).resolves.toBeTruthy();
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    unpinRejected.reject(new Error("unpin rejected"));
    await expect(unpin).rejects.toThrow("unpin rejected");
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(sessions.state.error).toContain("unpin rejected");
    sessions.dispose();
  });
});
