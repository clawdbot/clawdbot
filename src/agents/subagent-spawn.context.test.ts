import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

type SessionStore = Record<string, Record<string, unknown>>;
type GatewayRequest = { method?: string; params?: Record<string, unknown> };

describe("sessions_spawn context modes", () => {
  const storePath = "/tmp/subagent-context-session-store.json";
  const callGatewayMock = vi.fn();
  const updateSessionStoreMock = vi.fn();
  const forkSessionFromParentMock = vi.fn();
  const resolveContextEngineMock = vi.fn();
  let spawnSubagentDirect: Awaited<
    ReturnType<typeof loadSubagentSpawnModuleForTest>
  >["spawnSubagentDirect"];

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock,
      forkSessionFromParentMock,
      resolveContextEngineMock,
      sessionStorePath: storePath,
    }));
  });

  beforeEach(() => {
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    forkSessionFromParentMock.mockReset();
    resolveContextEngineMock.mockReset();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    resolveContextEngineMock.mockResolvedValue({});
  });

  function usePersistentStoreMock(store: SessionStore) {
    updateSessionStoreMock.mockImplementation(async (_storePath: unknown, mutator: unknown) => {
      if (typeof mutator !== "function") {
        throw new Error("missing session store mutator");
      }
      return await mutator(store);
    });
  }

  it("forks the requester transcript when context=fork", async () => {
    const store: SessionStore = {
      main: {
        sessionId: "parent-session-id",
        sessionFile: "/tmp/parent-session.jsonl",
        updatedAt: 1,
        totalTokens: 1200,
      },
    };
    usePersistentStoreMock(store);
    forkSessionFromParentMock.mockImplementation(async () => ({
      sessionId: "forked-session-id",
      sessionFile: "/tmp/forked-session.jsonl",
    }));
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect(
      { task: "inspect the current thread", context: "fork" },
      { agentSessionKey: "main" },
    );

    expect(result).toMatchObject({ status: "accepted", runId: "run-1" });
    expect(forkSessionFromParentMock).toHaveBeenCalledWith({
      parentEntry: store.main,
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    expect(store[result.childSessionKey ?? ""]).toMatchObject({
      sessionId: "forked-session-id",
      sessionFile: "/tmp/forked-session.jsonl",
      forkedFromParent: true,
    });
    expect(prepareSubagentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "main",
        childSessionKey: result.childSessionKey,
        contextMode: "fork",
        parentSessionId: "parent-session-id",
        childSessionId: "forked-session-id",
        childSessionFile: "/tmp/forked-session.jsonl",
      }),
    );
  });

  it("keeps the default spawn context isolated", async () => {
    const store: SessionStore = {
      main: { sessionId: "parent-session-id", updatedAt: 1 },
    };
    usePersistentStoreMock(store);
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect({ task: "clean worker" }, { agentSessionKey: "main" });

    expect(result.status).toBe("accepted");
    expect(forkSessionFromParentMock).not.toHaveBeenCalled();
    expect(prepareSubagentSpawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionKey: "main",
        childSessionKey: result.childSessionKey,
        contextMode: "isolated",
      }),
    );
  });

  it("rolls back context-engine preparation when agent start fails", async () => {
    const store: SessionStore = {
      main: { sessionId: "parent-session-id", updatedAt: 1 },
    };
    usePersistentStoreMock(store);
    const rollback = vi.fn(async () => undefined);
    callGatewayMock.mockImplementation(async (requestUnknown: unknown) => {
      const request = requestUnknown as GatewayRequest;
      if (request.method === "agent") {
        throw new Error("agent start failed");
      }
      return { ok: true };
    });
    resolveContextEngineMock.mockResolvedValue({
      prepareSubagentSpawn: vi.fn(async () => ({ rollback })),
    });

    const result = await spawnSubagentDirect({ task: "clean worker" }, { agentSessionKey: "main" });

    expect(result).toMatchObject({ status: "error", error: "agent start failed" });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls.map((call) => (call[0] as GatewayRequest).method)).toContain(
      "sessions.delete",
    );
  });
});
