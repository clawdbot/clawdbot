import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn<() => OpenClawConfig>(),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => hoisted.loadConfigMock(),
}));

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: (
      cfg: OpenClawConfig,
      opts?: { agentId?: string; configuredAgentsOnly?: boolean },
    ) => hoisted.loadCombinedSessionStoreForGatewayMock(cfg, opts),
  };
});

const { resolveSessionKeyForRun, resetResolvedSessionKeyForRunCacheForTest } =
  await import("./server-session-key.js");

describe("resolveSessionKeyForRun", () => {
  beforeEach(() => {
    hoisted.loadConfigMock.mockReset();
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReset();
    resetAgentRunContextForTest();
    resetResolvedSessionKeyForRunCacheForTest();
  });

  afterEach(() => {
    resetAgentRunContextForTest();
    resetResolvedSessionKeyForRunCacheForTest();
  });

  it("resolves run ids from the combined gateway store and caches the result", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "/custom/root/agents/{agentId}/sessions/sessions.json",
      },
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledTimes(1);
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("uses the requested agent scope for run lookups", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "/custom/root/agents/{agentId}/sessions/sessions.json",
      },
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1", { agentId: "retired" })).toBe("acp:run-1");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "retired",
    });
  });

  it("defaults run id lookups without explicit agent scope to the default agent", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "/custom/root/agents/{agentId}/sessions/sessions.json",
      },
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1")).toBeUndefined();
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("filters same-run matches by requested agent for shared stores", () => {
    const cfg: OpenClawConfig = {
      session: {
        store: "/custom/root/sessions/sessions.json",
      },
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "/custom/root/sessions/sessions.json",
      store: {
        "agent:work:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1", { agentId: "main" })).toBeUndefined();
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "main",
    });
  });

  it("allows literal global session keys for scoped lookups when session scope is global", () => {
    const cfg: OpenClawConfig = {
      session: {
        scope: "global",
      },
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        global: { sessionId: "run-global", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-global", { agentId: "work" })).toBe("global");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "work",
    });
  });

  it("does not overwrite active run context when a scoped lookup finds another agent store entry", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    registerAgentRunContext("run-1", { sessionKey: "agent:retired:acp:run-1" });
    hoisted.loadCombinedSessionStoreForGatewayMock.mockImplementation(
      (_cfg: OpenClawConfig, opts?: { agentId?: string }) => ({
        storePath: "(multiple)",
        store:
          opts?.agentId === "main"
            ? {
                "agent:main:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
              }
            : {},
      }),
    );

    expect(resolveSessionKeyForRun("run-1", { agentId: "main" })).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1", { agentId: "retired" })).toBe("acp:run-1");
  });

  it("keeps run lookup cache entries scoped by agent", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionStoreForGatewayMock.mockImplementation(
      (_cfg: OpenClawConfig, opts?: { agentId?: string }) => ({
        storePath: "(multiple)",
        store:
          opts?.agentId === "retired"
            ? {
                "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
              }
            : {},
      }),
    );

    expect(resolveSessionKeyForRun("run-1", { agentId: "retired" })).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1", { agentId: "main" })).toBeUndefined();
    expect(resolveSessionKeyForRun("run-1")).toBeUndefined();
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledTimes(2);
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenNthCalledWith(
      2,
      {},
      {
        agentId: "main",
      },
    );
  });

  it("uses active legacy run contexts for the main agent", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    registerAgentRunContext("run-live-main", { sessionKey: "main" });

    expect(resolveSessionKeyForRun("run-live-main")).toBe("main");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
  });

  it("uses active legacy run contexts for the configured default agent", () => {
    hoisted.loadConfigMock.mockReturnValue({
      agents: { list: [{ id: "work", default: true }] },
    });
    registerAgentRunContext("run-live-work", { sessionKey: "main" });

    expect(resolveSessionKeyForRun("run-live-work")).toBe("main");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
  });

  it("uses non-default active run contexts without an explicit agent scope", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    registerAgentRunContext("run-live-work", { sessionKey: "agent:work:main" });

    expect(resolveSessionKeyForRun("run-live-work")).toBe("agent:work:main");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).not.toHaveBeenCalled();
  });

  it("uses legacy store entries for the configured default agent", () => {
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "work", default: true }] },
    };
    hoisted.loadConfigMock.mockReturnValue(cfg);
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        main: { sessionId: "run-legacy-default", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-legacy-default")).toBe("main");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg, {
      agentId: "work",
    });
  });

  it("lets active run context override a cached miss", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {},
    });

    expect(resolveSessionKeyForRun("run-race")).toBeUndefined();
    registerAgentRunContext("run-race", { sessionKey: "agent:main:main" });

    expect(resolveSessionKeyForRun("run-race")).toBe("agent:main:main");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledTimes(1);
  });

  it("caches misses briefly before re-checking the combined store", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-12T15:00:00Z"));
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {},
    });

    expect(resolveSessionKeyForRun("missing-run")).toBeUndefined();
    expect(resolveSessionKeyForRun("missing-run")).toBeUndefined();
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_001);

    expect(resolveSessionKeyForRun("missing-run")).toBeUndefined();
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("prefers the structurally matching session key when duplicate session ids exist", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:acp:run-dup": { sessionId: "run-dup", updatedAt: 100 },
        "agent:main:other": { sessionId: "run-dup", updatedAt: 999 },
      },
    });

    expect(resolveSessionKeyForRun("run-dup")).toBe("acp:run-dup");
  });

  it("refuses ambiguous duplicate session ids without a clear best match", () => {
    hoisted.loadConfigMock.mockReturnValue({});
    hoisted.loadCombinedSessionStoreForGatewayMock.mockReturnValue({
      storePath: "(multiple)",
      store: {
        "agent:main:first": { sessionId: "run-ambiguous", updatedAt: 100 },
        "agent:main:second": { sessionId: "run-ambiguous", updatedAt: 100 },
      },
    });

    expect(resolveSessionKeyForRun("run-ambiguous")).toBeUndefined();
  });
});
