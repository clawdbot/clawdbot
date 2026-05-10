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
  const ensureContextEnginesInitializedMock = vi.fn();
  const resolveContextEngineMock = vi.fn();
  let spawnSubagentDirect: Awaited<
    ReturnType<typeof loadSubagentSpawnModuleForTest>
  >["spawnSubagentDirect"];

  beforeAll(async () => {
    ({ spawnSubagentDirect } = await loadSubagentSpawnModuleForTest({
      callGatewayMock,
      updateSessionStoreMock,
      forkSessionFromParentMock,
      ensureContextEnginesInitializedMock,
      resolveContextEngineMock,
      sessionStorePath: storePath,
    }));
  });

  beforeEach(() => {
    callGatewayMock.mockReset();
    updateSessionStoreMock.mockReset();
    forkSessionFromParentMock.mockReset();
    ensureContextEnginesInitializedMock.mockReset();
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

  function requireAcceptedResult(result: Awaited<ReturnType<typeof spawnSubagentDirect>>) {
    expect(result.status).toBe("accepted");
    if (result.status !== "accepted") {
      throw new Error(`expected accepted result, got ${result.status}`);
    }
    return result;
  }

  function requireStoreEntry(store: SessionStore, key: string): Record<string, unknown> {
    const entry = store[key];
    if (!entry) {
      throw new Error(`expected session store entry ${key}`);
    }
    return entry;
  }

  function requireChildSessionKey(result: Awaited<ReturnType<typeof spawnSubagentDirect>>): string {
    const key = result.childSessionKey;
    if (!key) {
      throw new Error("expected child session key");
    }
    return key;
  }

  function requireFirstMockArg(mock: ReturnType<typeof vi.fn>): Record<string, unknown> {
    const arg = mock.mock.calls.at(0)?.[0];
    if (!arg || typeof arg !== "object") {
      throw new Error("expected first mock argument object");
    }
    return arg as Record<string, unknown>;
  }

  function requireGatewayRequest(method: string): GatewayRequest {
    const request = callGatewayMock.mock.calls
      .map(([arg]) => arg as GatewayRequest)
      .find((candidate) => candidate.method === method);
    if (!request) {
      throw new Error(`expected gateway request ${method}`);
    }
    return request;
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

    const accepted = requireAcceptedResult(result);
    expect(accepted.runId).toBe("run-1");
    expect(forkSessionFromParentMock).toHaveBeenCalledWith({
      parentEntry: store.main,
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    const childSessionKey = requireChildSessionKey(accepted);
    const childEntry = requireStoreEntry(store, childSessionKey);
    expect(childEntry.sessionId).toBe("forked-session-id");
    expect(childEntry.sessionFile).toBe("/tmp/forked-session.jsonl");
    expect(childEntry.forkedFromParent).toBe(true);

    const prepareContext = requireFirstMockArg(prepareSubagentSpawn);
    expect(prepareContext.parentSessionKey).toBe("main");
    expect(prepareContext.childSessionKey).toBe(childSessionKey);
    expect(prepareContext.contextMode).toBe("fork");
    expect(prepareContext.parentSessionId).toBe("parent-session-id");
    expect(prepareContext.childSessionId).toBe("forked-session-id");
    expect(prepareContext.childSessionFile).toBe("/tmp/forked-session.jsonl");
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
    const prepareContext = requireFirstMockArg(prepareSubagentSpawn);
    expect(prepareContext.parentSessionKey).toBe("main");
    expect(prepareContext.childSessionKey).toBe(requireChildSessionKey(result));
    expect(prepareContext.contextMode).toBe("isolated");
  });

  it("falls back to isolated context when requested fork is too large", async () => {
    const store: SessionStore = {
      main: {
        sessionId: "parent-session-id",
        sessionFile: "/tmp/parent-session.jsonl",
        updatedAt: 1,
        totalTokens: 170_000,
      },
    };
    usePersistentStoreMock(store);
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockResolvedValue({ prepareSubagentSpawn });

    const result = await spawnSubagentDirect(
      { task: "inspect the current thread", context: "fork" },
      { agentSessionKey: "main" },
    );

    const accepted = requireAcceptedResult(result);
    expect(accepted.runId).toBe("run-1");
    expect(accepted.note).toContain("Parent context is too large to fork");
    expect(forkSessionFromParentMock).not.toHaveBeenCalled();
    const prepareContext = requireFirstMockArg(prepareSubagentSpawn);
    expect(prepareContext.parentSessionKey).toBe("main");
    expect(prepareContext.childSessionKey).toBe(requireChildSessionKey(accepted));
    expect(prepareContext.contextMode).toBe("isolated");
    expect(prepareContext.parentSessionId).toBe("parent-session-id");
  });

  it("forks by default for thread-bound subagent sessions", async () => {
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
      { task: "spin this into a thread", thread: true },
      {
        agentSessionKey: "main",
        agentChannel: "discord",
        agentAccountId: "default",
        agentTo: "channel:123",
      },
    );

    expect(result.status).toBe("error");
    expect(forkSessionFromParentMock).toHaveBeenCalledWith({
      parentEntry: store.main,
      agentId: "main",
      sessionsDir: path.dirname(storePath),
    });
    const cleanupRequest = requireGatewayRequest("sessions.delete");
    expect(cleanupRequest.params?.key).toBe(result.childSessionKey);
    expect(cleanupRequest.params?.deleteTranscript).toBe(true);
    expect(cleanupRequest.params?.emitLifecycleHooks).toBe(false);
    expect(prepareSubagentSpawn).not.toHaveBeenCalled();
  });

  it("initializes built-in context engines before resolving spawn preparation", async () => {
    let initialized = false;
    ensureContextEnginesInitializedMock.mockImplementation(() => {
      initialized = true;
    });
    const prepareSubagentSpawn = vi.fn(async () => undefined);
    resolveContextEngineMock.mockImplementation(async () => {
      if (!initialized) {
        throw new Error('Context engine "legacy" is not registered. Available engines: (none)');
      }
      return { prepareSubagentSpawn };
    });

    const result = await spawnSubagentDirect({ task: "clean worker" }, { agentSessionKey: "main" });

    expect(result.status).toBe("accepted");
    expect(ensureContextEnginesInitializedMock).toHaveBeenCalledTimes(1);
    expect(resolveContextEngineMock).toHaveBeenCalledTimes(1);
    expect(ensureContextEnginesInitializedMock.mock.invocationCallOrder[0]).toBeLessThan(
      resolveContextEngineMock.mock.invocationCallOrder[0],
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

    expect(result.status).toBe("error");
    expect(result.error).toBe("agent start failed");
    expect(rollback).toHaveBeenCalledTimes(1);
    expect(callGatewayMock.mock.calls.map((call) => (call[0] as GatewayRequest).method)).toContain(
      "sessions.delete",
    );
  });
});
