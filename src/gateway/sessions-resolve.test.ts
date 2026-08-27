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
    loadCombinedSessionStoreForGatewayCore: hoisted.loadCombinedSessionStoreForGatewayMock,
  };
});

const { resolveSessionKeyFromResolveParams: resolveSessionKeyFromResolveParamsWithClient } =
  await import("./sessions-resolve.js");

type ResolveParams = Parameters<typeof resolveSessionKeyFromResolveParamsWithClient>[0];

const resolveSessionKeyFromResolveParams = (
  params: Omit<ResolveParams, "client"> & { client?: ResolveParams["client"] },
) => resolveSessionKeyFromResolveParamsWithClient({ client: null, ...params });

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
      agentId: "main",
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

  it("rejects legacy keys with doctor repair guidance", async () => {
    hoisted.resolveGatewaySessionStoreTargetWithStoreMock.mockImplementationOnce(() => {
      throw Object.assign(new Error("stop the Gateway and run openclaw doctor --fix"), {
        code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED",
      });
    });

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
      agentId: "claude",
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

    expect(result).toEqual({ ok: true, key: "agent:main:target", agentId: "main" });
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
    expect(hoisted.listSessionsFromStoreMock).not.toHaveBeenCalled();
  });

  it("resolves an archived session by its trailing UUID prefix", async () => {
    const key = "agent:main:thread:abcdef12-3456-4789-8abc-def012345678";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        [key]: {
          sessionId: "sess-short",
          updatedAt: 10,
          archivedAt: 20,
          displayName: "Release monitor",
          boardFace: "dashboard",
        },
      },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "ABCDEF12", agentId: "main" },
      }),
    ).resolves.toEqual({
      ok: true,
      key,
      agentId: "main",
      displayName: "Release monitor",
      boardFace: "dashboard",
    });
  });

  it("uses a display-name slug only to narrow a short-id tie", async () => {
    const releaseKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deployKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        [releaseKey]: { updatedAt: 2, displayName: "Release monitor" },
        [deployKey]: { updatedAt: 1, displayName: "Deploy monitor", boardFace: "chat" },
      },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678", slugHint: "deploy-monitor" },
      }),
    ).resolves.toEqual({
      ok: true,
      key: deployKey,
      agentId: "main",
      displayName: "Deploy monitor",
      boardFace: "chat",
    });
  });

  it("ignores a deleted-agent short-id collision before resolving a unique match", async () => {
    const survivingKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
    const deletedKey = "agent:deleted-agent:thread:12345678-0bbb-4000-8000-000000000002";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        [deletedKey]: { updatedAt: 2, displayName: "Deleted session" },
        [survivingKey]: { updatedAt: 1, displayName: "Surviving session" },
      },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678", slugHint: "deleted-session" },
      }),
    ).resolves.toEqual({
      ok: true,
      key: survivingKey,
      agentId: "main",
      displayName: "Surviving session",
    });
  });

  it("reports a deleted-agent-only short-id match as missing", async () => {
    const deletedKey = "agent:deleted-agent:thread:12345678-0bbb-4000-8000-000000000002";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: { [deletedKey]: { updatedAt: 1, displayName: "Deleted session" } },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678" },
      }),
    ).resolves.toEqual({
      ok: false,
      error: {
        code: ErrorCodes.INVALID_REQUEST,
        message: "No session found: 12345678",
      },
    });
  });

  it("returns at most ten recent candidates and ignores a stale slug hint", async () => {
    const store = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => {
        const suffix = index.toString(16).padStart(4, "0");
        return [
          `agent:main:thread:12345678-${suffix}-4000-8000-000000000000`,
          {
            updatedAt: 100 - index,
            displayName: `Candidate ${index}`,
            ...(index % 2 === 0 ? { boardFace: "dashboard" as const } : {}),
          },
        ];
      }),
    );
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({ storePath, store });

    const expectedKeys = Object.keys(store).slice(0, 10);
    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "12345678", slugHint: "renamed-session" },
      }),
    ).resolves.toEqual({
      ok: true,
      ambiguous: true,
      candidates: expectedKeys.map((key, index) => {
        const candidate: {
          key: string;
          agentId: string;
          displayName: string;
          boardFace?: "dashboard";
        } = { key, agentId: "main", displayName: `Candidate ${index}` };
        if (index % 2 === 0) {
          candidate.boardFace = "dashboard";
        }
        return candidate;
      }),
    });
  });

  it("applies agent scoping to short-id matches", async () => {
    const mainKey = "agent:main:thread:feedface-0000-4000-8000-000000000001";
    const workKey = "agent:work:thread:feedface-0000-4000-8000-000000000002";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        [mainKey]: { updatedAt: 1 },
        [workKey]: { updatedAt: 2 },
      },
    });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: { agents: { list: [{ id: "main", default: true }, { id: "work" }] } },
        p: { shortId: "feedface", agentId: "main" },
      }),
    ).resolves.toEqual({ ok: true, key: mainKey, agentId: "main" });
  });

  it("supports allowMissing for short ids", async () => {
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({ storePath, store: {} });

    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { shortId: "deadbeef", allowMissing: true },
      }),
    ).resolves.toEqual({ ok: true, missing: true });
  });

  it.each([
    {
      p: { shortId: "too-short" },
      message: "shortId must be 8-32 hexadecimal characters",
    },
    { p: { label: "release", slugHint: "release" }, message: "slugHint requires shortId" },
  ])("rejects invalid short reference params: $message", async ({ p, message }) => {
    await expect(resolveSessionKeyFromResolveParams({ cfg: {}, p })).resolves.toMatchObject({
      ok: false,
      error: { code: ErrorCodes.INVALID_REQUEST, message },
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

    const cfg = {};
    const result = await resolveSessionKeyFromResolveParams({
      cfg,
      p: { label: "my-label", agentId: "main" },
    });

    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
    expect(hoisted.listSessionsFromStoreMock).toHaveBeenCalledWith(
      expect.objectContaining({ lightweightListRows: true }),
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
