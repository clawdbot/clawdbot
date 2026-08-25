// @vitest-environment node
import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { createSessionCapability } from "./index.ts";
import { createGatewayHarness } from "./session-capability.test-support.ts";

const key = "agent:main:unread-contract";

describe("session unread mutation capability", () => {
  it.each([
    {
      name: "current Gateway automatic acknowledgement",
      capabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
      options: { expectedMarkedUnreadAt: 42 },
      expected: { expectedMarkedUnreadAt: 42 },
    },
    {
      name: "legacy Gateway automatic acknowledgement",
      capabilities: [],
      options: { expectedMarkedUnreadAt: 42 },
      expected: {},
    },
    {
      name: "current Gateway explicit read",
      capabilities: [GATEWAY_SERVER_CAPS.SESSION_UNREAD_ACK_CONTRACT],
      options: { readIntent: "explicit" as const },
      expected: { readIntent: "explicit" },
    },
    {
      name: "legacy Gateway explicit read",
      capabilities: [],
      options: { readIntent: "explicit" as const },
      expected: {},
    },
  ])("uses the compatible payload for $name", async ({ capabilities, expected, options }) => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.patch") {
        return { ok: true, path: "", key, entry: {} };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway } = createGatewayHarness(client, ["sessions.patch"], capabilities);
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
