// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import {
  createGatewayHarness,
  deferred,
  sessionsResult,
} from "./session-capability.test-support.ts";

function rowPinned(result: SessionsListResult | null, key: string): boolean {
  return result?.sessions.find((row) => row.key === key)?.pinned === true;
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
  it("pins a row before sessions.patch resolves and holds it through refresh and events", async () => {
    const committed = deferred<unknown>();
    let serverPinned = false;
    const { gateway, key, emitEvent } = pinHarness({
      patchResponse: () => committed.promise,
      serverPinned: () => serverPinned,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    const operation = sessions.patch(key, { pinned: true });
    expect(rowPinned(sessions.state.result, key)).toBe(true);

    serverPinned = true;
    committed.resolve({ ok: true, key, path: "", entry: {} });
    await expect(operation).resolves.toBeTruthy();
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(sessions.state.error).toBeNull();

    emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { sessionKey: key, reason: "send", key, kind: "direct", updatedAt: 3 },
    });
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    sessions.dispose();
  });

  it("rolls a rejected unpin back to the pinned row and publishes the error", async () => {
    const { gateway, key } = pinHarness({
      patchResponse: () => Promise.reject(new Error("pin rejected")),
      serverPinned: () => true,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    expect(rowPinned(sessions.state.result, key)).toBe(true);

    const operation = sessions.patch(key, { pinned: false });
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    await expect(operation).rejects.toThrow("pin rejected");
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    expect(sessions.state.error).toContain("pin rejected");
    sessions.dispose();
  });

  it("keeps the newest pin intent when an older completion refreshes the list first", async () => {
    const pinCommitted = deferred<unknown>();
    const unpinCommitted = deferred<unknown>();
    let serverPinned = false;
    const { gateway, key } = pinHarness({
      patchResponse: (call) => (call === 1 ? pinCommitted.promise : unpinCommitted.promise),
      serverPinned: () => serverPinned,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const pin = sessions.patch(key, { pinned: true });
    expect(rowPinned(sessions.state.result, key)).toBe(true);
    const unpin = sessions.patch(key, { pinned: false });
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    // The pin commits first, so its list refresh republishes a pinned row the
    // unpin already replaced locally.
    serverPinned = true;
    pinCommitted.resolve({ ok: true, key, path: "", entry: {} });
    await expect(pin).resolves.toBeTruthy();
    expect(rowPinned(sessions.state.result, key)).toBe(false);

    serverPinned = false;
    unpinCommitted.resolve({ ok: true, key, path: "", entry: {} });
    await expect(unpin).resolves.toBeTruthy();
    expect(rowPinned(sessions.state.result, key)).toBe(false);
    sessions.dispose();
  });

  it("rolls a failed unpin back to the pin an overlapping completion confirmed", async () => {
    const pinCommitted = deferred<unknown>();
    const unpinRejected = deferred<unknown>();
    let serverPinned = false;
    const { gateway, key } = pinHarness({
      patchResponse: (call) => (call === 1 ? pinCommitted.promise : unpinRejected.promise),
      serverPinned: () => serverPinned,
    });
    const sessions = createSessionCapability(gateway);

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
