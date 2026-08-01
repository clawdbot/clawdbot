// Session resolve tests cover canonical/legacy key lookup, store migration,
// agent scoping, listed-session selection, and protocol error mapping.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  listSessionsFromStoreMock: vi.fn(),
  resolveGatewaySessionStoreTargetWithStoreMock: vi.fn(),
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

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    listSessionsFromStore: hoisted.listSessionsFromStoreMock,
    resolveGatewaySessionStoreTargetWithStore:
      hoisted.resolveGatewaySessionStoreTargetWithStoreMock,
    loadCombinedSessionStoreForGateway: hoisted.loadCombinedSessionStoreForGatewayMock,
  };
});

const { resolveSessionKeyFromResolveParams } = await import("./sessions-resolve.js");

describe("resolveSessionKeyFromResolveParams", () => {
  const canonicalKey = "agent:main:canon";
  const legacyKey = "agent:main:legacy";
  const storePath = "/tmp/sessions.json";
  let targetStore: Record<string, SessionEntry>;

  const expectResolveToCanonicalKey = async (
    p: Parameters<typeof resolveSessionKeyFromResolveParams>[0]["p"],
  ) => {
    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p,
      }),
    ).resolves.toEqual({
      ok: true,
      key: canonicalKey,
    });
    expect(hoisted.listSessionsFromStoreMock).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    hoisted.listSessionsFromStoreMock.mockReset();
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReset();
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    targetStore = {};
    // Default: all agents are known (main is always present).
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockImplementation(() => ({
      canonicalKey,
      storeKeys: [canonicalKey, legacyKey],
      storePath,
      store: targetStore,
    }));
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", async () => {
    const canonicalValidationError = new Error("openclaw doctor --fix");
    targetStore = {
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
      [legacyKey]: { sessionId: "sess-legacy", updatedAt: 0 },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey,
      canonicalValidationError,
      storeKeys: [canonicalKey, legacyKey],
      storePath,
      store: targetStore,
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
    expect(hoisted.resolveGatewaySessionStoreTargetWithStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ deferCanonicalValidation: true }),
    );
  });

  it("does not resolve reserved keys through a spawnedBy filter", async () => {
    targetStore = {
      global: { sessionId: "global-session", updatedAt: 1 },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: "global",
      storeKeys: ["global"],
      storePath,
      store: targetStore,
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: "global", spawnedBy: "agent:main:parent", includeGlobal: true },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message: "No session found: global" },
    });
  });

  it("hides a legacy alias whose canonical key is a reserved session", async () => {
    targetStore = {
      main: { sessionId: "global-session", updatedAt: 1 },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: "global",
      storeKeys: ["global", "main"],
      storePath,
      store: targetStore,
    });

    await expect(
      resolveSessionKeyFromResolveParams({ cfg: {}, p: { key: "main" } }),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message: "No session found: main" },
    });
  });

  it("does not resolve phantom agent store placeholder rows", async () => {
    const placeholderKey = "agent:main:sessions";
    targetStore = { [placeholderKey]: {} as SessionEntry };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: placeholderKey,
      storeKeys: [placeholderKey],
      storePath,
      store: targetStore,
    });

    await expect(
      resolveSessionKeyFromResolveParams({ cfg: {}, p: { key: placeholderKey } }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${placeholderKey}`,
      },
    });
  });

  it("does not resolve hidden cron-run keys without a lineage filter", async () => {
    const cronKey = "agent:main:cron:job-1:run:attempt-1";
    targetStore = { [cronKey]: { sessionId: "cron-session", updatedAt: 1 } };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: cronKey,
      storeKeys: [cronKey],
      storePath,
      store: targetStore,
    });

    await expect(
      resolveSessionKeyFromResolveParams({ cfg: {}, p: { key: cronKey } }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: `No session found: ${cronKey}`,
      },
    });
  });

  it("resolves an explicitly included global key within an agent scope", async () => {
    targetStore = {
      global: { sessionId: "global-session", updatedAt: 1 },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: "global",
      storeKeys: ["global"],
      storePath,
      store: targetStore,
    });
    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { agentId: "ops", includeGlobal: true, key: "global" },
      }),
    ).resolves.toEqual({ ok: true, key: "global" });
  });

  it("does not page-limit exact key spawnedBy visibility checks", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      [canonicalKey]: {
        sessionId: "sess-target",
        spawnedBy: "controller-1",
        updatedAt: now - 10_000,
      },
    };
    for (let i = 0; i < 120; i += 1) {
      store[`agent:main:sibling-${i}`] = {
        sessionId: `sess-sibling-${i}`,
        spawnedBy: "controller-1",
        updatedAt: now - i,
      };
    }
    targetStore = store;

    await expectResolveToCanonicalKey({ key: canonicalKey, spawnedBy: "controller-1" });
  });

  it("resolves an archived session by its exact key", async () => {
    targetStore = {
      [canonicalKey]: { archivedAt: 2, sessionId: "sess-archived", updatedAt: 1 },
    };

    await expectResolveToCanonicalKey({ key: canonicalKey });
  });

  it("applies agent scope before resolving an exact key", async () => {
    targetStore = {
      [canonicalKey]: { sessionId: "sess-scoped", updatedAt: 1 },
    };
    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { agentId: "ops", key: canonicalKey },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message: `No session found: ${canonicalKey}` },
    });
  });

  it("rejects legacy keys with doctor repair guidance", async () => {
    const store = {
      [legacyKey]: { sessionId: "sess-legacy", spawnedBy: "controller-1", updatedAt: Date.now() },
    } satisfies Record<string, SessionEntry>;
    targetStore = store;

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("hides a legacy-only row that fails the spawnedBy visibility filter", async () => {
    targetStore = {
      [legacyKey]: { sessionId: "sess-legacy", spawnedBy: "other-controller", updatedAt: 1 },
    };

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: canonicalKey, spawnedBy: "controller-1" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message: `No session found: ${canonicalKey}` },
    });
  });

  it("rejects a legacy alias even when the canonical row exists", async () => {
    targetStore = {
      [canonicalKey]: { sessionId: "sess-canonical", updatedAt: 2 },
      [legacyKey]: { sessionId: "sess-legacy", updatedAt: 1 },
    };

    await expect(
      resolveSessionKeyFromResolveParams({ cfg: {}, p: { key: canonicalKey } }),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("does not let allowMissing mask a deleted-agent error", async () => {
    const deletedAgentKey = "agent:deleted-agent:main";
    targetStore = {
      [deletedAgentKey]: { sessionId: "sess-orphan", updatedAt: 1 },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: deletedAgentKey,
      storeKeys: [deletedAgentKey],
      storePath,
      store: targetStore,
    });
    // "deleted-agent" is not in the known agents list.
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: { key: deletedAgentKey, allowMissing: true },
    });

    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });

  it("resolves ACP harness session keys even when harness id is not in agents.list", async () => {
    const acpKey = "agent:claude:acp:11111111-1111-4111-8111-111111111111";
    targetStore = {
      [acpKey]: {
        sessionId: "sess-acp",
        updatedAt: 1,
        label: "claude-delegate-test",
        acp: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: acpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 1,
        },
      },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: acpKey,
      storeKeys: [acpKey],
      storePath,
      store: targetStore,
    });
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { key: acpKey },
      }),
    ).resolves.toEqual({
      ok: true,
      key: acpKey,
    });
  });

  it("rejects non-alias agent:main sessions when main is no longer configured", async () => {
    const staleMainKey = "agent:main:guildchat:direct:u1";
    targetStore = {
      [staleMainKey]: { sessionId: "sess-stale-main", updatedAt: 1 },
    };
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockReturnValue({
      canonicalKey: staleMainKey,
      storeKeys: [staleMainKey],
      storePath,
      store: targetStore,
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

  it("resolves sessionId matches from raw store metadata without hydrating session rows", async () => {
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        "agent:main:noisy": { sessionId: "sess-noisy", updatedAt: 2 },
        "agent:main:target": { sessionId: "sess-target", updatedAt: 1 },
      },
    });
    hoisted.listSessionsFromStoreMock.mockImplementation(() => {
      throw new Error("session rows should not be materialized for exact sessionId lookup");
    });

    const cfg = {};
    const result = await resolveSessionKeyFromResolveParams({
      cfg,
      p: { sessionId: "sess-target", agentId: "main" },
    });

    expect(result).toEqual({ ok: true, key: "agent:main:target" });
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({
        agentId: "main",
        projection: "list",
        query: expect.objectContaining({ sessionId: "sess-target" }),
      }),
    );
    expect(hoisted.listSessionsFromStoreMock).not.toHaveBeenCalled();
  });

  it("rejects a noncanonical sessionId match", async () => {
    const aliasKey = "agent:main:main";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: { [aliasKey]: { sessionId: "sess-alias", updatedAt: 1 } },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: { session: { mainKey: "work" } },
        p: { sessionId: "sess-alias" },
      }),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("rejects a noncanonical label match", async () => {
    const aliasKey = "agent:main:main";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: { [aliasKey]: { label: "alias", sessionId: "sess-alias", updatedAt: 1 } },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: { session: { mainKey: "work" } },
        p: { label: "alias" },
      }),
    ).rejects.toThrow("openclaw doctor --fix");
  });

  it("ignores unrelated noncanonical rows during label resolution", async () => {
    const canonicalLabelKey = "agent:main:target";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        [canonicalLabelKey]: { label: "target", sessionId: "sess-target", updatedAt: 2 },
        main: { label: "other", sessionId: "sess-other", updatedAt: 1 },
      },
    });

    await expect(
      resolveSessionKeyFromResolveParams({ cfg: {}, p: { label: "target" } }),
    ).resolves.toEqual({ ok: true, key: canonicalLabelKey });
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

    const cfg = {};
    const result = await resolveSessionKeyFromResolveParams({
      cfg,
      p: { label: "my-label" },
    });

    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({
        agentId: undefined,
        projection: "list",
        query: expect.objectContaining({ label: "my-label" }),
      }),
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: 'Agent "deleted-agent" no longer exists in configuration',
      },
    });
  });
});
