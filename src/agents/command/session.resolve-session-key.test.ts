// Covers cross-store session-key resolution for multi-agent session stores.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  listSessionEntriesMock: vi.fn<
    (scope?: { storePath?: string; clone?: boolean }) => Array<{
      entry: SessionEntry;
      sessionKey: string;
    }>
  >(),
  listAgentIdsMock: vi.fn<() => string[]>(),
  compatReadMock: vi.fn(),
  defaultAgentId: "main",
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntries: (scope?: { storePath?: string; clone?: boolean }) =>
    hoisted.listSessionEntriesMock(scope),
}));

vi.mock("../../config/sessions/legacy-main-session-key-migration.js", () => ({
  readUnresolvedLegacyMainSessionCompat: (...args: unknown[]) => hoisted.compatReadMock(...args),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: (_store?: string, params?: { agentId?: string }) =>
    _store?.includes("{agentId}")
      ? `/stores/${params?.agentId ?? "main"}.json`
      : (_store ?? `/stores/${params?.agentId ?? "main"}.json`),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentIdFromSessionKey: (key?: string) => key?.split(":")[1] ?? hoisted.defaultAgentId,
  resolveExplicitAgentSessionKey: () => undefined,
}));

vi.mock("../agent-scope.js", () => ({
  listAgentIds: () => hoisted.listAgentIdsMock(),
  resolveDefaultAgentId: () => hoisted.defaultAgentId,
}));

const { resolveSessionKeyForRequest, resolveStoredSessionKeyForSessionId } =
  await import("./session.js");

function mockSessionStores(storesByPath: Record<string, Record<string, SessionEntry>>): void {
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
  const result = resolveSessionKeyForRequest({
    cfg: {
      session: {
        store: "/stores/{agentId}.json",
      },
    } satisfies OpenClawConfig,
    sessionId: params.sessionId,
  });

  expect(result.sessionKey).toBe(params.sessionKey);
  expect(result.sessionStore).toEqual(params.sessionStore);
  expect(result.storePath).toBe(params.storePath);
}

describe("resolveSessionKeyForRequest", () => {
  beforeEach(() => {
    hoisted.listSessionEntriesMock.mockReset();
    hoisted.listAgentIdsMock.mockReset();
    hoisted.compatReadMock.mockReset();
    hoisted.defaultAgentId = "main";
    hoisted.listAgentIdsMock.mockReturnValue(["main", "other"]);
  });

  it("does not infer ownership for a historical main key at runtime", () => {
    hoisted.defaultAgentId = "ops";
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);
    const legacyEntry = { sessionId: "legacy-main", updatedAt: 10 } satisfies SessionEntry;
    mockSessionStores({
      "/stores/shared.json": { "agent:main:main": legacyEntry },
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "ops", default: true }] },
        session: { store: "/stores/shared.json" },
      },
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:ops:main");
    expect(result.sessionStore["agent:ops:main"]).toBeUndefined();
  });

  it("does not project a cross-store unresolved entry without its transcript", () => {
    hoisted.defaultAgentId = "ops";
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);
    hoisted.compatReadMock.mockReturnValue({
      canonicalKey: "agent:ops:main",
      defaultAgentId: "ops",
      entry: { sessionId: "legacy-main", updatedAt: 10 },
      legacyKey: "agent:main:main",
      storePath: "/stores/main.json",
    });
    mockSessionStores({ "/stores/shared.json": {} });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "ops", default: true }] },
        session: { store: "/stores/shared.json" },
      },
      to: "+15551234567",
    });

    expect(hoisted.compatReadMock).toHaveBeenCalledWith({
      canonicalKey: "agent:ops:main",
      defaultAgentId: "ops",
    });
    expect(result.sessionStore["agent:ops:main"]).toBeUndefined();
  });

  it("reads an exact same-store key only while its migration is recorded unresolved", () => {
    hoisted.defaultAgentId = "ops";
    hoisted.listAgentIdsMock.mockReturnValue(["ops"]);
    hoisted.compatReadMock.mockReturnValue({
      canonicalKey: "agent:ops:main",
      defaultAgentId: "ops",
      entry: { sessionId: "legacy-main", updatedAt: 10 },
      legacyKey: "agent:main:main",
      storePath: "/stores/shared.json",
    });
    mockSessionStores({ "/stores/shared.json": {} });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "ops", default: true }] },
        session: { store: "/stores/shared.json" },
      },
      to: "+15551234567",
    });

    expect(result.sessionStore["agent:ops:main"]).toMatchObject({ sessionId: "legacy-main" });
  });

  it("does not borrow the explicit main agent's session for another default", () => {
    hoisted.defaultAgentId = "ops";
    hoisted.listAgentIdsMock.mockReturnValue(["ops", "main"]);
    mockSessionStores({
      "/stores/shared.json": {
        "agent:main:main": { sessionId: "explicit-main", updatedAt: 10 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: {
          list: [{ id: "ops", default: true }, { id: "main" }],
        },
        session: { store: "/stores/shared.json" },
      },
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:ops:main");
    expect(result.sessionStore["agent:ops:main"]).toBeUndefined();
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
    expect(result.sessionStore).toEqual(embeddedAgentStore);
    expect(result.storePath).toBe("/stores/embedded-agent.json");
    expect(hoisted.listSessionEntriesMock).toHaveBeenCalledTimes(1);
  });

  it("borrows session stores when requested", () => {
    // clone=false is used by callers that intend to mutate the selected store,
    // so the resolver must pass that option through every candidate load.
    const mainStore = {
      "agent:main:main": { sessionId: "sid", updatedAt: 10 },
    } satisfies Record<string, SessionEntry>;
    const otherStore = {
      "agent:other:acp:sid": { sessionId: "sid", updatedAt: 20 },
    } satisfies Record<string, SessionEntry>;
    mockSessionStores({
      "/stores/main.json": mainStore,
      "/stores/other.json": otherStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        session: {
          store: "/stores/{agentId}.json",
        },
      } satisfies OpenClawConfig,
      sessionId: "sid",
      clone: false,
    });

    expect(result.sessionKey).toBe("agent:other:acp:sid");
    expect(result.sessionStore).toEqual(otherStore);
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
