// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness } from "./session-capability.test-support.ts";

const key = "agent:main:unread-contract";

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
});
