/** Behavior tests for harness-facing requester-scoped MCP materialization. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const mocks = vi.hoisted(() => {
  type Runtime = SessionMcpRuntime;
  const advertised = new Map<
    string,
    {
      version: number;
      generatedAt: number;
      servers: Record<string, { serverName: string; launchSummary: string; toolCount: number }>;
      tools: Array<{
        serverName: string;
        safeServerName: string;
        toolName: string;
        description: string;
        inputSchema: Record<string, unknown>;
        fallbackDescription: string;
      }>;
    }
  >();
  const runtimes = new Map<string, Runtime>();
  let resolveImpl:
    | ((params: {
        sessionId: string;
        requesterSenderId?: string | null;
      }) => Promise<Runtime | undefined>)
    | undefined;

  return {
    advertised,
    runtimes,
    setResolveImpl(impl?: typeof resolveImpl) {
      resolveImpl = impl;
    },
    getOrCreateRequesterScopedMcpRuntime: vi.fn(
      async (params: { sessionId: string; requesterSenderId?: string | null }) => {
        if (resolveImpl) {
          return resolveImpl(params);
        }
        return undefined;
      },
    ),
    rememberAdvertisedScopedMcpCatalog: vi.fn(
      (sessionId: string, catalog: typeof advertised extends Map<string, infer V> ? V : never) => {
        advertised.set(sessionId, catalog);
      },
    ),
    getAdvertisedScopedMcpCatalog: vi.fn((sessionId: string) => advertised.get(sessionId) ?? null),
    reset() {
      advertised.clear();
      runtimes.clear();
      resolveImpl = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-runtime.js")>();
  return {
    ...actual,
    getOrCreateRequesterScopedMcpRuntime: mocks.getOrCreateRequesterScopedMcpRuntime,
    rememberAdvertisedScopedMcpCatalog: mocks.rememberAdvertisedScopedMcpCatalog,
    getAdvertisedScopedMcpCatalog: mocks.getAdvertisedScopedMcpCatalog,
  };
});

import { materializeRequesterScopedMcpToolsForHarnessRun } from "./agent-bundle-mcp-harness.js";

function makeRuntime(params: { sessionId: string; requesterSenderId: string }): SessionMcpRuntime {
  const serverName = "user-mail";
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: {
        serverName,
        launchSummary: serverName,
        toolCount: 1,
      },
    },
    tools: [
      {
        serverName,
        safeServerName: serverName,
        toolName: "inbox",
        description: "read inbox",
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: "read inbox",
      },
    ],
  };
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId: params.sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "fp",
    requesterScope: { requesterSenderId: params.requesterSenderId },
    createdAt: Date.now(),
    get lastUsedAt() {
      return lastUsedAt;
    },
    get activeLeases() {
      return activeLeases;
    },
    acquireLease: () => {
      activeLeases += 1;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        activeLeases -= 1;
      };
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => catalog,
    getCatalog: async () => catalog,
    callTool: async (_server, toolName) => ({
      content: [
        {
          type: "text",
          text: `live:${toolName}:${params.requesterSenderId}`,
        },
      ],
      isError: false,
    }),
    dispose: async () => {},
  };
}

beforeEach(() => {
  mocks.reset();
  mocks.getOrCreateRequesterScopedMcpRuntime.mockClear();
  mocks.rememberAdvertisedScopedMcpCatalog.mockClear();
  mocks.getAdvertisedScopedMcpCatalog.mockClear();
});

afterEach(() => {
  mocks.reset();
});

describe("materializeRequesterScopedMcpToolsForHarnessRun", () => {
  it("returns undefined before any requester resolves", async () => {
    mocks.setResolveImpl(async () => undefined);
    const result = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-empty",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(result).toBeUndefined();
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();
  });

  it("keeps advertised specs stable and returns not-connected for unauthed senders", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId = params.requesterSenderId;
      if (senderId !== "authed") {
        return undefined;
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: "authed",
      });
    });

    const authed = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "authed",
    });
    expect(authed).toBeDefined();
    const advertisedNames = authed!.advertisedTools.map((tool) => tool.name);
    expect(advertisedNames).toEqual(["user-mail__inbox"]);

    const live = await authed!.tools[0]!.execute("c1", {});
    expect(live.content[0]).toMatchObject({
      type: "text",
      text: "live:inbox:authed",
    });
    await authed!.dispose();

    const guest = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-stable",
      workspaceDir: "/workspace",
      requesterSenderId: "guest",
    });
    expect(guest).toBeDefined();
    expect(guest!.advertisedTools.map((tool) => tool.name)).toEqual(advertisedNames);
    expect(guest!.tools.map((tool) => tool.name)).toEqual(advertisedNames);

    const notConnected = await guest!.tools[0]!.execute("c2", {});
    expect(notConnected.details).toMatchObject({ status: "error" });
    const text =
      notConnected.content[0] && "text" in notConnected.content[0]
        ? notConnected.content[0].text
        : "";
    expect(text).toMatch(/has not connected MCP server/i);
    await guest!.dispose();
  });

  it("routes authed calls to that sender's runtime only", async () => {
    mocks.setResolveImpl(async (params) => {
      const senderId =
        typeof params.requesterSenderId === "string" ? params.requesterSenderId : undefined;
      if (!senderId) {
        return undefined;
      }
      return makeRuntime({
        sessionId: params.sessionId,
        requesterSenderId: senderId,
      });
    });

    const alice = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "alice",
    });
    const bob = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-route",
      workspaceDir: "/workspace",
      requesterSenderId: "bob",
    });
    expect(alice).toBeDefined();
    expect(bob).toBeDefined();
    expect(alice!.advertisedTools.map((t) => t.name)).toEqual(
      bob!.advertisedTools.map((t) => t.name),
    );

    const aliceResult = await alice!.tools[0]!.execute("a", {});
    const bobResult = await bob!.tools[0]!.execute("b", {});
    expect(aliceResult.content[0]).toMatchObject({ text: "live:inbox:alice" });
    expect(bobResult.content[0]).toMatchObject({ text: "live:inbox:bob" });

    await alice!.dispose();
    await bob!.dispose();
  });
});
