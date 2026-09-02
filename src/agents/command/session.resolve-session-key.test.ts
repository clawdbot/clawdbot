// Covers cross-store session-key resolution for multi-agent session stores.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import { migratePersistedImplicitMainRoster } from "../../config/legacy.roster.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  listSessionEntriesMock: vi.fn<
    (scope?: { agentId?: string; storePath?: string; clone?: boolean }) => Array<{
      entry: SessionEntry;
      sessionKey: string;
    }>
  >(),
  loadExactSessionEntryMock:
    vi.fn<
      (scope: {
        storePath?: string;
        sessionKey: string;
      }) => { sessionKey: string; entry: SessionEntry } | undefined
    >(),
  listAgentIdsMock: vi.fn<() => string[]>(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntriesReadOnly: (scope?: { agentId?: string; storePath?: string; clone?: boolean }) =>
    hoisted.listSessionEntriesMock(scope),
  loadExactSessionEntryReadOnly: hoisted.loadExactSessionEntryMock,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (store?: string, params?: { agentId?: string }) =>
    store
      ? store.replace("{agentId}", params?.agentId ?? "main")
      : `/stores/${params?.agentId ?? "main"}.json`,
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: ({ sessionKey }: { sessionKey: string }) => sessionKey,
  resolveAgentIdFromSessionKey: () => "main",
  resolveExplicitAgentSessionKey: () => undefined,
}));

vi.mock("../agent-scope.js", async () => ({
  ...(await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js")),
  listAgentIds: () => hoisted.listAgentIdsMock(),
}));

const { resolveSessionKeyForRequestCore, resolveStoredSessionKeyForSessionId } =
  await import("./session.js");
const resolveSessionKeyForRequest = resolveSessionKeyForRequestCore;

function mockSessionStores(storesByPath: Record<string, Record<string, SessionEntry>>): void {
  hoisted.loadExactSessionEntryMock.mockImplementation(({ storePath, sessionKey }) => {
    const entry = storesByPath[storePath ?? ""]?.[sessionKey];
    return entry ? { sessionKey, entry: structuredClone(entry) } : undefined;
  });
  hoisted.listSessionEntriesMock.mockImplementation((scope) =>
    Object.entries(storesByPath[scope?.storePath ?? ""] ?? {}).map(([sessionKey, entry]) => ({
      sessionKey,
      entry,
    })),
  );
}

function expectResolvedRequestSession(params: {
  sessionId: string;
  sessionKey: string;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
}): void {
  const result = resolveSessionKeyForRequestCore({
    cfg: {
      session: {
        store: "/stores/{agentId}.json",
      },
    } satisfies OpenClawConfig,
    sessionId: params.sessionId,
  });

  expect(result.sessionKey).toBe(params.sessionKey);
  expect(result.sessionEntry).toEqual(params.sessionStore[params.sessionKey]);
  expect(result.storePath).toBe(params.storePath);
}

describe("resolveSessionKeyForRequest", () => {
  beforeEach(() => {
    hoisted.listSessionEntriesMock.mockReset();
    hoisted.loadExactSessionEntryMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    hoisted.listAgentIdsMock.mockReturnValue(["main", "other"]);
  });

  it("prefers the current store when equal duplicates exist across stores", () => {
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:main": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      "/stores/main.json": mainStore,
      "/stores/other.json": otherStore,
    });

    expectResolvedRequestSession({
      sessionId: "sid",
      sessionKey: "agent:main:main",
      sessionStore: mainStore,
      storePath: "/stores/main.json",
    });
  });

  it("keeps a cross-store structural winner over a newer local fuzzy duplicate", () => {
    // Structural keys beat fuzzy timestamp matches so ACP/subagent resumes do
    // not accidentally attach to a newer generic main-session duplicate.
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 20 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:acp:sid": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      "/stores/main.json": mainStore,
      "/stores/other.json": otherStore,
    });

    expectResolvedRequestSession({
      sessionId: "sid",
      sessionKey: "agent:other:acp:sid",
      sessionStore: otherStore,
      storePath: "/stores/other.json",
    });
  });

  it("scopes stored session-key lookup to the requested agent store", () => {
    const embeddedAgentStore = {
      "agent:embedded-agent:main": { sessionId: "other-session", updatedAt: 2 },
      "agent:embedded-agent:work": { sessionId: "resume-agent-1", updatedAt: 1 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/embedded-agent.json": embeddedAgentStore });

    const result = resolveStoredSessionKeyForSessionId({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } satisfies OpenClawConfig,
      sessionId: "resume-agent-1",
      agentId: "embedded-agent",
    });

    expect(result.sessionKey).toBe("agent:embedded-agent:work");
    expect(result.sessionEntry).toEqual(embeddedAgentStore["agent:embedded-agent:work"]);
    expect(result.storePath).toBe("/stores/embedded-agent.json");
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledTimes(1);
  });

  it("assigns unscoped shared-store rows to the persisted owner regardless of scan order", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["research", "ops"]);
    const sharedStore = {
      main: { sessionId: "ops-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });

    const result = resolveSessionKeyForRequest({
      cfg: {
        session: { store: "/stores/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { research: {}, ops: {} },
        },
      } satisfies OpenClawConfig,
      sessionId: "ops-session",
    });

    expect(result.agentId).toBe("ops");
    expect(result.sessionKey).toBe("main");
    expect(result.sessionEntry).toEqual(sharedStore.main);
    expect(result.storePath).toBe("/stores/shared.sqlite");
    expect(hoisted.listSessionEntriesMock.mock.calls.map(([scope]) => scope?.agentId)).toEqual([
      "research",
      "ops",
    ]);
  });

  it("uses the persisted fixed-store owner for direct session-id lookup", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["research", "ops"]);
    const sharedStore = {
      main: { sessionId: "ops-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });

    expect(
      resolveStoredSessionKeyForSessionId({
        cfg: {
          session: { store: "/stores/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { research: {}, ops: {} },
          },
        },
        sessionId: "ops-session",
      }),
    ).toMatchObject({
      agentId: "ops",
      sessionKey: "main",
      sessionEntry: sharedStore.main,
      storePath: "/stores/shared.sqlite",
    });
  });

  it("rejects an explicit agent that conflicts with an unscoped direct session-id match", () => {
    const sharedStore = {
      main: { sessionId: "ops-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { research: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveStoredSessionKeyForSessionId({
        cfg,
        sessionId: "ops-session",
        agentId: "research",
      }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("prefers the requested agent's scoped direct match over a newer foreign row", () => {
    const sharedStore = {
      "agent:ops:work": { sessionId: "shared-session", updatedAt: 20 },
      "agent:research:work": { sessionId: "shared-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });

    expect(
      resolveStoredSessionKeyForSessionId({
        cfg: {
          session: { store: "/stores/shared.sqlite" },
          agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
        },
        sessionId: "shared-session",
        agentId: "research",
      }),
    ).toMatchObject({
      agentId: "research",
      sessionKey: "agent:research:work",
      sessionEntry: sharedStore["agent:research:work"],
      storePath: "/stores/shared.sqlite",
    });
  });

  it("rejects a direct session-id lookup with only foreign scoped matches", () => {
    mockSessionStores({
      "/stores/shared.sqlite": {
        "agent:ops:work": { sessionId: "ops-session", updatedAt: 20 },
      },
    });

    expect(() =>
      resolveStoredSessionKeyForSessionId({
        cfg: {
          session: { store: "/stores/shared.sqlite" },
          agents: { ownership: "explicit", entries: { research: {}, ops: {} } },
        },
        sessionId: "ops-session",
        agentId: "research",
      }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("resolves a scoped direct session-id match despite a retired fixed-store owner", () => {
    const researchStore = {
      "agent:research:work": { sessionId: "research-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": researchStore });

    expect(
      resolveStoredSessionKeyForSessionId({
        cfg: {
          session: { store: "/stores/shared.sqlite" },
          agents: {
            ownership: "explicit",
            defaults: { sessionStore: { agentId: "ops" } },
            entries: { research: {} },
          },
        },
        sessionId: "research-session",
      }),
    ).toMatchObject({
      agentId: "research",
      sessionKey: "agent:research:work",
      sessionEntry: researchStore["agent:research:work"],
      storePath: "/stores/shared.sqlite",
    });
  });

  it("does not reassign a retired sole agent's unscoped row to its replacement", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["research"]);
    mockSessionStores({
      "/stores/shared.sqlite": {
        main: { sessionId: "retired-session", updatedAt: 10 },
      },
    });
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { research: {} },
      },
    } satisfies OpenClawConfig;

    expect(() => resolveSessionKeyForRequest({ cfg, sessionId: "retired-session" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
  });

  it("persists a legacy main fixed-store owner and fails closed after main is removed", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["research"]);
    const sharedStore = {
      main: { sessionId: "legacy-main-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });
    const migrated = migratePersistedImplicitMainRoster({
      session: { store: "/stores/shared.sqlite" },
      agents: { entries: { main: { default: true }, research: {} } },
    }).config as OpenClawConfig;
    expect(migrated.agents?.defaults?.sessionStore?.agentId).toBe("main");
    const afterMainRemoval = {
      ...migrated,
      agents: {
        ...migrated.agents,
        ownership: "explicit" as const,
        entries: { research: {} },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveSessionKeyForRequest({ cfg: afterMainRemoval, sessionId: "legacy-main-session" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("resolves an unscoped fixed-store row while its persisted owner is configured", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);
    const sharedStore = {
      main: { sessionId: "ops-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });

    const result = resolveSessionKeyForRequest({
      cfg: {
        session: { store: "/stores/shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {} },
        },
      } satisfies OpenClawConfig,
      sessionId: "ops-session",
    });

    expect(result.agentId).toBe("ops");
    expect(result.sessionKey).toBe("main");
  });

  it("rejects an explicit agent that conflicts with an unscoped fixed-store owner", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "research"]);
    const cfg = {
      session: { scope: "global", store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveSessionKeyForRequest({ cfg, agentId: "research", sessionKey: "global" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
    expect(hoisted.listSessionEntriesMock).not.toHaveBeenCalled();

    mockSessionStores({ "/stores/shared.sqlite": {} });
    expect(
      resolveSessionKeyForRequest({ cfg, agentId: "ops", sessionKey: "global" }),
    ).toMatchObject({
      agentId: "ops",
      sessionKey: "global",
      storePath: "/stores/shared.sqlite",
    });
  });

  it("fails closed for an ownerless unscoped row during a cross-agent shared-store scan", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["research", "ops"]);
    const sharedStore = {
      main: { sessionId: "ownerless-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });

    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        entries: { research: {}, ops: {} },
      },
    } satisfies OpenClawConfig;

    expect(() => resolveSessionKeyForRequest({ cfg, sessionId: "ownerless-session" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
    expect(hoisted.listSessionEntriesMock.mock.calls.map(([scope]) => scope?.agentId)).toEqual([
      "research",
      "ops",
    ]);
  });

  it("does not assign an unowned bare key from a session-id scan anchor", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "research"]);
    mockSessionStores({ "/stores/ops.json": {}, "/stores/research.json": {} });
    const cfg = {
      session: { store: "/stores/{agentId}.json" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(() =>
      resolveSessionKeyForRequest({ cfg, sessionKey: "global", sessionId: "missing-session" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("resolves an unowned bare key's session id to the matching agent store", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "research"]);
    const researchStore = {
      "agent:research:work": { sessionId: "research-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      "/stores/ops.json": {},
      "/stores/research.json": researchStore,
    });
    const cfg = {
      session: { store: "/stores/{agentId}.json" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveSessionKeyForRequest({
        cfg,
        sessionKey: "global",
        sessionId: "research-session",
      }),
    ).toMatchObject({
      agentId: "research",
      sessionKey: "agent:research:work",
      sessionEntry: researchStore["agent:research:work"],
      storePath: "/stores/research.json",
    });
  });

  it("allows an agent-constrained lookup to own an unscoped shared-store row", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["research", "ops"]);
    const sharedStore = {
      main: { sessionId: "ops-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });

    const result = resolveSessionKeyForRequest({
      cfg: {
        session: { store: "/stores/shared.sqlite" },
        agents: {
          ownership: "explicit",
          entries: { research: {}, ops: {} },
        },
      } satisfies OpenClawConfig,
      sessionId: "ops-session",
      agentId: "ops",
    });

    expect(result.agentId).toBe("ops");
    expect(result.sessionKey).toBe("main");
    expect(result.sessionEntry).toEqual(sharedStore.main);
    expect(result.storePath).toBe("/stores/shared.sqlite");
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledTimes(1);
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ops" }),
    );
  });

  it("rejects an agent-constrained session id owned by another agent", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "research"]);
    const sharedStore = {
      "agent:research:work": { sessionId: "duplicate-session", updatedAt: 20 },
      "agent:ops:work": { sessionId: "duplicate-session", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({ "/stores/shared.sqlite": sharedStore });
    const cfg = {
      session: { store: "/stores/shared.sqlite" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(
      resolveSessionKeyForRequest({ cfg, agentId: "ops", sessionId: "duplicate-session" }),
    ).toMatchObject({ agentId: "ops", sessionKey: "agent:ops:work" });
    mockSessionStores({
      "/stores/shared.sqlite": {
        "agent:research:work": sharedStore["agent:research:work"],
      },
    });
    expect(() =>
      resolveSessionKeyForRequest({ cfg, agentId: "ops", sessionId: "duplicate-session" }),
    ).toThrowError(expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }));
  });

  it("creates a missing session-id target under the retained owner", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "research"]);
    mockSessionStores({});
    const cfg = retainLegacyDefaultAgentId(
      {
        session: { store: "/stores/{agentId}.json" },
        agents: {
          ownership: "explicit",
          entries: { ops: {}, research: {} },
        },
      },
      "ops",
    );

    const result = resolveSessionKeyForRequest({ cfg, sessionId: "new-session" });

    expect(result.agentId).toBe("ops");
    expect(result.sessionKey).toBe("agent:ops:explicit:new-session");
  });

  it("fails closed when creating a session-id target in an ownerless fleet", () => {
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "research"]);
    mockSessionStores({});
    const cfg = {
      session: { store: "/stores/{agentId}.json" },
      agents: {
        ownership: "explicit",
        entries: { ops: {}, research: {} },
      },
    } satisfies OpenClawConfig;

    expect(() => resolveSessionKeyForRequest({ cfg, sessionId: "new-session" })).toThrowError(
      expect.objectContaining({ code: "AGENT_SELECTION_REQUIRED" }),
    );
  });

  it("detaches the selected session entry from borrowed store rows", () => {
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:acp:sid": {
        sessionId: "sid",
        updatedAt: 20,
        skillsSnapshot: { prompt: "selected prompt", skills: [] },
      },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      "/stores/main.json": mainStore,
      "/stores/other.json": otherStore,
    });

    const result = resolveSessionKeyForRequestCore({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } satisfies OpenClawConfig,
      sessionId: "sid",
    });

    expect(result.sessionKey).toBe("agent:other:acp:sid");
    expect(result.sessionEntry).toEqual(otherStore["agent:other:acp:sid"]);
    if (!result.sessionEntry?.skillsSnapshot) {
      throw new Error("expected the selected session's skills");
    }
    result.sessionEntry.skillsSnapshot.prompt = "caller-owned edit";
    expect(otherStore["agent:other:acp:sid"].skillsSnapshot.prompt).toBe("selected prompt");
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/stores/main.json",
        clone: false,
      }),
    );
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/stores/other.json",
        clone: false,
      }),
    );
  });
});
