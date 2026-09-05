// Session resolve tests cover canonical/legacy key lookup, store migration,
// agent scoping, listed-session selection, and protocol error mapping.
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../config/sessions/types.js";
import * as sessionRows from "./session-utils-row.js";

const hoisted = vi.hoisted(() => ({
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
  };

  beforeEach(() => {
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

  it.each([
    { sessionId: "sess-target", agentId: "main" },
    { label: "target-label", agentId: "main" },
  ])("resolves %j from raw metadata without hydrating session rows", async (p) => {
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        "agent:main:noisy": {
          sessionId: "sess-noisy",
          label: "target-label extra",
          updatedAt: 2,
        },
        "agent:main:target": { sessionId: "sess-target", label: "target-label", updatedAt: 1 },
      },
    });
    const rowSpy = vi.spyOn(sessionRows, "buildGatewaySessionRow");
    onTestFinished(() => rowSpy.mockRestore());

    const cfg = {};
    const result = await resolveSessionKeyFromResolveParams({ cfg, p });

    expect(result).toEqual({ ok: true, key: "agent:main:target", agentId: "main" });
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
    expect(rowSpy).not.toHaveBeenCalled();
  });

  it("resolves archived short ids without projecting unrelated model metadata", async () => {
    const key = "agent:main:thread:abcdef12-3456-4789-8abc-def012345678";
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: {
        [key]: {
          sessionId: "sess-short",
          updatedAt: 10,
          archivedAt: 20,
          displayName: "Release monitor",
          label: "Renamed release monitor",
          boardFace: "dashboard",
          get modelOverride(): string {
            throw new Error("Short references must not resolve model metadata");
          },
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
      displayName: "Renamed release monitor",
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
    { key: "agent:main:deploy-monitor", slug: "deploy-monitor", expected: "literal" },
    { key: "agent:main:missing", slug: "deploy-monitor", expected: "slug" },
    { key: "agent:main:missing", expected: "missing" },
  ])("discovers a named reference with exact-key precedence: $expected", async (reference) => {
    const literal = "agent:main:deploy-monitor";
    const slugKey = "agent:main:thread:12345678-0000-4000-8000-000000000001";
    const store = {
      [literal]: { updatedAt: 1, displayName: "Literal session", boardFace: "chat" as const },
      [slugKey]: { updatedAt: 2, displayName: "Deploy: monitor", boardFace: "dashboard" as const },
    };
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store,
      agentIdBySessionKey: new Map(Object.keys(store).map((key) => [key, "main"])),
    });
    const result = await resolveSessionKeyFromResolveParams({
      cfg: {},
      p: {
        reference: { key: reference.key, slug: reference.slug },
        agentId: "main",
        allowMissing: true,
      },
    });
    expect(result).toEqual(
      reference.expected === "missing"
        ? { ok: true, missing: true }
        : {
            ok: true,
            key: reference.expected === "literal" ? literal : slugKey,
            agentId: "main",
            displayName: reference.expected === "literal" ? "Literal session" : "Deploy: monitor",
            boardFace: reference.expected === "literal" ? "chat" : "dashboard",
          },
    );
  });

  it("resolves a configured global alias with its stored non-default owner", async () => {
    hoisted.listAgentIdsMock.mockReturnValue(["main", "work"]);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store: { global: { updatedAt: 1, displayName: "Work dashboard", boardFace: "dashboard" } },
      agentIdBySessionKey: new Map([["global", "work"]]),
    });
    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: { session: { scope: "global", mainKey: "primary" } },
        p: { reference: { key: "agent:work:primary" }, agentId: "work", includeGlobal: true },
      }),
    ).resolves.toEqual({
      ok: true,
      key: "global",
      agentId: "work",
      displayName: "Work dashboard",
      boardFace: "dashboard",
    });
  });

  it.each(["!Room:example.org", "!room:example.org"])(
    "preserves opaque reference key casing: %s",
    async (room) => {
      const key = "agent:main:matrix:channel:!Room:example.org";
      hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
        storePath,
        store: { [key]: { updatedAt: 1, displayName: "Room" } },
        agentIdBySessionKey: new Map([[key, "main"]]),
      });
      const result = await resolveSessionKeyFromResolveParams({
        cfg: {},
        p: {
          reference: { key: `agent:main:matrix:channel:${room}` },
          agentId: "main",
          allowMissing: true,
        },
      });
      expect(result).toEqual(
        room.startsWith("!Room")
          ? { ok: true, key, agentId: "main", displayName: "Room" }
          : { ok: true, missing: true },
      );
    },
  );

  it("bounds named-reference ambiguity after excluding deleted agents and non-UUID titles", async () => {
    const store = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `agent:main:thread:12345678-${index.toString(16).padStart(4, "0")}-4000-8000-000000000000`,
        {
          updatedAt: 100 - index,
          displayName: "Shared dashboard",
          boardFace: "dashboard" as const,
        },
      ]),
    );
    const keys = Object.keys(store);
    store["agent:deleted:thread:12345678-ffff-4000-8000-000000000000"] = {
      updatedAt: 200,
      displayName: "Shared dashboard",
      boardFace: "dashboard",
    };
    store["agent:main:literal"] = {
      updatedAt: 300,
      displayName: "Shared dashboard",
      boardFace: "dashboard",
    };
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath,
      store,
      agentIdBySessionKey: new Map(Object.keys(store).map((key) => [key, "main"])),
    });
    await expect(
      resolveSessionKeyFromResolveParams({
        cfg: {},
        p: { reference: { key: "agent:main:missing", slug: "shared-dashboard" } },
      }),
    ).resolves.toEqual({
      ok: true,
      ambiguous: true,
      candidates: keys.slice(0, 10).map((key) => ({
        key,
        agentId: "main",
        displayName: "Shared dashboard",
        boardFace: "dashboard",
      })),
    });
  });

  it.each([
    {
      p: { shortId: "too-short" },
      message: "shortId must be 8-32 hexadecimal characters",
    },
    { p: { label: "release", slugHint: "release" }, message: "slugHint requires shortId" },
    {
      p: { key: "agent:main:literal", reference: { key: "agent:main:literal" } },
      message: "Provide either key, sessionId, label, shortId, or reference (not multiple)",
    },
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
    hoisted.listAgentIdsMock.mockReturnValue(["main"]);

    const cfg = {};
    const result = await resolveSessionKeyFromResolveParams({
      cfg,
      p: { label: "my-label" },
    });

    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: undefined,
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
