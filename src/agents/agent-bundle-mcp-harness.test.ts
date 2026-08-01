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
  let staticResolveImpl:
    | ((params: {
        sessionId: string;
        includeServerNames: ReadonlySet<string>;
      }) => Promise<Runtime | undefined>)
    | undefined;

  return {
    advertised,
    runtimes,
    setResolveImpl(impl?: typeof resolveImpl) {
      resolveImpl = impl;
    },
    setStaticResolveImpl(impl?: typeof staticResolveImpl) {
      staticResolveImpl = impl;
    },
    getOrCreateRequesterScopedMcpRuntime: vi.fn(
      async (params: { sessionId: string; requesterSenderId?: string | null }) => {
        if (resolveImpl) {
          return resolveImpl(params);
        }
        return undefined;
      },
    ),
    getOrCreateStaticScopedMcpRuntime: vi.fn(
      async (params: { sessionId: string; includeServerNames: ReadonlySet<string> }) => {
        if (staticResolveImpl) {
          return staticResolveImpl(params);
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
      staticResolveImpl = undefined;
    },
  };
});

vi.mock("./agent-bundle-mcp-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent-bundle-mcp-runtime.js")>();
  return {
    ...actual,
    getOrCreateRequesterScopedMcpRuntime: mocks.getOrCreateRequesterScopedMcpRuntime,
    getOrCreateStaticScopedMcpRuntime: mocks.getOrCreateStaticScopedMcpRuntime,
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

function makeStaticRuntime(sessionId: string): SessionMcpRuntime {
  const serverName = "opik";
  const toolNames = ["read", "list"];
  const catalog = {
    version: 1,
    generatedAt: 0,
    servers: {
      [serverName]: { serverName, launchSummary: serverName, toolCount: toolNames.length },
    },
    tools: toolNames.map((toolName) => ({
      serverName,
      safeServerName: serverName,
      toolName,
      description: `opik ${toolName}`,
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: `opik ${toolName}`,
    })),
  };
  let lastUsedAt = Date.now();
  let activeLeases = 0;
  return {
    sessionId,
    workspaceDir: "/workspace",
    configFingerprint: "fp-static",
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
      content: [{ type: "text", text: `static:${toolName}` }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

beforeEach(() => {
  mocks.reset();
  mocks.getOrCreateRequesterScopedMcpRuntime.mockClear();
  mocks.getOrCreateStaticScopedMcpRuntime.mockClear();
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

  it("materializes allowlisted static servers as dynamic tools and applies the allowlist", async () => {
    mocks.setResolveImpl(async () => undefined);
    mocks.setStaticResolveImpl(async (params) =>
      params.includeServerNames.has("opik") ? makeStaticRuntime(params.sessionId) : undefined,
    );

    const result = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-static",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: { opik: { command: "true" } } } } as never,
      requesterSenderId: "authed",
      exposeAllowlistedStaticServers: true,
      toolsAllow: ["opik__read"],
    });

    expect(result).toBeDefined();
    // list is dropped by the allowlist; read survives on both surfaces.
    expect(result!.advertisedTools.map((tool) => tool.name)).toEqual(["opik__read"]);
    expect(result!.tools.map((tool) => tool.name)).toEqual(["opik__read"]);
    // Static tools never enter the session advertised cache.
    expect(mocks.rememberAdvertisedScopedMcpCatalog).not.toHaveBeenCalled();

    const live = await result!.tools[0]!.execute("c1", {});
    expect(live.content[0]).toMatchObject({ type: "text", text: "static:read" });
    await result!.dispose();
  });

  it("carries session tool overrides into the static runtime it opens", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({ sessionId: params.sessionId, requesterSenderId: "authed" }),
    );
    mocks.setStaticResolveImpl(async (params) =>
      params.includeServerNames.has("opik") ? makeStaticRuntime(params.sessionId) : undefined,
    );
    const toolOverrides = { mcpServers: { notes: false }, mcpToolsDeny: { opik: ["delete"] } };

    const result = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-overrides",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: { opik: { command: "true" } } } } as never,
      requesterSenderId: "authed",
      exposeAllowlistedStaticServers: true,
      toolsAllow: ["opik__read"],
      toolOverrides,
    });

    // The static branch replaces a surface that honored these overrides natively.
    expect(mocks.getOrCreateStaticScopedMcpRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ toolOverrides }),
    );
    // The requester-scoped branch keeps today's behaviour: it never received
    // them, and changing that is a separate behaviour change.
    expect(mocks.getOrCreateRequesterScopedMcpRuntime).toHaveBeenCalledWith(
      expect.not.objectContaining({ toolOverrides }),
    );
    await result?.dispose();
  });

  it("leaks no stale static stub when the later turn is unrestricted", async () => {
    mocks.setResolveImpl(async (params) =>
      makeRuntime({ sessionId: params.sessionId, requesterSenderId: "authed" }),
    );
    mocks.setStaticResolveImpl(async (params) =>
      params.includeServerNames.has("opik") ? makeStaticRuntime(params.sessionId) : undefined,
    );
    const cfg = { mcp: { servers: { opik: { command: "true" } } } } as never;

    // Turn A: scoped-allowlist turn exposes the static server as dynamic tools.
    const scopedTurn = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-toggle",
      workspaceDir: "/workspace",
      cfg,
      requesterSenderId: "authed",
      exposeAllowlistedStaticServers: true,
      toolsAllow: ["opik__read", "opik__list", "user-mail__inbox"],
    });
    expect(scopedTurn!.advertisedTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["opik__read", "opik__list", "user-mail__inbox"]),
    );
    await scopedTurn!.dispose();

    // Turn B: wildcard turn (static back to native attachment) does not expose static.
    const wildcardTurn = await materializeRequesterScopedMcpToolsForHarnessRun({
      sessionId: "session-toggle",
      workspaceDir: "/workspace",
      cfg,
      requesterSenderId: "authed",
    });
    expect(wildcardTurn).toBeDefined();
    // Only the requester-scoped server remains; no stale opik stub survives.
    expect(wildcardTurn!.advertisedTools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
  });
});
