import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";

const hoisted = vi.hoisted(() => ({
  loadConfigMock: vi.fn<() => OpenClawConfig>(),
  loadCombinedSessionStoreForGatewayMock: vi.fn(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => hoisted.loadConfigMock(),
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => hoisted.loadConfigMock(),
}));

vi.mock("./session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./session-utils.js")>("./session-utils.js");
  return {
    ...actual,
    loadCombinedSessionStoreForGateway: (cfg: OpenClawConfig) =>
      hoisted.loadCombinedSessionStoreForGatewayMock(cfg),
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
        "agent:retired:acp:run-1": { sessionId: "run-1", updatedAt: 123 },
      },
    });

    expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    expect(resolveSessionKeyForRun("run-1")).toBe("acp:run-1");
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledTimes(1);
    expect(hoisted.loadCombinedSessionStoreForGatewayMock).toHaveBeenCalledWith(cfg);
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
        "agent:main:other": { sessionId: "run-dup", updatedAt: 999 },
        "agent:retired:acp:run-dup": { sessionId: "run-dup", updatedAt: 100 },
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
        "agent:retired:second": { sessionId: "run-ambiguous", updatedAt: 100 },
      },
    });

    expect(resolveSessionKeyForRun("run-ambiguous")).toBeUndefined();
  });
});
