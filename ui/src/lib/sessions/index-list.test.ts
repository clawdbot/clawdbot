import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionCapability } from "./index.ts";

describe("session list requests", () => {
  it("forwards a trimmed parent key when listing child sessions", async () => {
    const result: SessionsListResult = {
      ts: 1,
      path: "(multiple)",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    };
    const request = vi.fn(async () => result);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      connected: true,
      sessionKey: "agent:main:main",
      assistantAgentId: "main",
      hello: null,
    };
    const sessions = createSessionCapability({
      snapshot,
      subscribe: () => () => undefined,
      subscribeEvents: (_listener: (event: GatewayEventFrame) => void) => () => undefined,
    });

    await sessions.list({
      agentId: "main",
      spawnedBy: "  agent:main:parent  ",
      limit: 20,
      includeGlobal: false,
      includeUnknown: false,
    });

    expect(request).toHaveBeenCalledWith("sessions.list", {
      agentId: "main",
      configuredAgentsOnly: true,
      includeGlobal: false,
      includeUnknown: false,
      limit: 20,
      spawnedBy: "agent:main:parent",
    });
    sessions.dispose();
  });
});
