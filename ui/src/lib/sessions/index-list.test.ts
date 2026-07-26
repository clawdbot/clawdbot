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
    const request = vi.fn(async (_method: string, _params?: unknown) => result);
    const client = { request } as unknown as GatewayBrowserClient;
    const snapshot = {
      client,
      phase: "connected" as const,
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

  it("maps archived status filters to the tri-state wire contract", async () => {
    const result: SessionsListResult = {
      ts: 1,
      path: "(multiple)",
      count: 0,
      defaults: { modelProvider: null, model: null, contextTokens: null },
      sessions: [],
    };
    const request = vi.fn(async (_method: string, _params?: unknown) => result);
    const sessions = createSessionCapability({
      snapshot: {
        client: { request } as unknown as GatewayBrowserClient,
        phase: "connected" as const,
        sessionKey: "agent:main:main",
        assistantAgentId: "main",
        hello: null,
      },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    });

    await sessions.list({ archivedFilter: "active", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "archived", activeMinutes: 30 });
    await sessions.list({ archivedFilter: "all", activeMinutes: 30 });

    expect(request.mock.calls[0]?.[1]).toMatchObject({ activeMinutes: 30 });
    expect(request.mock.calls[0]?.[1]).not.toHaveProperty("archived");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ archived: true });
    expect(request.mock.calls[1]?.[1]).not.toHaveProperty("activeMinutes");
    expect(request.mock.calls[2]?.[1]).toMatchObject({ archived: "all" });
    expect(request.mock.calls[2]?.[1]).not.toHaveProperty("activeMinutes");
    sessions.dispose();
  });
});
