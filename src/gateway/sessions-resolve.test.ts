import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { ErrorCodes } from "./protocol/index.js";

const hoisted = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
  listSessionsFromStoreMock: vi.fn(),
  migrateAndPruneGatewaySessionStoreKeyMock: vi.fn(),
  resolveGatewaySessionStoreTargetMock: vi.fn(),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
  listAgentIdsMock: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/agent-scope.js")>(
    "../agents/agent-scope.js",
  );
  return {
    ...actual,
    listAgentIds: hoisted.listAgentIdsMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    loadSessionStore: hoisted.loadSessionStoreMock,
    updateSessionStore: hoisted.updateSessionStoreMock,
  };
});

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    listSessionsFromStore: hoisted.listSessionsFromStoreMock,
    migrateAndPruneGatewaySessionStoreKey: hoisted.migrateAndPruneGatewaySessionStoreKeyMock,
    resolveGatewaySessionStoreTarget: hoisted.resolveGatewaySessionStoreTargetMock,
    loadCombinedSessionStoreForGateway: hoisted.loadCombinedSessionStoreForGatewayMock,
  };
});

const { resolveSessionKeyFromResolveParams } = await import("./sessions-resolve.js");

describe("resolveSessionKeyFromResolveParams", () => {
  const canonicalKey = "agent:main:canon";
  const legacyKey = "agent:main:legacy";
  const storePath = "/tmp/sessions.json";

  beforeEach(() => {
    hoisted.loadSessionStoreMock.mockReset();
    hoisted.updateSessionStoreMock.mockReset();
    hoisted.listSessionsFromStoreMock.mockReset();
    hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReset();
    hoisted.resolveGatewaySessionStoreTargetMock.mockReset();
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    // Default: all agents are known (main is always present).
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);
    hoisted.resolveGatewaySessionStoreTargetMock.mockReturnValue({
      canonicalKey,
      storeKeys: [canonicalKey, legacyKey],
      storePath,
    });
    hoisted.migrateAndPruneGatewaySessionStoreKeyMock.mockReturnValue({ primaryKey: canonicalKey });
    hoisted.updateSessionStoreMock.mockImplementation(
      async (_path: string, updater: (store: Record<string, SessionEntry>) => void) => {
        const store = hoisted.loadSessionStoreMock.mock.results[0]?.value as
          | Record<string, SessionEntry>
          | undefined;
        if (store) {
          updater(store);
        }
      },
    );
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", async () => {
    hoisted.loadSessionStoreMock.mockReturnValue({
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
    });
    hoisted.listSessionsFromStoreMock.mockReturnValue({ sessions: [] });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${canonicalKey}`,
      },
    });
  });

  it("re-checks migrated legacy keys through the same visibility filter", async () => {
    const store = {
      [legacyKey]: { sessionId: "sess-legacy", updatedAt: 1 },
    } satisfies Record<string, SessionEntry>;
    hoisted.loadSessionStoreMock.mockImplementation(() => store);
    hoisted.listSessionsFromStoreMock.mockReturnValue({
      sessions: [{ key: canonicalKey }],
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: true,
      key: canonicalKey,
    });

    expect(hoisted.updateSessionStoreMock).toHaveBeenCalledWith(storePath, expect.any(Function));
    expect(hoisted.listSessionsFromStoreMock).toHaveBeenCalledWith({
      cfg: {},
      storePath,
      store,
      opts: {
        includeGlobal: false,
        includeUnknown: false,
        spawnedBy: "controller-1",
        agentId: undefined,
      },
    });
  });

  it("rejects sessions belonging to a deleted agent (key-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.resolveGatewaySessionStoreTargetMock.mockReturnValue({
      canonicalKey: deletedAgentKey,
      storeKeys: [deletedAgentKey],
      storePath,
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 },
    });
    // "deleted-agent" is not in the known agents list.
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { key: deletedAgentKey },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("rejects non-alias agent:main sessions when main is no longer configured", async () => {
    const staleMainKey = "agent:main:guildchat:direct:u1";
    hoisted.resolveGatewaySessionStoreTargetMock.mockReturnValue({
      canonicalKey: staleMainKey,
      storeKeys: [staleMainKey],
      storePath,
    });
    hoisted.loadSessionStoreMock.mockReturnValue({
      [staleMainKey]: { sessionId: "sess-stale-main", updatedAt: 1 },
    });
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: { agents: { list: [{ id: "ops", default: true }] } },
      p: { key: staleMainKey },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "main" no longer exists in configuration',
      },
    });
  });

  it("rejects sessions belonging to a deleted agent (sessionId-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: { [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 } },
    });
    hoisted.listSessionsFromStoreMock.mockReturnValue({
      sessions: [{ key: deletedAgentKey, sessionId: "sess-orphan" }],
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { sessionId: "sess-orphan" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("rejects sessions belonging to a deleted agent (label-based lookup)", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: { [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1, label: "my-label" } },
    });
    hoisted.listSessionsFromStoreMock.mockReturnValue({
      sessions: [{ key: deletedAgentKey, sessionId: "sess-orphan", label: "my-label" }],
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { label: "my-label" },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });
});
