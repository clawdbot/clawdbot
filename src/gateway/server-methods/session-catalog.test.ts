import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { gatewaySubagentState } from "../../plugins/runtime/gateway-bindings.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

type CatalogSessionEntryLoader = (
  sessionKey: string,
  options?: { agentId?: string; clone?: boolean },
) => { entry: { createdBy?: { id: string; label?: string } } | undefined };

const hoisted = vi.hoisted(() => ({
  activeRegistry: { sessionCatalogs: [] as unknown[] },
  pinnedSessionExtensionRegistry: undefined as { sessionCatalogs: unknown[] } | undefined,
  loadSessionEntryReadOnly: vi.fn<CatalogSessionEntryLoader>(() => ({ entry: undefined })),
  recordSessionStateEvent: vi.fn(),
  upsertSessionUpstreamLink: vi.fn(),
}));
const conversationBindingMocks = vi.hoisted(() => ({
  bindPluginSessionConversation: vi.fn(async (params: { afterBind?: () => Promise<void> }) => {
    await params.afterBind?.();
    return {};
  }),
}));

vi.mock("../../plugins/runtime.js", () => ({
  getActivePluginSessionExtensionRegistry: () =>
    hoisted.pinnedSessionExtensionRegistry ?? hoisted.activeRegistry,
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  listAmbientGroupWatchTargets: () => new Set<string>(),
  recordSessionStateEvent: hoisted.recordSessionStateEvent,
}));

vi.mock("../../sessions/session-upstream-links.js", () => ({
  upsertSessionUpstreamLink: hoisted.upsertSessionUpstreamLink,
}));
vi.mock("../../plugins/session-conversation-binding.js", () => ({
  bindPluginSessionConversation: conversationBindingMocks.bindPluginSessionConversation,
}));
vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return { ...actual, loadSessionEntryReadOnly: hoisted.loadSessionEntryReadOnly };
});

const { resolveSessionCatalogCreateTarget, sessionCatalogHandlers } =
  await import("./session-catalog.js");

function provider(
  id: string,
  overrides: Partial<SessionCatalogProvider> = {},
): SessionCatalogProvider {
  return {
    id,
    label: id.toUpperCase(),
    list: vi.fn(async () => []),
    read: vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] })),
    ...overrides,
  };
}

async function call(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connect?: { scopes?: string[] }; connId?: string },
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  await sessionCatalogHandlers[method]?.({
    params,
    respond,
    client,
    context: { getRuntimeConfig: () => config, ...contextOverrides },
  } as never);
  return respond;
}

describe("session catalog Gateway methods", () => {
  beforeEach(() => {
    hoisted.activeRegistry.sessionCatalogs = [];
    hoisted.pinnedSessionExtensionRegistry = undefined;
    hoisted.loadSessionEntryReadOnly.mockReset();
    hoisted.loadSessionEntryReadOnly.mockReturnValue({ entry: undefined });
    hoisted.recordSessionStateEvent.mockClear();
    hoisted.upsertSessionUpstreamLink.mockClear();
    conversationBindingMocks.bindPluginSessionConversation.mockClear();
  });

  it("sorts catalogs and isolates provider failures", async () => {
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("zeta") },
      {
        provider: provider("alpha", {
          list: vi.fn(async () => {
            throw new Error();
          }),
        }),
      },
    ];
    const respond = await call("sessions.catalog.list", {});
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "alpha",
          hosts: [],
          error: { code: "catalog_error", message: "session catalog provider failed" },
        }),
        expect.objectContaining({ id: "zeta", hosts: [] }),
      ],
    });
  });

  it("streams completed hosts to only the requesting connection", async () => {
    const broadcastToConnIds = vi.fn();
    const host = {
      hostId: "node:fast",
      label: "Fast node",
      kind: "node" as const,
      connected: true,
      nodeId: "fast",
      sessions: [],
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return [host];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "progress-1" },
      {},
      { connId: "requester", connect: {} },
      { broadcastToConnIds },
    );

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      {
        progressId: "progress-1",
        agentId: "main",
        catalog: expect.objectContaining({ id: "codex", hosts: [host] }),
      },
      new Set(["requester"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
    });
  });

  it("projects authoritative creator ownership onto streamed and final catalog rows", async () => {
    const broadcastToConnIds = vi.fn();
    const host = {
      hostId: "gateway:local",
      label: "Local Claude",
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: "owned-thread",
          status: "stored",
          archived: false,
          sessionKey: "agent:main:owned",
          createdBy: { id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
        {
          threadId: "missing-thread",
          status: "stored",
          archived: false,
          sessionKey: "agent:main:missing",
          createdBy: { id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
        {
          threadId: "external-thread",
          status: "stored",
          archived: false,
          createdBy: { id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
      ],
    };
    hoisted.loadSessionEntryReadOnly.mockImplementation((sessionKey: string) => ({
      entry:
        sessionKey === "agent:main:owned"
          ? { createdBy: { id: "profile-ada", label: "Ada" } }
          : undefined,
    }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("claude", {
          list: vi.fn(async ({ onHost }) => {
            onHost?.(host);
            return [host];
          }),
        }),
      },
    ];

    const respond = await call(
      "sessions.catalog.list",
      { progressId: "progress-creator" },
      {},
      { connId: "requester", connect: {} },
      { broadcastToConnIds },
    );
    const projectedSessions = [
      expect.objectContaining({
        threadId: "owned-thread",
        createdBy: { id: "profile-ada", label: "Ada" },
      }),
      expect.not.objectContaining({ createdBy: expect.anything() }),
      expect.not.objectContaining({ createdBy: expect.anything() }),
    ];

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.catalog.host",
      expect.objectContaining({
        catalog: expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: projectedSessions })],
        }),
      }),
      new Set(["requester"]),
      { dropIfSlow: true },
    );
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          hosts: [expect.objectContaining({ sessions: projectedSessions })],
        }),
      ],
    });
    expect(hoisted.loadSessionEntryReadOnly).toHaveBeenCalledWith("agent:main:owned", {
      agentId: "main",
    });
    expect(hoisted.loadSessionEntryReadOnly).toHaveBeenCalledTimes(2);
  });

  it("uses the pinned Gateway catalog runtime after active registry churn", async () => {
    const previousNodesRuntime = gatewaySubagentState.nodes;
    const listNodes = vi.fn(async () => ({ nodes: [] }));
    gatewaySubagentState.nodes = {
      list: listNodes,
      invoke: vi.fn(async () => undefined),
    };
    try {
      const gatewayRuntime = createPluginRuntime({ allowGatewaySubagentBinding: true });
      const standaloneRuntime = createPluginRuntime();
      const catalogUsing = (runtime: ReturnType<typeof createPluginRuntime>) =>
        provider("codex", {
          list: async () => {
            await runtime.nodes.list();
            return [];
          },
        });
      hoisted.pinnedSessionExtensionRegistry = {
        sessionCatalogs: [{ provider: catalogUsing(gatewayRuntime) }],
      };
      hoisted.activeRegistry.sessionCatalogs = [{ provider: catalogUsing(standaloneRuntime) }];

      const respond = await call("sessions.catalog.list", { catalogId: "codex" });

      expect(listNodes).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: "codex", hosts: [] })],
      });
    } finally {
      gatewaySubagentState.nodes = previousNodesRuntime;
    }
  });

  it("rejects host cursors without a catalog selector", async () => {
    const respond = await call("sessions.catalog.list", {
      cursors: { "gateway:local": "next" },
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "catalogId is required when cursors are provided",
      }),
    );
  });

  it("normalizes search once before dispatching every provider", async () => {
    const alphaList = vi.fn(async () => []);
    const zetaList = vi.fn(async () => []);
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("zeta", { list: zetaList }) },
      { provider: provider("alpha", { list: alphaList }) },
    ];

    await call("sessions.catalog.list", { search: "   " });
    expect(alphaList).toHaveBeenLastCalledWith(expect.objectContaining({ search: undefined }));
    expect(zetaList).toHaveBeenLastCalledWith(expect.objectContaining({ search: undefined }));

    const crossingPair = `${"x".repeat(499)}😀tail`;
    await call("sessions.catalog.list", { search: `  ${crossingPair}  ` });
    expect(alphaList).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: "x".repeat(499) }),
    );
    expect(zetaList).toHaveBeenLastCalledWith(expect.objectContaining({ search: "x".repeat(499) }));

    const completePair = `${"y".repeat(498)}😀tail`;
    await call("sessions.catalog.list", { search: completePair });
    expect(alphaList).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: `${"y".repeat(498)}😀` }),
    );
    expect(zetaList).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: `${"y".repeat(498)}😀` }),
    );
  });

  it("advertises terminal opening only for providers that implement it", async () => {
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          openTerminal: async () => ({ kind: "local", argv: ["codex", "resume", "thread"] }),
        }),
      },
      { provider: provider("readonly") },
    ];
    const respond = await call("sessions.catalog.list", {});
    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({ capabilities: expect.objectContaining({ openTerminal: true }) }),
        expect.objectContaining({ capabilities: { continueSession: false, archive: false } }),
      ],
    });
  });

  it("refreshes a provider's core new-session target when listing", async () => {
    let createSession: { model: string; agentRuntime: string } | undefined = {
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    };
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => createSession,
        }),
      },
    ];

    const respond = await call("sessions.catalog.list", {});

    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "claude",
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
        }),
      ],
    });

    createSession = undefined;
    const refreshed = await call("sessions.catalog.list", {});
    expect(refreshed).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "claude",
          capabilities: {
            continueSession: false,
            archive: false,
          },
        }),
      ],
    });
  });

  it("keeps creation available when catalog history listing fails", async () => {
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => ({
            model: "anthropic/claude-opus-4-8",
            agentRuntime: "claude-cli",
          }),
          list: vi.fn(async () => {
            throw new Error("history unavailable");
          }),
        }),
      },
    ];

    const respond = await call("sessions.catalog.list", {});

    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
          error: { code: "catalog_error", message: "history unavailable" },
        }),
      ],
    });
  });

  it("resolves creation capability for the requested agent", async () => {
    const resolveCreateSession = vi.fn(({ agentId }: { agentId?: string }) =>
      agentId === "research"
        ? { model: "anthropic/claude-opus-4-8", agentRuntime: "claude-cli" }
        : undefined,
    );
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", { resolveCreateSession }),
      },
    ];

    const available = await call(
      "sessions.catalog.list",
      {
        agentId: "research",
        catalogId: "claude",
      },
      { agents: { list: [{ id: "main" }, { id: "research" }] } },
    );
    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "research" });
    expect(available).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: {
            continueSession: false,
            archive: false,
            createSession: { model: "anthropic/claude-opus-4-8" },
          },
        }),
      ],
    });
  });

  it("resolves the private runtime target separately from the public capability", () => {
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession: () => ({
            model: "anthropic/claude-opus-4-8",
            agentRuntime: "claude-cli",
          }),
        }),
      },
    ];

    expect(resolveSessionCatalogCreateTarget("claude", "research")).toEqual({
      ok: true,
      target: {
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
        pluginOwnerId: "anthropic",
      },
    });
    expect(resolveSessionCatalogCreateTarget("missing", "research")).toEqual({
      ok: false,
      message: "unknown session catalog: missing",
      unknownCatalog: true,
    });
  });

  it("dispatches continue by catalog id with the caller's scopes", async () => {
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:adopted" }));
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { continueSession }) }];
    const respond = await call(
      "sessions.catalog.continue",
      {
        catalogId: "codex",
        hostId: "gateway:local",
        threadId: "thread-1",
      },
      {},
      { connect: { scopes: ["operator.write", "operator.admin"] } },
    );
    expect(continueSession).toHaveBeenCalledWith({
      hostId: "gateway:local",
      threadId: "thread-1",
      clientScopes: ["operator.write", "operator.admin"],
    });
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:adopted" });
  });

  it("forwards empty scopes for unscoped callers", async () => {
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:main:adopted" }));
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { continueSession }) }];
    await call("sessions.catalog.continue", {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });
    expect(continueSession).toHaveBeenCalledWith({
      hostId: "gateway:local",
      threadId: "thread-1",
      clientScopes: [],
    });
  });

  it("installs a provider-requested binding on the adopted Control UI session", async () => {
    const afterConversationBound = vi.fn(async () => undefined);
    const continueSession = vi.fn(async () => ({
      sessionKey: "agent:main:adopted",
      conversationBinding: {
        summary: "Continue remotely",
        data: { kind: "remote-runtime", version: 1 },
      },
      afterConversationBound,
    }));
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "remote",
        pluginName: "Remote Runtime",
        rootDir: "/plugins/remote",
        source: "/plugins/remote/index.ts",
        provider: provider("remote", { continueSession }),
      },
    ];

    const respond = await call("sessions.catalog.continue", {
      catalogId: "remote",
      hostId: "node:devbox",
      threadId: "thread-1",
    });

    expect(conversationBindingMocks.bindPluginSessionConversation).toHaveBeenCalledWith({
      pluginId: "remote",
      pluginName: "Remote Runtime",
      pluginRoot: "/plugins/remote",
      sessionKey: "agent:main:adopted",
      binding: {
        summary: "Continue remotely",
        data: { kind: "remote-runtime", version: 1 },
      },
      afterBind: afterConversationBound,
    });
    expect(afterConversationBound).toHaveBeenCalledOnce();
    expect(
      conversationBindingMocks.bindPluginSessionConversation.mock.invocationCallOrder[0],
    ).toBeLessThan(afterConversationBound.mock.invocationCallOrder[0] ?? 0);
    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:adopted" });
  });

  it("records an upstream link and adopted event for a linkable continue", async () => {
    const continueSession = vi.fn(async () => ({
      sessionKey: "agent:main:adopted",
      upstream: {
        kind: "codex-app-server" as const,
        ref: { fingerprint: "connection-1", threadId: "thread-1" },
        marker: { turnId: "turn-1" },
      },
    }));
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { continueSession }) }];

    const respond = await call("sessions.catalog.continue", {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
    });

    expect(respond).toHaveBeenCalledWith(true, { sessionKey: "agent:main:adopted" });
    expect(hoisted.upsertSessionUpstreamLink).toHaveBeenCalledWith({
      sessionKey: "agent:main:adopted",
      agentId: "main",
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-1",
      upstreamKind: "codex-app-server",
      upstreamRef: { fingerprint: "connection-1", threadId: "thread-1" },
      marker: { turnId: "turn-1" },
    });
    expect(hoisted.recordSessionStateEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:adopted",
      agentId: "main",
      kind: "adopted",
      actorType: "human",
      summary: "adopted from codex",
      payload: { catalogId: "codex", hostId: "gateway:local" },
      dedupeKey: "adopted:agent:main:adopted",
    });
  });

  it("does not publish provider adoption when the Control UI binding fails", async () => {
    const afterConversationBound = vi.fn(async () => undefined);
    conversationBindingMocks.bindPluginSessionConversation.mockRejectedValueOnce(
      new Error("binding failed"),
    );
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "remote",
        rootDir: "/plugins/remote",
        source: "/plugins/remote/index.ts",
        provider: provider("remote", {
          continueSession: vi.fn(async () => ({
            sessionKey: "agent:main:pending",
            conversationBinding: { data: { kind: "remote-runtime", version: 1 } },
            afterConversationBound,
          })),
        }),
      },
    ];

    const respond = await call("sessions.catalog.continue", {
      catalogId: "remote",
      hostId: "node:devbox",
      threadId: "thread-1",
    });

    expect(afterConversationBound).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "binding failed" }),
    );
  });

  it("removes the Control UI binding when provider adoption cannot finalize", async () => {
    const afterConversationBound = vi.fn(async () => {
      throw new Error("finalization failed");
    });
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "remote",
        rootDir: "/plugins/remote",
        source: "/plugins/remote/index.ts",
        provider: provider("remote", {
          continueSession: vi.fn(async () => ({
            sessionKey: "agent:main:pending",
            conversationBinding: { data: { kind: "remote-runtime", version: 1 } },
            afterConversationBound,
          })),
        }),
      },
    ];

    const respond = await call("sessions.catalog.continue", {
      catalogId: "remote",
      hostId: "node:devbox",
      threadId: "thread-1",
    });

    expect(afterConversationBound).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: "finalization failed" }),
    );
  });

  it("rejects an unknown catalog id when listing", async () => {
    const respond = await call("sessions.catalog.list", { catalogId: "missing" });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.INVALID_REQUEST,
        message: "unknown session catalog: missing",
      }),
    );
  });
});
