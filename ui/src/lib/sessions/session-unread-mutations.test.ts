// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness, sessionsResult } from "./session-capability.test-support.ts";

const key = "agent:main:unread-contract";

function rowUnread(result: SessionsListResult | null): boolean {
  return result?.sessions.find((row) => row.key === key)?.unread === true;
}

function unreadHarness(options: {
  patchResponse: () => Promise<unknown>;
  serverUnread: () => boolean;
}) {
  let listTs = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "sessions.patch") {
      return await options.patchResponse();
    }
    if (method === "sessions.list") {
      listTs += 1;
      return sessionsResult(
        [{ key, kind: "direct", updatedAt: 1, unread: options.serverUnread() }],
        listTs,
      );
    }
    if (method === "sessions.subscribe") {
      return { subscribed: true };
    }
    throw new Error(`Unexpected request: ${method}`);
  });
  return createGatewayHarness({ request } as unknown as GatewayBrowserClient);
}

describe("session unread mutation capability", () => {
  it.each([
    {
      name: "automatic acknowledgement",
      options: { expectedMarkedUnreadAt: 42 },
      expected: { expectedMarkedUnreadAt: 42 },
    },
    {
      name: "explicit read",
      options: {},
      expected: {},
    },
  ])("sends the current payload for $name", async ({ expected, options }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true, path: "", key, entry: {} };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.patch"]);
    const sessions = createSessionCapability(gateway);

    await sessions.patch(key, { unread: false }, { ...options, deferListRefresh: true });

    expect(request).toHaveBeenCalledWith("sessions.patch", {
      key,
      unread: false,
      ...expected,
    });
    sessions.dispose();
  });

  it("clears unread before the request settles and rolls a rejection back", async () => {
    const rejected = createDeferred<unknown>();
    const { gateway } = unreadHarness({
      patchResponse: () => rejected.promise,
      serverUnread: () => true,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const operation = sessions.patch(key, { unread: false }, { deferListRefresh: true });
    const unreadWhilePending = rowUnread(sessions.state.result);

    rejected.reject(new Error("read rejected"));
    await expect(operation).rejects.toThrow("read rejected");
    expect(unreadWhilePending).toBe(false);
    expect(rowUnread(sessions.state.result)).toBe(true);
    sessions.dispose();
  });

  it("keeps the pending read through stale events and canonical refreshes", async () => {
    const committed = createDeferred<unknown>();
    let serverUnread = true;
    const { gateway } = unreadHarness({
      patchResponse: () => committed.promise,
      serverUnread: () => serverUnread,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const operation = sessions.patch(key, { unread: false });
    expect(rowUnread(sessions.state.result)).toBe(false);

    sessions.reconcileChanged({
      key,
      kind: "direct",
      reason: "send",
      sessionKey: key,
      unread: true,
      updatedAt: 2,
    });
    expect(rowUnread(sessions.state.result)).toBe(false);

    await sessions.refresh({ force: true });
    expect(rowUnread(sessions.state.result)).toBe(false);

    serverUnread = false;
    committed.resolve({ ok: true, key, path: "", entry: {} });
    await expect(operation).resolves.toBeTruthy();
    expect(rowUnread(sessions.state.result)).toBe(false);
    sessions.dispose();
  });

  it("restores the marker-owned unread row when the acknowledgement settles stale", async () => {
    const committed = createDeferred<unknown>();
    const { gateway } = unreadHarness({
      patchResponse: () => committed.promise,
      serverUnread: () => true,
    });
    const sessions = createSessionCapability(gateway);

    await sessions.refresh({ force: true });
    const operation = sessions.patch(key, { unread: false }, { expectedMarkedUnreadAt: 41 });
    expect(rowUnread(sessions.state.result)).toBe(false);

    // The Gateway keeps a newer manual marker, answers ok without applying, and
    // broadcasts nothing; settlement is the only place the row can come back.
    committed.resolve({ ok: true, key, path: "", entry: { markedUnreadAt: 99 } });
    await expect(operation).resolves.toBeTruthy();
    expect(rowUnread(sessions.state.result)).toBe(true);
    sessions.dispose();
  });
});
