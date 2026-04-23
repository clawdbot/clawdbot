import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadSubagentSpawnModuleForTest,
  setupAcceptedSubagentGatewayMock,
} from "./subagent-spawn.test-helpers.js";

type SessionStore = Record<string, Record<string, unknown>>;
type GatewayRequest = { method?: string; params?: Record<string, unknown> };

function createPersistentStoreMock(store: SessionStore) {
  return vi.fn(async (_storePath: unknown, mutator: unknown) => {
    if (typeof mutator !== "function") {
      throw new Error("missing session store mutator");
    }
    return await mutator(store);
  });
}

describe("sessions_spawn context modes", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("forks the requester transcript when context=fork", async () => {
    const storePath = "/tmp/subagent-context-session-store.json";
    const store: SessionStore = {
      main: {
        sessionId: "parent-session-id",
        sessionFile: "/tmp/parent-session.jsonl",
        updatedAt: 1,
        totalTokens: 1200,
      },
    };
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const forkSessionFromParentMock = vi.fn(async () => ({
      sessionId: "forked-session-id",
      sessionFile: "/tmp/forked-session.jsonl",
    }));
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock: createPersistentStoreMock(store),
      forkSessionFromParentMock,
      resolveContextEngineMock: vi.fn(async () => ({ prepareSubagentSpawn })),
      sessionStorePath: storePath,
    });

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
    const callGatewayMock = vi.fn();
    setupAcceptedSubagentGatewayMock(callGatewayMock);
    const forkSessionFromParentMock = vi.fn();
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock: createPersistentStoreMock(store),
      forkSessionFromParentMock,
      resolveContextEngineMock: vi.fn(async () => ({ prepareSubagentSpawn })),
    });

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
    const rollback = vi.fn(async () => undefined);
    const callGatewayMock = vi.fn(async (requestUnknown: unknown) => {
      const request = requestUnknown as GatewayRequest;
      if (request.method === "agent") {
        throw new Error("agent start failed");
      }
      return { ok: true };
    });
    const { spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock: createPersistentStoreMock(store),
      resolveContextEngineMock: vi.fn(async () => ({
        prepareSubagentSpawn: vi.fn(async () => ({ rollback })),
      })),
    });

    const result = await spawnSubagentDirect({ task: "clean worker" }, { agentSessionKey: "main" });

    expect(result).toMatchObject({ status: "error", error: "agent start failed" });
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls.map((call) => (call[0] as GatewayRequest).method)).toContain(
      "sessions.delete",
    );
  });
});
