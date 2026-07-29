// Session resolve tests cover canonical/legacy key lookup, store migration,
// agent scoping, listed-session selection, and protocol error mapping.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  canonicalizeSessionEntryAliasesMock: vi.fn(),
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

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    canonicalizeSessionEntryAliases: hoisted.canonicalizeSessionEntryAliasesMock,
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
    hoisted.canonicalizeSessionEntryAliasesMock.mockReset();
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
    hoisted.canonicalizeSessionEntryAliasesMock.mockImplementation(async () => {
      const entry = expectDefined(
        targetStore[legacyKey] ?? targetStore[canonicalKey],
        "canonical session entry",
      );
      targetStore[canonicalKey] = entry;
      delete targetStore[legacyKey];
      return { canonicalKey, entry };
    });
  });

  it("hides canonical keys that fail the spawnedBy visibility filter", async () => {
    targetStore = {
      [canonicalKey]: { sessionId: "sess-1", updatedAt: 1 },
    };
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

  it("re-checks migrated legacy keys through the same visibility filter", async () => {
    const store = {
      [legacyKey]: { sessionId: "sess-legacy", spawnedBy: "controller-1", updatedAt: Date.now() },
    } satisfies Record<string, SessionEntry>;
    targetStore = store;

    await expectResolveToCanonicalKey({ key: canonicalKey, spawnedBy: "controller-1" });

    expect(hoisted.canonicalizeSessionEntryAliasesMock).toHaveBeenCalledTimes(1);
    expect(hoisted.canonicalizeSessionEntryAliasesMock).toHaveBeenCalledWith({
      storePath,
      target: {
        canonicalKey,
        storeKeys: [canonicalKey, legacyKey],
      },
    });
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
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
    expect(hoisted.listSessionsFromStoreMock).not.toHaveBeenCalled();
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
      p: { label: "my-label", agentId: "main" },
    });

    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
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
