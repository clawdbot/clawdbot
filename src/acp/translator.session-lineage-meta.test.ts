import type { ListSessionsRequest, LoadSessionRequest } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

function createLoadSessionRequest(
  sessionId: string,
  meta: Record<string, unknown> = {},
): LoadSessionRequest {
  return {
    sessionId,
    cwd: "/workspace",
    mcpServers: [],
    _meta: meta,
  } as unknown as LoadSessionRequest;
}

describe("acp session lineage metadata", () => {
  it("includes lineage metadata in listSessions results", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 2,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:main",
              kind: "direct",
              channel: "telegram",
              displayName: "Main",
              updatedAt: 1_710_000_000_000,
            },
            {
              key: "agent:main:subagent:child",
              kind: "direct",
              channel: "telegram",
              displayName: "Child",
              updatedAt: 1_710_000_010_000,
              parentSessionKey: "agent:main:main",
              spawnedBy: "agent:main:main",
              spawnDepth: 1,
              subagentRole: "orchestrator",
              subagentControlScope: "children",
              spawnedWorkspaceDir: "/workspace/child",
            },
          ],
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore: createInMemorySessionStore(),
    });

    const result = await agent.listSessions({
      _meta: {},
    } as unknown as ListSessionsRequest);

    expect(result.sessions[0]?._meta).toEqual({
      sessionKey: "agent:main:main",
      kind: "direct",
      channel: "telegram",
    });
    expect(result.sessions[1]?._meta).toEqual({
      sessionKey: "agent:main:subagent:child",
      kind: "direct",
      channel: "telegram",
      parentSessionId: "agent:main:main",
      spawnedBy: "agent:main:main",
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      spawnedWorkspaceDir: "/workspace/child",
    });
  });

  it("includes lineage metadata in initial session snapshot updates", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: "agent:main:subagent:child",
              kind: "direct",
              channel: "discord",
              displayName: "Child",
              updatedAt: 1_710_000_020_000,
              parentSessionKey: "agent:main:main",
              spawnedBy: "agent:main:main",
              spawnDepth: 1,
              subagentRole: "leaf",
              subagentControlScope: "none",
              spawnedWorkspaceDir: "/workspace/child",
            },
          ],
        };
      }
      if (method === "sessions.get") {
        return { messages: [] };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(createLoadSessionRequest("agent:main:subagent:child"));

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:subagent:child",
      update: {
        sessionUpdate: "session_info_update",
        title: "Child",
        updatedAt: "2024-03-09T16:00:20.000Z",
        _meta: {
          sessionKey: "agent:main:subagent:child",
          kind: "direct",
          channel: "discord",
          parentSessionId: "agent:main:main",
          spawnedBy: "agent:main:main",
          spawnDepth: 1,
          subagentRole: "leaf",
          subagentControlScope: "none",
          spawnedWorkspaceDir: "/workspace/child",
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("keeps snapshot lineage in the Gateway session key namespace", async () => {
    const sessionStore = createInMemorySessionStore();
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const gatewaySessionKey = "agent:main:subagent:child";
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return {
          ts: 1,
          path: "/tmp/sessions.json",
          count: 1,
          defaults: {
            modelProvider: null,
            model: null,
            contextTokens: null,
          },
          sessions: [
            {
              key: gatewaySessionKey,
              kind: "direct",
              displayName: "Child",
              updatedAt: 1_710_000_020_000,
              parentSessionKey: "agent:main:main",
              spawnedBy: "agent:main:main",
              spawnDepth: 1,
              subagentRole: "leaf",
              subagentControlScope: "none",
            },
          ],
        };
      }
      if (method === "sessions.get") {
        return { messages: [] };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    await agent.loadSession(
      createLoadSessionRequest("client-local-session", {
        sessionKey: gatewaySessionKey,
      }),
    );

    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "client-local-session",
      update: {
        sessionUpdate: "session_info_update",
        title: "Child",
        updatedAt: "2024-03-09T16:00:20.000Z",
        _meta: {
          sessionKey: gatewaySessionKey,
          kind: "direct",
          parentSessionId: "agent:main:main",
          spawnedBy: "agent:main:main",
          spawnDepth: 1,
          subagentRole: "leaf",
          subagentControlScope: "none",
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });
});
