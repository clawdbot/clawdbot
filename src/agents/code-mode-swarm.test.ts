import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodeModeApiVirtualFiles,
  registerCodeModeNamespaceForPlugin,
} from "./code-mode-namespaces.js";
import { clearCodeModeNamespacesForTest } from "./code-mode-namespaces.test-support.js";
import { resolveCodeModeConfig } from "./code-mode.js";
import { testing } from "./code-mode.test-support.js";
import { stableStringify } from "./stable-stringify.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "./swarm-code-mode.js";

const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

function workerExec(source: string, swarmEnabled: boolean) {
  return testing.runCodeModeWorker(
    {
      kind: "exec",
      source,
      config,
      catalog: [],
      apiFiles: [],
      namespaces: [],
      swarmEnabled,
    },
    10_000,
  );
}

function workerResume(
  waiting: Extract<Awaited<ReturnType<typeof workerExec>>, { status: "waiting" }>,
  settledRequests: Array<{ id: string; ok: true; value: unknown }>,
) {
  return testing.runCodeModeWorker(
    {
      kind: "resume",
      snapshotBytes: waiting.snapshotBytes,
      config,
      settledRequests,
    },
    10_000,
  );
}

function expectWaiting(
  result: Awaited<ReturnType<typeof workerExec>>,
): asserts result is Extract<typeof result, { status: "waiting" }> {
  expect(result.status).toBe("waiting");
  if (result.status !== "waiting") {
    throw new Error("expected waiting worker result");
  }
}

function swarmContext() {
  const runtimeConfig = {
    tools: {
      codeMode: true,
      swarm: { enabled: true },
    },
  };
  return {
    config: runtimeConfig,
    runtimeConfig,
    sessionKey: "agent:main:main",
    sessionId: "session-swarm",
    runId: "run-swarm",
  };
}

afterEach(() => {
  testing.activeRuns.clear();
  testing.setSwarmDepsForTest();
  clearCodeModeNamespacesForTest();
});

describe("Code Mode swarm guest", () => {
  it("gates swarm globals in the worker", async () => {
    const result = await workerExec(
      "return [typeof agents, typeof phase, typeof log, (await API.list()).files.length];",
      false,
    );

    expect(result).toMatchObject({
      status: "completed",
      value: ["undefined", "undefined", "undefined", 0],
    });
  });

  it("maps agents.run schema options through spawn and returns structured completion", async () => {
    const first = await workerExec(
      `return await agents.run("Research", {
        label: "facts",
        model: "openai/gpt-5",
        thinking: "high",
        fastMode: "auto",
        agentId: "researcher",
        phase: "Research phase",
        schema: { type: "object", properties: { answer: { type: "string" } } }
      });`,
      true,
    );
    expectWaiting(first);
    expect(first.pendingRequests).toEqual([
      {
        id: "bridge:swarmNote:1",
        method: "swarmNote",
        args: [{ kind: "phase", text: "Research phase" }],
      },
      expect.objectContaining({
        id: "bridge:agentSpawn:1",
        method: "agentSpawn",
        args: [
          "Research",
          expect.objectContaining({
            label: "facts",
            model: "openai/gpt-5",
            thinking: "high",
            fastMode: "auto",
            agentId: "researcher",
            schema: expect.objectContaining({ type: "object" }),
          }),
        ],
      }),
    ]);

    const second = await workerResume(first, [
      { id: "bridge:swarmNote:1", ok: true, value: { ok: true } },
      { id: "bridge:agentSpawn:1", ok: true, value: { runId: "collector-1" } },
    ]);
    expectWaiting(second);
    expect(second.pendingRequests).toEqual([
      {
        id: "bridge:agentWait:1",
        method: "agentWait",
        args: ["collector-1"],
      },
    ]);

    const completed = await workerResume(second, [
      {
        id: second.pendingRequests[0]!.id,
        ok: true,
        value: {
          runId: "collector-1",
          status: "done",
          result: '{"answer":"42"}',
          structured: { answer: "42" },
        },
      },
    ]);
    expect(completed).toMatchObject({ status: "completed", value: { answer: "42" } });
  });

  it("returns text and raises a typed guest error for failed collectors", async () => {
    const first = await workerExec('return await agents.run("Research");', true);
    expectWaiting(first);
    const second = await workerResume(first, [
      { id: first.pendingRequests[0]!.id, ok: true, value: { runId: "collector-2" } },
    ]);
    expectWaiting(second);
    const completed = await workerResume(second, [
      {
        id: second.pendingRequests[0]!.id,
        ok: true,
        value: { runId: "collector-2", status: "done", result: "plain text" },
      },
    ]);
    expect(completed).toMatchObject({ status: "completed", value: "plain text" });

    const failedFirst = await workerExec('return await agents.run("Fail");', true);
    expectWaiting(failedFirst);
    const failedSecond = await workerResume(failedFirst, [
      { id: failedFirst.pendingRequests[0]!.id, ok: true, value: { runId: "collector-3" } },
    ]);
    expectWaiting(failedSecond);
    const failed = await workerResume(failedSecond, [
      {
        id: failedSecond.pendingRequests[0]!.id,
        ok: true,
        value: { runId: "collector-3", status: "timeout", result: "deadline exceeded" },
      },
    ]);
    expect(failed).toMatchObject({ status: "failed", code: "internal_error" });
    if (failed.status === "failed") {
      expect(failed.error).toContain(
        "SwarmAgentError: Swarm agent collector-3 timeout: deadline exceeded",
      );
    }
  });

  it("sends phase and log as fire-and-forget swarm notes", async () => {
    const first = await workerExec('phase("Plan"); log("Working"); return "ok";', true);
    expectWaiting(first);
    expect(first.pendingRequests.map(({ method, args }) => ({ method, args }))).toEqual([
      { method: "swarmNote", args: [{ kind: "phase", text: "Plan" }] },
      { method: "swarmNote", args: [{ kind: "log", text: "Working" }] },
    ]);
    const completed = await workerResume(
      first,
      first.pendingRequests.map((request) => ({ id: request.id, ok: true, value: { ok: true } })),
    );
    expect(completed).toMatchObject({ status: "completed", value: "ok" });
  });

  it("documents the typed swarm API and orchestration idioms", () => {
    const files = createCodeModeApiVirtualFiles([]);

    expect(files.map((file) => file.path)).toEqual(["agents.d.ts"]);
    expect(files[0]?.content).toContain("Promise.all");
    expect(files[0]?.content).toContain("while (!ready)");
    expect(files[0]?.content).toContain("schema: AgentJsonSchema");
  });

  it.each(["agents", "phase", "log"])("reserves the %s global", (globalName) => {
    expect(() =>
      registerCodeModeNamespaceForPlugin("test", {
        id: `test-${globalName}`,
        globalName,
        requiredToolNames: ["noop"],
        createScope: () => ({}),
      }),
    ).toThrow(`globalName "${globalName}" is reserved`);
  });
});

describe("Code Mode swarm host bridge", () => {
  it("keeps one invocation stable across restore and separates identical later turns", () => {
    const ctx = swarmContext();
    const code = 'agents.run("one")';
    const restoredAssistantTurnId = structuredClone("response-turn-1");
    const first = testing.codeModeReplayIdForToolCall(ctx, "call_0", code, "response-turn-1");

    expect(testing.codeModeReplayIdForToolCall(ctx, "call_0", code, restoredAssistantTurnId)).toBe(
      first,
    );
    expect(testing.codeModeReplayIdForToolCall(ctx, "call_0", code, "response-turn-2")).not.toBe(
      first,
    );
    expect(
      testing.codeModeReplayIdForToolCall(
        { ...ctx, runId: "run-next" },
        "call_0",
        code,
        "response-turn-1",
      ),
    ).not.toBe(first);
    expect(
      testing.codeModeReplayIdForToolCall(ctx, "call_0", 'agents.run("two")', "response-turn-1"),
    ).not.toBe(first);
  });

  it("dispatches notes with the canonical swarm group", async () => {
    const emitSessionLifecycleEvent = vi.fn();
    testing.setSwarmDepsForTest({ emitSessionLifecycleEvent });

    const result = await testing.runBridgeRequest({
      runtime: {},
      namespaceRuntime: {},
      parentToolCallId: "parent",
      codeModeRunId: "cm-note",
      ctx: swarmContext(),
      request: {
        id: "bridge:1",
        method: "swarmNote",
        args: [{ kind: "phase", text: "Plan" }],
      },
    });

    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      swarmGroupId: "swarm:agent:main:main:run-swarm",
      kind: "phase",
      text: "Plan",
    });
  });

  it("re-settles a persisted collector after restart without double-spawn", async () => {
    let persisted: Record<string, unknown> | undefined;
    let replayId = "";
    const callExactId = vi.fn(async (_id: string, input: Record<PropertyKey, unknown>) => {
      const idempotencyKey = input[SWARM_CODE_MODE_IDEMPOTENCY_KEY];
      const requestFingerprint = input[SWARM_CODE_MODE_REQUEST_FINGERPRINT];
      expect(idempotencyKey).toBe(`${replayId}:bridge:1`);
      expect(requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
      persisted = {
        runId: "collector-1",
        swarmRunId: "collector-1",
        childSessionKey: "agent:main:subagent:1",
        collect: true,
        swarmLaunchReplayKey: idempotencyKey,
        swarmLaunchRequestFingerprint: requestFingerprint,
      };
      return {
        result: { details: { status: "accepted", runId: "collector-1" } },
      };
    });
    const runtime = {
      namespaceEntries: () => [
        { id: "openclaw:core:sessions_spawn", source: "openclaw", name: "sessions_spawn" },
      ],
      callExactId,
    };
    const getSwarmRunByLaunchReplayKey = vi.fn(() => persisted);
    const waitForCollectorCompletion = vi.fn(async () => ({
      runId: "collector-1",
      status: "done",
      result: "restored",
      sessionKey: "agent:main:subagent:1",
    }));
    testing.setSwarmDepsForTest({
      getSwarmRunByLaunchReplayKey,
      waitForCollectorCompletion,
    });
    const spawnRequest = {
      id: "bridge:1",
      method: "agentSpawn",
      args: ["Research", { label: "facts" }],
    };
    const globalAliasContext = {
      ...swarmContext(),
      sessionKey: "main",
      config: { tools: { codeMode: true, swarm: { enabled: true } }, session: { scope: "global" } },
      runtimeConfig: {
        tools: { codeMode: true, swarm: { enabled: true } },
        session: { scope: "global" },
      },
    } as const;
    const code = 'return await agents.run("Research", { label: "facts" });';
    replayId = testing.codeModeReplayIdForToolCall(
      globalAliasContext,
      "call_0",
      code,
      "response-turn-1",
    );
    const restoredReplayId = testing.codeModeReplayIdForToolCall(
      globalAliasContext,
      "call_0",
      code,
      structuredClone("response-turn-1"),
    );
    expect(restoredReplayId).toBe(replayId);
    const bridgeBase = {
      runtime,
      namespaceRuntime: {},
      parentToolCallId: "parent",
      codeModeRunId: restoredReplayId,
      ctx: globalAliasContext,
    };

    const first = await testing.runBridgeRequest({ ...bridgeBase, request: spawnRequest });
    const replayed = await testing.runBridgeRequest({ ...bridgeBase, request: spawnRequest });
    const waited = await testing.runBridgeRequest({
      ...bridgeBase,
      request: { id: "bridge:2", method: "agentWait", args: ["collector-1"] },
    });

    expect(first).toMatchObject({ ok: true, value: { runId: "collector-1" } });
    expect(replayed).toMatchObject({ ok: true, value: { runId: "collector-1" } });
    expect(waited).toMatchObject({ ok: true, value: { status: "done", result: "restored" } });
    expect(callExactId).toHaveBeenCalledTimes(1);
    expect(getSwarmRunByLaunchReplayKey).toHaveBeenNthCalledWith(
      1,
      `${replayId}:bridge:1`,
      "global",
    );
    expect(getSwarmRunByLaunchReplayKey).toHaveBeenNthCalledWith(
      2,
      `${replayId}:bridge:1`,
      "global",
    );
    expect(waitForCollectorCompletion).toHaveBeenCalledWith({
      runId: "collector-1",
      currentSessionKeys: new Set(["main", "global"]),
      signal: undefined,
    });
  });

  it("spawns two collectors when later turns reuse the tool-call id and source", async () => {
    const persistedByReplayKey = new Map<string, Record<string, unknown>>();
    const callExactId = vi.fn(async (_id: string, input: Record<PropertyKey, unknown>) => {
      const replayKey = String(input[SWARM_CODE_MODE_IDEMPOTENCY_KEY]);
      const runId = `collector-${persistedByReplayKey.size + 1}`;
      persistedByReplayKey.set(replayKey, {
        runId,
        childSessionKey: `agent:main:subagent:${persistedByReplayKey.size + 1}`,
        swarmLaunchReplayKey: replayKey,
        swarmLaunchRequestFingerprint: input[SWARM_CODE_MODE_REQUEST_FINGERPRINT],
      });
      return { result: { details: { status: "accepted", runId } } };
    });
    testing.setSwarmDepsForTest({
      getSwarmRunByLaunchReplayKey: (key) => persistedByReplayKey.get(key),
    });
    const runtime = {
      namespaceEntries: () => [
        { id: "openclaw:core:sessions_spawn", source: "openclaw", name: "sessions_spawn" },
      ],
      callExactId,
    };
    const ctx = swarmContext();
    const code = 'return await agents.run("Research");';
    const firstReplayId = testing.codeModeReplayIdForToolCall(
      ctx,
      "call_0",
      code,
      "response-turn-1",
    );
    const secondReplayId = testing.codeModeReplayIdForToolCall(
      ctx,
      "call_0",
      code,
      "response-turn-2",
    );
    const bridgeBase = {
      runtime,
      namespaceRuntime: {},
      parentToolCallId: "parent",
      ctx,
      request: { id: "bridge:1", method: "agentSpawn", args: ["Research", {}] },
    };

    const first = await testing.runBridgeRequest({
      ...bridgeBase,
      codeModeRunId: firstReplayId,
    });
    const second = await testing.runBridgeRequest({
      ...bridgeBase,
      codeModeRunId: secondReplayId,
    });

    expect(secondReplayId).not.toBe(firstReplayId);
    expect(first).toMatchObject({ ok: true, value: { runId: "collector-1" } });
    expect(second).toMatchObject({ ok: true, value: { runId: "collector-2" } });
    expect(callExactId).toHaveBeenCalledTimes(2);
    expect([...persistedByReplayKey.keys()]).toEqual([
      `${firstReplayId}:bridge:1`,
      `${secondReplayId}:bridge:1`,
    ]);
  });

  it("rejects replay when the collector request payload changes", async () => {
    const callExactId = vi.fn(async (_id: string, input: Record<PropertyKey, unknown>) => ({
      result: { details: { status: "accepted", runId: "collector-1" } },
      fingerprint: input[SWARM_CODE_MODE_REQUEST_FINGERPRINT],
    }));
    const runtime = {
      namespaceEntries: () => [
        { id: "openclaw:core:sessions_spawn", source: "openclaw", name: "sessions_spawn" },
      ],
      callExactId,
    };
    const persisted: { value?: Record<string, unknown> } = {};
    testing.setSwarmDepsForTest({
      getSwarmRunByLaunchReplayKey: () => persisted.value,
    });
    const bridgeBase = {
      runtime,
      namespaceRuntime: {},
      parentToolCallId: "parent",
      codeModeRunId: "cm-restart",
      ctx: swarmContext(),
    };
    const first = await testing.runBridgeRequest({
      ...bridgeBase,
      request: { id: "bridge:1", method: "agentSpawn", args: ["Research one", {}] },
    });
    expect(first.ok).toBe(true);
    const spawnInput = callExactId.mock.calls[0]?.[1] as Record<PropertyKey, unknown>;
    persisted.value = {
      runId: "collector-1",
      childSessionKey: "agent:main:subagent:1",
      swarmLaunchRequestFingerprint: spawnInput[SWARM_CODE_MODE_REQUEST_FINGERPRINT],
    };

    const replay = await testing.runBridgeRequest({
      ...bridgeBase,
      request: { id: "bridge:1", method: "agentSpawn", args: ["Research two", {}] },
    });

    expect(replay).toMatchObject({ ok: false });
    expect(replay.ok ? "" : replay.error).toContain("does not match the persisted collector");
    expect(callExactId).toHaveBeenCalledTimes(1);
  });

  it("rejects a pending reservation without durable launch state", async () => {
    const callExactId = vi.fn(async (_id: string, _input: Record<PropertyKey, unknown>) => ({
      result: { details: { status: "accepted", runId: "collector-1" } },
    }));
    const runtime = {
      namespaceEntries: () => [
        { id: "openclaw:core:sessions_spawn", source: "openclaw", name: "sessions_spawn" },
      ],
      callExactId,
    };
    const persisted: { value?: Record<string, unknown> } = {};
    const initSubagentRegistry = vi.fn();
    testing.setSwarmDepsForTest({
      getSwarmRunByLaunchReplayKey: () => persisted.value,
      initSubagentRegistry,
    });
    const bridgeBase = {
      runtime,
      namespaceRuntime: {},
      parentToolCallId: "parent",
      codeModeRunId: "cm-restart",
      ctx: swarmContext(),
    };
    await testing.runBridgeRequest({
      ...bridgeBase,
      request: { id: "bridge:1", method: "agentSpawn", args: ["Research", {}] },
    });
    const spawnInput = callExactId.mock.calls[0]?.[1] as Record<PropertyKey, unknown>;
    persisted.value = {
      runId: "collector-1",
      childSessionKey: "agent:main:subagent:1",
      swarmLaunchPending: true,
      swarmLaunchRequestFingerprint: spawnInput[SWARM_CODE_MODE_REQUEST_FINGERPRINT],
    };

    const replay = await testing.runBridgeRequest({
      ...bridgeBase,
      request: { id: "bridge:1", method: "agentSpawn", args: ["Research", {}] },
    });

    expect(replay).toMatchObject({ ok: false });
    expect(replay.ok ? "" : replay.error).toContain("launch reservation cannot be recovered");
    expect(initSubagentRegistry).not.toHaveBeenCalled();
    expect(callExactId).toHaveBeenCalledTimes(1);
  });

  it("re-enqueues a durable pending reservation before returning its handle", async () => {
    const initSubagentRegistry = vi.fn();
    testing.setSwarmDepsForTest({
      initSubagentRegistry,
      getSwarmRunByLaunchReplayKey: () => ({
        runId: "collector-1",
        childSessionKey: "agent:main:subagent:1",
        swarmLaunchPending: true,
        swarmLaunchRequestFingerprint: `sha256:${createHash("sha256")
          .update(
            stableStringify({
              task: "Research",
              collect: true,
              groupId: "swarm:agent:main:main:run-swarm",
            }),
          )
          .digest("hex")}`,
        queuedLaunch: { request: {}, timeoutMs: 1, schedulerGroupKey: "group", maxConcurrent: 1 },
      }),
    });
    const runtime = {
      namespaceEntries: () => [
        { id: "openclaw:core:sessions_spawn", source: "openclaw", name: "sessions_spawn" },
      ],
      callExactId: vi.fn(),
    };

    const replay = await testing.runBridgeRequest({
      runtime,
      namespaceRuntime: {},
      parentToolCallId: "parent",
      codeModeRunId: "cm-restart",
      ctx: swarmContext(),
      request: { id: "bridge:1", method: "agentSpawn", args: ["Research", {}] },
    });

    expect(replay).toMatchObject({ ok: true, value: { runId: "collector-1" } });
    expect(initSubagentRegistry).toHaveBeenCalledOnce();
    expect(runtime.callExactId).not.toHaveBeenCalled();
  });

  it("renews expired snapshots while agentWait remains pending", () => {
    const now = 10_000;
    testing.activeRuns.set("cm-pending-agent", {
      config: { ...config, snapshotTtlSeconds: 60 },
      expiresAt: now - 1,
      agentWaitRetainUntil: now + 120_000,
      pending: [
        {
          id: "bridge:2",
          method: "agentWait",
          args: ["collector-1"],
          promise: new Promise(() => {}),
        },
      ],
    } as never);

    testing.removeExpiredRuns(now);

    expect(testing.activeRuns.get("cm-pending-agent")?.expiresAt).toBe(now + 60_000);
  });

  it("evicts and cancels an agentWait snapshot at its retention cap", () => {
    const now = 10_000;
    const cancel = vi.fn();
    testing.activeRuns.set("cm-expired-agent", {
      config: { ...config, snapshotTtlSeconds: 60 },
      expiresAt: now - 1,
      agentWaitRetainUntil: now - 1,
      pending: [
        {
          id: "bridge:agentWait:1",
          method: "agentWait",
          args: ["collector-1"],
          promise: new Promise(() => {}),
          cancel,
        },
      ],
    } as never);

    testing.removeExpiredRuns(now);

    expect(testing.activeRuns.has("cm-expired-agent")).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});
