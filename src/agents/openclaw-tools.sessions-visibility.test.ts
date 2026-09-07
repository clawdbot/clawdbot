// Verifies sessions_history visibility defaults and sandbox clamps.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsHistoryTool } from "./tools/sessions-history-tool.js";
import { createSessionsListTool } from "./tools/sessions-list-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

let mockConfig: Record<string, unknown> = {
  session: { mainKey: "main", scope: "per-sender" },
};
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: () => mockConfig,
    resolveGatewayPort: () => 18789,
  };
});
function getSessionsHistoryTool(options?: { sandboxed?: boolean }) {
  return createSessionsHistoryTool({
    agentSessionKey: "main",
    sandboxed: options?.sandboxed,
    config: mockConfig as never,
    callGateway: (opts: unknown) => callGatewayMock(opts),
  });
}

function mockGatewayWithHistory(
  extra?: (req: { method?: string; params?: Record<string, unknown> }) => unknown,
) {
  // Most visibility tests need chat.history plus optional session resolution/listing.
  callGatewayMock.mockClear();
  callGatewayMock.mockImplementation(async (opts: unknown) => {
    const req = opts as { method?: string; params?: Record<string, unknown> };
    const handled = extra?.(req);
    if (handled !== undefined) {
      return handled;
    }
    if (req.method === "chat.history") {
      return { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }] };
    }
    return {};
  });
}

describe("sessions tools visibility", () => {
  beforeEach(() => {
    callGatewayMock.mockClear();
  });

  it("keeps same-agent history accessible but denies cross-agent history when a2a is explicitly disabled", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { agentToAgent: { enabled: false } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve") {
        const key = typeof req.params?.key === "string" ? req.params.key : "";
        if (req.params?.spawnedBy === "main" && key !== "subagent:child-1") {
          return {};
        }
        return { key };
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool();

    const sibling = await tool.execute("call1", {
      sessionKey: "agent:main:quietchat:direct:someone-else",
    });
    expect((sibling.details as { sessionKey?: string }).sessionKey).toBe(
      "agent:main:quietchat:direct:someone-else",
    );

    const allowed = await tool.execute("call2", { sessionKey: "subagent:child-1" });
    expect((allowed.details as { sessionKey?: string }).sessionKey).toBe("subagent:child-1");

    const denied = await tool.execute("call-cross-agent", { sessionKey: "agent:other:main" });
    expect(denied.details).toEqual({
      status: "forbidden",
      error:
        "Agent-to-agent history is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
    });
  });

  it("lists and reads another agent's session by default with no tools configuration", async () => {
    mockConfig = {};
    const sessionKey = "agent:other:main";
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.list") {
        return { sessions: [{ key: sessionKey, agentId: "other" }] };
      }
      if (req.method === "sessions.resolve") {
        return { key: sessionKey, agentId: "other" };
      }
      return undefined;
    });
    const list = createSessionsListTool({
      agentSessionKey: "agent:main:main",
      config: {},
      callGateway: (opts: unknown) => callGatewayMock(opts),
    });
    const listed = await list.execute("call-list", {});
    expect(listed.details).toMatchObject({
      count: 1,
      sessions: [{ key: sessionKey, agentId: "other" }],
    });

    const result = await getSessionsHistoryTool().execute("call3", { sessionKey });
    expect(result.details).toMatchObject({
      sessionKey,
      messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
    });
  });

  it("clamps sandboxed sessions to tree when agents.defaults.sandbox.sessionToolsVisibility=spawned", async () => {
    mockConfig = {
      session: { mainKey: "main", scope: "per-sender" },
      tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true, allow: ["*"] } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    };
    mockGatewayWithHistory((req) => {
      if (req.method === "sessions.resolve" && req.params?.spawnedBy === "main") {
        return {};
      }
      return undefined;
    });

    const tool = getSessionsHistoryTool({ sandboxed: true });

    const denied = await tool.execute("call4", {
      sessionKey: "agent:other:main",
    });
    expect((denied.details as { status?: string }).status).toBe("forbidden");
  });
});
