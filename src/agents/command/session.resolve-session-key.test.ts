import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const hoisted = vi.hoisted(() => ({
  loadSessionStoreMock: vi.fn<(storePath: string) => Record<string, SessionEntry>>(),
  listAgentIdsMock: vi.fn<() => string[]>(),
}));

vi.mock("../../config/sessions/store-load.js", () => ({
  loadSessionStore: (storePath: string) => hoisted.loadSessionStoreMock(storePath),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: (_store?: string, params?: { agentId?: string }) =>
    `/stores/${params?.agentId ?? "main"}.json`,
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  resolveAgentIdFromSessionKey: () => "main",
  resolveExplicitAgentSessionKey: () => undefined,
}));

vi.mock("../agent-scope.js", () => ({
  listAgentIds: () => hoisted.listAgentIdsMock(),
  resolveDefaultAgentId: () => "main",
}));

const { resolveSessionKeyForRequest, resolveStoredSessionKeyForSessionId } =
  await import("./session.js");

function mockSessionStores(storesByPath: Record<string, Record<string, SessionEntry>>): void {
  hoisted.loadSessionStoreMock.mockImplementation((storePath) => storesByPath[storePath] ?? {});
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
  expect(result.sessionStore).toBe(params.sessionStore);
  expect(result.storePath).toBe(params.storePath);
}

describe("resolveSessionKeyForRequest", () => {
  beforeEach(() => {
    hoisted.loadSessionStoreMock.mockReset();
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
    hoisted.loadSessionStoreMock.mockImplementation((storePath) => {
      if (storePath === "/stores/embedded-agent.json") {
        return embeddedAgentStore;
      }
      return {};
    });

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
    expect(result.sessionStore).toBe(embeddedAgentStore);
    expect(result.storePath).toBe("/stores/embedded-agent.json");
    expect(hoisted.loadSessionStoreMock).toHaveBeenCalledTimes(1);
  });
});
