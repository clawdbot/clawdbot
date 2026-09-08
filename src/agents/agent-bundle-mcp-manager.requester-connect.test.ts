import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.test-support.js";
import { materializeBundleMcpToolsForRun } from "./agent-bundle-mcp-materialize.js";
import type { CreateSessionMcpRuntime } from "./agent-bundle-mcp-runtime-shared.js";
import type { McpToolCatalog, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { applyCodeModeCatalog } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  runUntilCompleted,
} from "./code-mode.test-support.js";

const oauthStatus = vi.hoisted(() => vi.fn());
const startAuthorization = vi.hoisted(() => vi.fn());

vi.mock("./mcp-oauth.js", () => ({
  readMcpOAuthCredentialsStatus: oauthStatus,
  startMcpOAuthAuthorization: startAuthorization,
}));

function createTestRuntime(params: Parameters<CreateSessionMcpRuntime>[0]): SessionMcpRuntime {
  const includesCalendar = params.includeServerNames?.has("calendar") === true;
  const catalog: McpToolCatalog = includesCalendar
    ? {
        version: 1,
        generatedAt: 1,
        servers: {
          calendar: {
            serverName: "calendar",
            safeServerName: "calendar",
            launchSummary: "calendar",
            toolCount: 1,
          },
        },
        tools: [
          {
            serverName: "calendar",
            safeServerName: "calendar",
            toolName: "events",
            description: "List events",
            fallbackDescription: "List events",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }
    : { version: 1, generatedAt: 1, servers: {}, tools: [] };
  let lastUsedAt = Date.now();
  return {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    configFingerprint: params.configFingerprint ?? "test",
    requesterScope: params.requesterScope,
    requesterConnect: params.requesterConnect,
    createdAt: Date.now(),
    get lastUsedAt() {
      return lastUsedAt;
    },
    getCatalog: async () => catalog,
    peekCatalog: () => catalog,
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    callTool: async (_serverName, toolName) => ({
      content: [{ type: "text", text: `called:${toolName}` }],
      isError: false,
    }),
    dispose: async () => {},
    joinCleanup: async () => {},
  };
}

describe("requester MCP connect runtime", () => {
  let manager: ReturnType<typeof createSessionMcpRuntimeManager>;
  const created: Array<Parameters<CreateSessionMcpRuntime>[0]> = [];

  beforeEach(() => {
    oauthStatus.mockReset().mockResolvedValue({ state: "unauthenticated" });
    startAuthorization.mockReset().mockResolvedValue({
      status: "redirect",
      authorizationUrl: "https://auth.example/authorize?state=opaque",
      redirectUrl: "https://gateway.example/oauth/mcp/callback",
      state: "opaque",
    });
    created.length = 0;
    manager = createSessionMcpRuntimeManager({
      createRuntime: (params) => {
        created.push(params);
        return createTestRuntime(params);
      },
    });
  });

  afterEach(async () => {
    await manager.disposeAll();
    resetCodeModeTestState();
  });

  it("materializes connect before authorization and real tools on the next message", async () => {
    const request = {
      sessionId: "session-connect",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      messageChannel: "telegram",
      agentAccountId: "bot",
      cfg: {
        gateway: { publicOrigin: "https://gateway.example" },
        mcp: {
          servers: {
            calendar: {
              url: "https://mcp.example/rpc",
              transport: "streamable-http" as const,
              auth: "oauth" as const,
              oauth: { identity: "per-requester" as const },
            },
          },
        },
      },
    };

    const disconnectedRuntime = await manager.getOrCreate(request);
    const disconnected = await materializeBundleMcpToolsForRun({
      runtime: disconnectedRuntime,
    });
    expect(disconnected.tools.map((tool) => tool.name)).toEqual(["calendar__connect"]);
    expect(created.find((params) => params.requesterScope)?.includeServerNames).toEqual(new Set());
    expect(startAuthorization).not.toHaveBeenCalled();
    await expect(disconnected.tools[0]!.execute("connect", {})).resolves.toMatchObject({
      details: {
        mcpConnect: {
          serverName: "calendar",
          authorizationUrl: "https://auth.example/authorize?state=opaque",
        },
      },
    });
    startAuthorization
      .mockResolvedValueOnce({
        status: "redirect",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      })
      .mockResolvedValueOnce({ status: "authorized" });
    const codeMode = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeMode.tools, ...disconnected.tools],
      config: codeMode.config,
      catalogRef: codeMode.catalogRef,
    });
    const guest = await runUntilCompleted({
      execTool: codeMode.tools[0]!,
      waitTool: codeMode.tools[1]!,
      code: "return { signIn: await MCP.calendar.connect(), connected: await MCP.calendar.connect() };",
    });
    expect(guest.status, JSON.stringify(guest)).toBe("completed");
    expect(guest.value).toEqual({
      signIn: {
        content: [
          {
            type: "text",
            text: expect.stringContaining("https://auth.example/authorize?state=opaque"),
          },
        ],
        isError: false,
      },
      connected: {
        content: [{ type: "text", text: expect.stringContaining('"calendar" is connected') }],
        isError: false,
      },
    });
    expect(disconnected.tools[0]?.resultContentSource).toBe("network");
    await disconnected.dispose();

    oauthStatus.mockResolvedValue({ state: "authorized" });
    const connectedRuntime = await manager.getOrCreate(request);
    const connected = await materializeBundleMcpToolsForRun({ runtime: connectedRuntime });

    expect(connected.tools.map((tool) => tool.name)).toEqual(["calendar__events"]);
    expect(created.findLast((params) => params.requesterScope)?.includeServerNames).toEqual(
      new Set(["calendar"]),
    );
    await connected.dispose();
  });

  it("returns requester connection configuration failures as failed MCP guest results", async () => {
    const runtime = await manager.getOrCreate({
      sessionId: "session-connect-missing-origin",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
      cfg: {
        mcp: {
          servers: {
            calendar: {
              url: "https://mcp.example/rpc",
              transport: "streamable-http",
              auth: "oauth",
              oauth: { identity: "per-requester" },
            },
          },
        },
      },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    const direct = await materialized.tools[0]!.execute("connect-direct", {});
    expect(direct.details).toMatchObject({ status: "error", mcpServer: "calendar" });

    const codeMode = createCodeModeHarness();
    applyCodeModeCatalog({
      tools: [...codeMode.tools, ...materialized.tools],
      config: codeMode.config,
      catalogRef: codeMode.catalogRef,
    });
    const guest = await runUntilCompleted({
      execTool: codeMode.tools[0]!,
      waitTool: codeMode.tools[1]!,
      code: "return await MCP.calendar.connect();",
    });
    expect(guest.status, JSON.stringify(guest)).toBe("completed");
    expect(guest.value).toEqual({
      content: [{ type: "text", text: expect.stringContaining("gateway.publicOrigin") }],
      isError: true,
    });
    expect(guest.value).not.toHaveProperty("details");
    await materialized.dispose();
  });
});
