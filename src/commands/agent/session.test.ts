// Agent session helper tests cover explicit session resolution through config and session stores.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSessionKeyForRequest } from "./session.js";

const mocks = vi.hoisted(() => ({
  listSessionEntries: vi.fn(),
  resolveStorePath: vi.fn(),
  listAgentIds: vi.fn(),
  resolveExplicitAgentSessionKey: vi.fn(),
}));

vi.mock("../../config/sessions/main-session.js", async () => {
  const actual = await vi.importActual<typeof import("../../config/sessions/main-session.js")>(
    "../../config/sessions/main-session.js",
  );
  return {
    ...actual,
    resolveExplicitAgentSessionKey: mocks.resolveExplicitAgentSessionKey,
  };
});

vi.mock("../../config/sessions/session-accessor.js", () => ({
  listSessionEntries: mocks.listSessionEntries,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: mocks.resolveStorePath,
}));

vi.mock("../../agents/agent-scope.js", async () => {
  const { normalizeAgentId } = await vi.importActual<typeof import("../../routing/session-key.js")>(
    "../../routing/session-key.js",
  );
  return {
    listAgentIds: mocks.listAgentIds,
    resolveDefaultAgentId: (cfg: OpenClawConfig) => {
      const agents = cfg.agents?.list ?? [];
      return normalizeAgentId(agents.find((agent) => agent?.default)?.id ?? agents[0]?.id);
    },
  };
});

describe("resolveSessionKeyForRequest", () => {
  const MAIN_STORE_PATH = "/tmp/main-store.json";
  const MYBOT_STORE_PATH = "/tmp/mybot-store.json";
  const SHARED_STORE_PATH = "/tmp/shared-store.json";
  type SessionStoreEntry = { sessionId: string; updatedAt: number };
  type SessionStoreMap = Record<string, SessionStoreEntry>;

  const setupMainAndMybotStorePaths = () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) => {
        if (opts?.agentId === "mybot") {
          return MYBOT_STORE_PATH;
        }
        return MAIN_STORE_PATH;
      },
    );
  };

  const mockStoresByPath = (stores: Partial<Record<string, SessionStoreMap>>) => {
    mocks.listSessionEntries.mockImplementation((scope?: { storePath?: string }) =>
      Object.entries(stores[scope?.storePath ?? ""] ?? {}).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      })),
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAgentIds.mockReturnValue(["main"]);
    mocks.resolveExplicitAgentSessionKey.mockReturnValue(undefined);
  });

  const baseCfg: OpenClawConfig = {};

  it("returns sessionKey when --to resolves a session key via context", () => {
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "sess-1", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("uses an agent-scoped --to value as the requested session key", () => {
    const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        [sessionKey]: { sessionId: "wechat-session", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: sessionKey,
    });

    expect(result.sessionKey).toBe(sessionKey);
  });

  it("uses the configured default agent store for new --to sessions", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {},
      [MYBOT_STORE_PATH]: {},
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("migrates legacy main-store main-key sessions for plain --to default-agent requests", () => {
    setupMainAndMybotStorePaths();
    const mainStore = {
      "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
    };
    const mybotStore = {};
    mockStoresByPath({
      [MAIN_STORE_PATH]: mainStore,
      [MYBOT_STORE_PATH]: mybotStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionStore).toEqual({
      ...mybotStore,
      "agent:mybot:main": mainStore["agent:main:main"],
    });
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBe("legacy-session-id");
  });

  it("migrates legacy main-key sessions for plain --to default-agent requests with a literal shared store", () => {
    const sharedStore = {
      "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
    };
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(SHARED_STORE_PATH);
    mockStoresByPath({ [SHARED_STORE_PATH]: sharedStore });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
        session: { store: SHARED_STORE_PATH },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionStore).toEqual({
      ...sharedStore,
      "agent:mybot:main": sharedStore["agent:main:main"],
    });
    expect(result.storePath).toBe(SHARED_STORE_PATH);
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBe("legacy-session-id");
    expect(mocks.listSessionEntries).toHaveBeenCalledTimes(1);
    expect(mocks.listSessionEntries).toHaveBeenCalledWith({
      agentId: "mybot",
      storePath: SHARED_STORE_PATH,
    });
  });

  it("prefers the configured default-agent session over legacy main-store rows", () => {
    setupMainAndMybotStorePaths();
    const mybotStore = {
      "agent:mybot:main": { sessionId: "current-session-id", updatedAt: 2 },
    };
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "legacy-session-id", updatedAt: 1 },
      },
      [MYBOT_STORE_PATH]: mybotStore,
    });

    const result = resolveSessionKeyForRequest({
      cfg: {
        agents: { list: [{ id: "mybot", default: true }] },
      } satisfies OpenClawConfig,
      to: "+15551234567",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.sessionStore).toEqual(mybotStore);
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("finds session by sessionId via reverse lookup in primary store", () => {
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("finds session by sessionId in non-primary agent store", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("does not let --agent short-circuit --session-id back to the agent main session", () => {
    setupMainAndMybotStorePaths();
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:mybot:main");
    mockStoresByPath({
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "other-session-id", updatedAt: 0 },
        "agent:mybot:whatsapp:direct:+15551234567": {
          sessionId: "target-session-id",
          updatedAt: 1,
        },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "target-session-id",
    });

    expect(result.sessionKey).toBe("agent:mybot:whatsapp:direct:+15551234567");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("treats whitespace --session-id as absent when resolving --agent", () => {
    setupMainAndMybotStorePaths();
    mocks.resolveExplicitAgentSessionKey.mockReturnValue("agent:mybot:main");
    mockStoresByPath({
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "existing-session-id", updatedAt: 1 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "   ",
    });

    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("does not search other agent stores when --agent scopes --session-id", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:whatsapp:direct:+15550000000": {
          sessionId: "target-session-id",
          updatedAt: 10,
        },
      },
      [MYBOT_STORE_PATH]: {},
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      agentId: "mybot",
      sessionId: "target-session-id",
    });

    expect(result.sessionKey).toBe("agent:mybot:explicit:target-session-id");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
    expect(mocks.listSessionEntries).toHaveBeenCalledTimes(1);
    expect(mocks.listSessionEntries).toHaveBeenCalledWith({
      agentId: "mybot",
      storePath: MYBOT_STORE_PATH,
    });
  });

  it("returns correct sessionStore when session found in non-primary agent store", () => {
    const mybotStore = {
      "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
    };
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MYBOT_STORE_PATH]: { ...mybotStore },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "target-session-id",
    });
    expect(result.sessionStore["agent:mybot:main"]?.sessionId).toBe("target-session-id");
  });

  it("returns a deterministic explicit sessionKey when sessionId not found in any store", () => {
    setupMainAndMybotStorePaths();
    mocks.listSessionEntries.mockReturnValue([]);

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });
    expect(result.sessionKey).toBe("agent:main:explicit:nonexistent-id");
  });

  it("does not search other stores when explicitSessionKey is set", () => {
    mocks.listAgentIds.mockReturnValue(["main", "mybot"]);
    mocks.resolveStorePath.mockReturnValue(MAIN_STORE_PATH);
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "other-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionKey: "agent:main:main",
      sessionId: "target-session-id",
    });
    // explicitSessionKey is set, so sessionKey comes from it, not from sessionId lookup
    expect(result.sessionKey).toBe("agent:main:main");
  });

  it("searches other stores when --to derives a key that does not match --session-id", () => {
    setupMainAndMybotStorePaths();
    mockStoresByPath({
      [MAIN_STORE_PATH]: {
        "agent:main:main": { sessionId: "other-session-id", updatedAt: 0 },
      },
      [MYBOT_STORE_PATH]: {
        "agent:mybot:main": { sessionId: "target-session-id", updatedAt: 0 },
      },
    });

    const result = resolveSessionKeyForRequest({
      cfg: baseCfg,
      to: "+15551234567",
      sessionId: "target-session-id",
    });
    // --to derives agent:main:main, but its sessionId doesn't match target-session-id,
    // so the cross-store search finds it in the mybot store
    expect(result.sessionKey).toBe("agent:mybot:main");
    expect(result.storePath).toBe(MYBOT_STORE_PATH);
  });

  it("skips already-searched primary store when iterating agents", () => {
    setupMainAndMybotStorePaths();
    mocks.listSessionEntries.mockReturnValue([]);

    resolveSessionKeyForRequest({
      cfg: baseCfg,
      sessionId: "nonexistent-id",
    });

    // listSessionEntries should be called twice: once for main, once for mybot
    // (not twice for main)
    const storePaths = mocks.listSessionEntries.mock.calls.map((call) =>
      String(call[0]?.storePath),
    );
    expect(storePaths).toHaveLength(2);
    expect(storePaths).toContain(MAIN_STORE_PATH);
    expect(storePaths).toContain(MYBOT_STORE_PATH);
  });
});
