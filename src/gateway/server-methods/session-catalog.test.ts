import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../../packages/gateway-protocol/src/index.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { bindPluginRegistryRuntime } from "../../plugins/registry-runtime-binding.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import type { SessionCatalogProvider } from "../../plugins/session-catalog.js";

type TestPluginRegistry = Omit<PluginRegistry, "sessionCatalogs"> & {
  sessionCatalogs: Array<{
    pluginId?: string;
    pluginName?: string;
    provider: SessionCatalogProvider;
    rootDir?: string;
    source?: string;
  }>;
};

const hoisted = vi.hoisted(() => ({
  activeRegistry: {} as TestPluginRegistry,
  hasMultipleSessionSharingIdentities: vi.fn(() => false),
  listSessionEntriesReadOnly: vi.fn<
    (scope?: { agentId?: string; clone?: boolean; projection?: "full" | "list" }) => Array<{
      sessionKey: string;
      entry: {
        createdActor?: { type: "human" | "agent" | "system"; id?: string };
        updatedAt?: number;
      };
    }>
  >(() => []),
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
  getActivePluginRegistry: () => hoisted.activeRegistry,
  requireActivePluginRegistry: () => hoisted.activeRegistry,
}));

vi.mock("../../sessions/session-state-events.js", () => ({
  recordSessionStateEvent: hoisted.recordSessionStateEvent,
}));

vi.mock("../../sessions/session-upstream-links.js", () => ({
  upsertSessionUpstreamLink: hoisted.upsertSessionUpstreamLink,
}));
vi.mock("../../plugins/session-conversation-binding.js", () => ({
  bindPluginSessionConversation: conversationBindingMocks.bindPluginSessionConversation,
}));
vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/session-accessor.js")>();
  return { ...actual, listSessionEntriesReadOnly: hoisted.listSessionEntriesReadOnly };
});
vi.mock("../../state/user-profiles.js", () => ({
  hasMultipleSessionSharingIdentities: hoisted.hasMultipleSessionSharingIdentities,
}));
const { resolveRegisteredCatalogCreateTarget, sessionCatalogHandlers } =
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
  const pending = startCall(method, params, config, client, contextOverrides);
  await pending.completion;
  return pending.respond;
}

function startCall(
  method: keyof typeof sessionCatalogHandlers,
  params: unknown,
  config: Record<string, unknown> = {},
  client?: { connect?: { scopes?: string[] }; connId?: string },
  contextOverrides: Record<string, unknown> = {},
) {
  const respond = vi.fn();
  const completion = Promise.resolve(
    sessionCatalogHandlers[method]?.({
      params,
      respond,
      client,
      context: { getRuntimeConfig: () => config, ...contextOverrides },
    } as never),
  );
  return { completion, respond };
}

describe("session catalog Gateway methods", () => {
  beforeEach(() => {
    hoisted.activeRegistry = createEmptyPluginRegistry() as TestPluginRegistry;
    hoisted.hasMultipleSessionSharingIdentities.mockReset().mockReturnValue(false);
    hoisted.listSessionEntriesReadOnly.mockReset();
    hoisted.listSessionEntriesReadOnly.mockReturnValue([]);
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

  it("single-flights identical concurrent lists and fans progress to active followers", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host = {
      hostId: "gateway:local",
      label: "Local",
      kind: "gateway" as const,
      connected: true,
      sessions: [],
    };
    const list = vi.fn(async ({ onHost }: { onHost?: (value: typeof host) => void }) => {
      await gate;
      onHost?.(host);
      return [host];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = { agents: { list: [{ id: "main" }, { id: "research" }] } };
    const leaderBroadcast = vi.fn();
    const followerBroadcast = vi.fn();
    const leader = startCall(
      "sessions.catalog.list",
      { progressId: "leader-progress", agentId: "main" },
      config,
      { connId: "leader" },
      { broadcastToConnIds: leaderBroadcast },
    );
    const follower = startCall(
      "sessions.catalog.list",
      { progressId: "follower-progress", agentId: "main" },
      config,
      { connId: "follower" },
      { broadcastToConnIds: followerBroadcast },
    );
    const otherAgent = startCall("sessions.catalog.list", { agentId: "research" }, config);
    const otherParams = startCall(
      "sessions.catalog.list",
      { search: "other", agentId: "main" },
      config,
    );

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    release();
    await Promise.all([
      leader.completion,
      follower.completion,
      otherAgent.completion,
      otherParams.completion,
    ]);

    expect(leaderBroadcast).toHaveBeenCalledOnce();
    expect(followerBroadcast).toHaveBeenCalledOnce();
    for (const pending of [leader, follower, otherAgent, otherParams]) {
      expect(pending.respond).toHaveBeenCalledWith(true, {
        catalogs: [expect.objectContaining({ id: "codex", hosts: [host] })],
      });
    }
  });

  it("forwards one explicit multi-agent owner through list, read, continue, and archive", async () => {
    const host = {
      hostId: "gateway:local",
      label: "Local Codex",
      kind: "gateway" as const,
      connected: true,
      sessions: [
        {
          threadId: "thread-beta",
          status: "stored",
          archived: false,
          canContinue: true,
          canArchive: true,
        },
      ],
    };
    const list = vi.fn(async (_request: { agentId?: string }) => [host]);
    const read = vi.fn(async ({ hostId, threadId }) => ({ hostId, threadId, items: [] }));
    const continueSession = vi.fn(async () => ({ sessionKey: "agent:beta:continued" }));
    const archive = vi.fn(async () => ({ ok: true as const }));
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("codex", { list, read, continueSession, archive }) },
    ];
    const config = {
      agents: {
        ownership: "explicit",
        entries: { alpha: {}, beta: {} },
      },
    };
    const locator = {
      catalogId: "codex",
      hostId: "gateway:local",
      threadId: "thread-beta",
      agentId: "beta",
    };

    await call("sessions.catalog.list", { catalogId: "codex", agentId: "beta" }, config);
    await call("sessions.catalog.read", locator, config);
    await call("sessions.catalog.continue", locator, config);
    await call("sessions.catalog.archive", { ...locator, confirmNoOtherRunner: true }, config);

    for (const [request] of list.mock.calls) {
      expect(request).toEqual(expect.objectContaining({ agentId: "beta" }));
    }
    expect(read).toHaveBeenCalledWith(expect.objectContaining({ agentId: "beta" }));
    expect(continueSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: "beta" }));
    expect(archive).toHaveBeenCalledWith(expect.objectContaining({ agentId: "beta" }));
  });

  it("keeps differently ordered host filters distinct when sharing lists", async () => {
    const observedHostIds: Array<string[] | undefined> = [];
    const list = vi.fn(async ({ hostIds }: { hostIds?: string[] }) => {
      observedHostIds.push(hostIds ? [...hostIds] : undefined);
      return [];
    });
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};

    await Promise.all([
      call("sessions.catalog.list", { hostIds: ["host-a", "host-b"] }, config),
      call("sessions.catalog.list", { hostIds: ["host-b", "host-a"] }, config),
    ]);

    expect(list).toHaveBeenCalledTimes(2);
    expect(observedHostIds).toEqual([
      ["host-a", "host-b"],
      ["host-b", "host-a"],
    ]);
  });

  it("shares settled identical lists across out-of-phase clients until the window expires", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const list = vi.fn(async () => []);
    hoisted.activeRegistry.sessionCatalogs = [{ provider: provider("codex", { list }) }];
    const config = {};
    try {
      await call("sessions.catalog.list", {}, config);

      now += 2_500;
      await call("sessions.catalog.list", {}, config);
      expect(list).toHaveBeenCalledOnce();

      now += 501;
      await call("sessions.catalog.list", {}, config);
      expect(list).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
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
          createdActor: { type: "human" as const, id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
        {
          threadId: "missing-thread",
          status: "stored",
          archived: false,
          sessionKey: "agent:main:missing",
          createdActor: { type: "human" as const, id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
        {
          threadId: "external-thread",
          status: "stored",
          archived: false,
          createdActor: { type: "human" as const, id: "provider-spoof" },
          canContinue: true,
          canArchive: false,
        },
      ],
    };
    hoisted.listSessionEntriesReadOnly.mockReturnValue([
      {
        sessionKey: "agent:main:owned",
        entry: { createdActor: { type: "agent", id: "worker-1" }, updatedAt: 1 },
      },
    ]);
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
        createdActor: { type: "agent", id: "worker-1" },
      }),
      expect.not.objectContaining({ createdActor: expect.anything() }),
      expect.not.objectContaining({ createdActor: expect.anything() }),
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
    expect(hoisted.listSessionEntriesReadOnly).toHaveBeenCalledOnce();
    expect(hoisted.listSessionEntriesReadOnly).toHaveBeenCalledWith({
      agentId: "main",
      clone: false,
      projection: "list",
    });
  });

  it("does not clone the shared list projection for a settled shared catalog result", async () => {
    const storedEntries = [
      {
        sessionKey: "agent:main:shared",
        entry: { createdActor: { type: "agent" as const, id: "worker" }, updatedAt: 1 },
      },
    ];
    hoisted.listSessionEntriesReadOnly.mockImplementation((scope) =>
      scope?.clone === false ? storedEntries : structuredClone(storedEntries),
    );
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("claude", {
          list: vi.fn(async ({ sessionEntries }) => {
            sessionEntries?.entriesForAgent("main");
            return [];
          }),
        }),
      },
    ];
    const cloneSpy = vi.spyOn(globalThis, "structuredClone");
    const config = {};
    try {
      await call("sessions.catalog.list", {}, config);
      await call("sessions.catalog.list", {}, config);

      expect(cloneSpy).not.toHaveBeenCalled();
      expect(hoisted.listSessionEntriesReadOnly).toHaveBeenCalledOnce();
      expect(hoisted.listSessionEntriesReadOnly).toHaveBeenLastCalledWith({
        agentId: "main",
        clone: false,
        projection: "list",
      });
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it("shares one lazy Gateway node snapshot across catalog providers", async () => {
    const dispatchNodeList = vi.fn(async () => ({
      nodes: [{ nodeId: "shared-node", connected: true }],
    }));
    bindPluginRegistryRuntime(
      hoisted.activeRegistry as PluginRegistry,
      createPluginRuntime({
        nodes: { list: dispatchNodeList, invoke: vi.fn(async () => undefined) },
      }),
    );
    const catalogUsingNodes = (id: string) =>
      provider(id, {
        list: vi.fn(async ({ listNodes }) => {
          expect(await listNodes?.()).toEqual({
            nodes: [{ nodeId: "shared-node", connected: true }],
          });
          return [];
        }),
      });
    hoisted.activeRegistry!.sessionCatalogs = [
      { provider: catalogUsingNodes("zeta") },
      { provider: catalogUsingNodes("alpha") },
    ];

    await call("sessions.catalog.list", {});

    expect(dispatchNodeList).toHaveBeenCalledOnce();
  });

  it("keeps catalog-filtered Gateway node snapshots lazy", async () => {
    const dispatchNodeList = vi.fn(async () => ({ nodes: [] }));
    bindPluginRegistryRuntime(
      hoisted.activeRegistry as PluginRegistry,
      createPluginRuntime({
        nodes: { list: dispatchNodeList, invoke: vi.fn(async () => undefined) },
      }),
    );
    const selectedList = vi.fn(async () => []);
    hoisted.activeRegistry!.sessionCatalogs = [
      { provider: provider("selected", { list: selectedList }) },
      {
        provider: provider("unselected", {
          list: vi.fn(async ({ listNodes }) => {
            await listNodes?.();
            return [];
          }),
        }),
      },
    ];

    await call("sessions.catalog.list", { catalogId: "selected" });

    expect(selectedList).toHaveBeenCalledWith(
      expect.objectContaining({ listNodes: expect.any(Function) }),
    );
    expect(dispatchNodeList).not.toHaveBeenCalled();
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

  it("advertises terminal start only inside implemented create capabilities", async () => {
    const createTarget = () => ({ model: "openai/gpt-5.6-sol", agentRuntime: "codex" });
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", {
          resolveCreateSession: createTarget,
          startTerminalSession: async ({ cwd }) => ({ kind: "local", argv: ["codex"], cwd }),
        }),
      },
      {
        provider: provider("readonly", { resolveCreateSession: createTarget }),
      },
    ];

    const respond = await call("sessions.catalog.list", {});

    expect(respond).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          id: "codex",
          capabilities: expect.objectContaining({
            createSession: { model: "openai/gpt-5.6-sol", startTerminal: true },
          }),
        }),
        expect.objectContaining({
          id: "readonly",
          capabilities: expect.objectContaining({
            createSession: { model: "openai/gpt-5.6-sol" },
          }),
        }),
      ],
    });
  });

  it("refuses direct terminal start when the requested agent has no create target", async () => {
    const resolveCreateSession = vi.fn(() => undefined);
    const startTerminalSession = vi.fn();
    const open = vi.fn();
    hoisted.activeRegistry.sessionCatalogs = [
      {
        provider: provider("codex", { resolveCreateSession, startTerminalSession }),
      },
    ];
    const config = { gateway: { cliAgents: { enabled: true } } };

    const respond = await call(
      "sessions.catalog.startTerminal",
      { catalogId: "codex", agentId: "restricted", cwd: process.cwd() },
      config,
      { connId: "conn-1", connect: { scopes: ["operator.admin"] } },
      { isTerminalEnabled: () => true, terminalSessions: { open } },
    );

    expect(resolveCreateSession).toHaveBeenCalledWith({ agentId: "restricted" });
    expect(startTerminalSession).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: ErrorCodes.UNAVAILABLE,
        message: "session catalog codex cannot create sessions",
      }),
    );
  });

  it("memoizes a provider's create target until runtime config identity changes", async () => {
    let createSession: { model: string; agentRuntime: string } | undefined = {
      model: "anthropic/claude-opus-4-8",
      agentRuntime: "claude-cli",
    };
    const resolveCreateSession = vi.fn(() => createSession);
    hoisted.activeRegistry.sessionCatalogs = [
      {
        pluginId: "anthropic",
        provider: provider("claude", {
          resolveCreateSession,
        }),
      },
    ];
    const config = {};

    const respond = await call("sessions.catalog.list", {}, config);

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
    const cached = await call("sessions.catalog.list", {}, config);
    expect(cached).toHaveBeenCalledWith(true, {
      catalogs: [
        expect.objectContaining({
          capabilities: expect.objectContaining({
            createSession: { model: "anthropic/claude-opus-4-8" },
          }),
        }),
      ],
    });
    expect(resolveCreateSession).toHaveBeenCalledOnce();

    const refreshed = await call("sessions.catalog.list", {}, {});
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
    expect(resolveCreateSession).toHaveBeenCalledTimes(2);
  });

  it("retries an exception-derived create target failure without a config reload", async () => {
    let now = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    const resolveCreateSession = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("provider warming");
      })
      .mockReturnValue({
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
      });
    hoisted.activeRegistry.sessionCatalogs = [
      { provider: provider("claude", { resolveCreateSession }) },
    ];
    const config = {};

    try {
      const unavailable = await call("sessions.catalog.list", {}, config);
      expect(unavailable).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            capabilities: { continueSession: false, archive: false },
          }),
        ],
      });
      now += 3_001;
      const recovered = await call("sessions.catalog.list", {}, config);
      expect(recovered).toHaveBeenCalledWith(true, {
        catalogs: [
          expect.objectContaining({
            capabilities: expect.objectContaining({
              createSession: { model: "anthropic/claude-opus-4-8" },
            }),
          }),
        ],
      });
      expect(resolveCreateSession).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
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

    expect(resolveRegisteredCatalogCreateTarget("claude", "research", {})).toEqual({
      ok: true,
      target: {
        model: "anthropic/claude-opus-4-8",
        agentRuntime: "claude-cli",
        pluginOwnerId: "anthropic",
      },
    });
    expect(resolveRegisteredCatalogCreateTarget("missing", "research", {})).toEqual({
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
      agentId: "main",
      allowProcessHomeFallback: false,
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
      agentId: "main",
      allowProcessHomeFallback: false,
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
