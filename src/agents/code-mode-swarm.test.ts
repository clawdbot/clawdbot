import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { CodeModeOutputState } from "./code-mode-json.js";
import { createCodeModeNamespaceRuntime } from "./code-mode-namespaces.js";
import { consumeRepairableCodeModeFailure } from "./code-mode-repair-provenance.js";
import type { CodeModeWorkerResult } from "./code-mode-runtime.js";
import { applyCodeModeCatalog, resolveCodeModeConfig } from "./code-mode.js";
import {
  createCodeModeHarness,
  fakeTool,
  resetCodeModeTestState,
  resultDetails,
  runUntilCompleted,
  testing,
} from "./code-mode.test-support.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "./subagents/swarm/swarm-code-mode.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const swarmMocks = vi.hoisted(() => ({
  emitSessionLifecycleEvent: vi.fn(),
  getSwarmRunByLaunchReplayKey: vi.fn(),
  initSubagentRegistry: vi.fn(),
  waitForCollectorCompletion: vi.fn(),
}));

vi.mock("../sessions/session-lifecycle-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sessions/session-lifecycle-events.js")>()),
  emitSessionLifecycleEvent: swarmMocks.emitSessionLifecycleEvent,
}));

vi.mock("./subagents/registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./subagents/registry/subagent-registry.js")>()),
  getSwarmRunByLaunchReplayKey: swarmMocks.getSwarmRunByLaunchReplayKey,
  initSubagentRegistry: swarmMocks.initSubagentRegistry,
}));

vi.mock("./tools/agents-wait-tool.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tools/agents-wait-tool.js")>()),
  waitForCollectorCompletion: swarmMocks.waitForCollectorCompletion,
}));

const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);

function projectWorkerResult(result: CodeModeWorkerResult) {
  const output = new CodeModeOutputState(config.maxOutputBytes);
  output.append(result.output);
  return {
    ...result,
    ...output.take(
      result.status === "completed"
        ? { value: result.value }
        : result.status === "failed"
          ? { error: result.error }
          : {},
    ),
  };
}

function workerExec(source: string, swarmEnabled: boolean) {
  return testing
    .runCodeModeWorker(
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
    )
    .then(projectWorkerResult);
}

function workerResume(
  waiting: Extract<Awaited<ReturnType<typeof workerExec>>, { status: "waiting" }>,
  settledRequests: Array<{ id: string; ok: true; value: unknown }>,
) {
  return testing
    .runCodeModeWorker(
      {
        kind: "resume",
        snapshot: waiting.snapshot,
        config,
        settledRequests,
      },
      10_000,
    )
    .then(projectWorkerResult);
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

function collectorRecord(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "collector-1",
    childSessionKey: "agent:main:subagent:1",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "agent:main:main",
    task: "Research",
    cleanup: "delete",
    createdAt: 1,
    execution: { status: "running" },
    ...overrides,
  };
}

function collectorFingerprint(task = "Research"): string {
  return `sha256:${createHash("sha256")
    .update(
      stableStringify({
        task,
        collect: true,
        groupId: "swarm:agent:main:main:run-swarm",
      }),
    )
    .digest("hex")}`;
}

function createSwarmHarness(execute?: AnyAgentTool["execute"]) {
  const harness = createCodeModeHarness();
  const toolsConfig = (harness.config as { tools: Record<string, unknown> }).tools;
  toolsConfig.swarm = { enabled: true };
  Object.assign(harness.ctx, {
    sessionId: "session-swarm",
    runId: "run-swarm",
  });
  const spawnTool = fakeTool("sessions_spawn", "Spawn a collector");
  spawnTool.execute = vi.fn(
    execute ?? (async () => jsonResult({ status: "accepted", runId: "collector-1" })),
  ) as AnyAgentTool["execute"];
  applyCodeModeCatalog({
    tools: [...harness.tools, spawnTool],
    config: harness.config,
    sessionId: harness.ctx.sessionId,
    sessionKey: harness.ctx.sessionKey,
    runId: harness.ctx.runId,
    catalogRef: harness.catalogRef,
  });
  return { ...harness, spawnTool };
}

async function runSwarmCode(harness: ReturnType<typeof createSwarmHarness>, code: string) {
  const execTool = harness.tools[0];
  const waitTool = harness.tools[1];
  if (!execTool || !waitTool) {
    throw new Error("expected Code Mode exec and wait tools");
  }
  return await runUntilCompleted({ execTool, waitTool, code });
}

beforeEach(() => {
  swarmMocks.emitSessionLifecycleEvent.mockReset();
  swarmMocks.getSwarmRunByLaunchReplayKey.mockReset().mockReturnValue(undefined);
  swarmMocks.initSubagentRegistry.mockReset();
  swarmMocks.waitForCollectorCompletion.mockReset().mockResolvedValue({
    runId: "collector-1",
    status: "done",
    result: "restored",
    sessionKey: "agent:main:subagent:1",
  });
});

afterEach(() => {
  resetCodeModeTestState();
  vi.useRealTimers();
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

  it("keeps a guest error after a parked agents.run restricted without replaying the collector", async () => {
    const collectorStarted = createDeferred();
    const collectorRelease = createDeferred();
    swarmMocks.waitForCollectorCompletion.mockImplementation(async () => {
      collectorStarted.resolve();
      await collectorRelease.promise;
      return { runId: "collector-1", status: "done", result: "collected" };
    });
    const harness = createSwarmHarness();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const executing = harness.tools[0]!.execute("parked-collector", {
      code: `await agents.run("Research"); return missingAfterCollector();`,
    });
    try {
      await collectorStarted.promise;
      await vi.advanceTimersByTimeAsync(10_000);
      const parked = resultDetails(await executing);
      expect(parked).toMatchObject({
        status: "waiting",
        reason: "pending_tools",
        pendingToolCalls: [expect.objectContaining({ method: "agentWait" })],
      });
      vi.useRealTimers();
      collectorRelease.resolve();
      const details = resultDetails(
        await harness.tools[1]!.execute("collector-wait", {
          runId: parked.runId,
        }),
      );

      expect(details).toMatchObject({
        status: "failed",
        failurePhase: "bridge",
        bridgeDispatchStarted: true,
        error: expect.stringContaining("ReferenceError: missingAfterCollector is not defined"),
      });
      expect(consumeRepairableCodeModeFailure(details)).toBe(false);
      expect(harness.spawnTool.execute).toHaveBeenCalledOnce();
      expect(swarmMocks.waitForCollectorCompletion).toHaveBeenCalledOnce();
      expect(testing.activeRuns.size).toBe(0);
    } finally {
      collectorRelease.resolve();
      vi.useRealTimers();
      await executing;
    }
  });

  it.each([
    { name: "blank result", schemaError: undefined },
    { name: "schema error", schemaError: "structured output was invalid" },
  ])("prefers an authoritative execution error over $name", async ({ schemaError }) => {
    const first = await workerExec('return await agents.run("Fail after output");', true);
    expectWaiting(first);
    const second = await workerResume(first, [
      { id: first.pendingRequests[0]!.id, ok: true, value: { runId: "collector-4" } },
    ]);
    expectWaiting(second);

    const failed = await workerResume(second, [
      {
        id: second.pendingRequests[0]!.id,
        ok: true,
        value: {
          runId: "collector-4",
          status: "failed",
          result: "",
          structured: { partial: true },
          error: "provider failed after tool output",
          ...(schemaError ? { schemaError } : {}),
        },
      },
    ]);

    expect(failed).toMatchObject({ status: "failed", code: "internal_error" });
    if (failed.status === "failed") {
      expect(failed.error).toContain(
        "SwarmAgentError: Swarm agent collector-4 failed: provider failed after tool output",
      );
      expect(failed.error).not.toContain("structured output was invalid");
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
    const { apiFiles: files } = createCodeModeNamespaceRuntime();

    expect(files.map((file) => file.path)).toEqual(["agents.d.ts"]);
    expect(files[0]?.content).toContain("Promise.all");
    expect(files[0]?.content).toContain("while (!ready)");
    expect(files[0]?.content).toContain("schema: AgentJsonSchema");
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
    const result = await runSwarmCode(createSwarmHarness(), 'phase("Plan"); return "ok";');

    expect(result).toMatchObject({ status: "completed", value: "ok" });
    expect(swarmMocks.emitSessionLifecycleEvent).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      swarmGroupId: "swarm:agent:main:main:run-swarm",
      kind: "phase",
      text: "Plan",
    });
  });

  it("refuses swarm globals when the run executes only an allowlist", async () => {
    const harness = createSwarmHarness();
    Object.assign(harness.ctx, { toolExecutionAllow: ["skill_workshop"] });

    // Guest phase/log are fire-and-forget, so the refusal shows as no foreground event.
    const noted = await runSwarmCode(harness, 'phase("Plan"); return "ok";');
    const spawned = await runSwarmCode(harness, 'return await agents.run("Research");');

    expect(noted).toMatchObject({ status: "completed", value: "ok" });
    expect(spawned).toMatchObject({ status: "failed" });
    expect(String(spawned.error)).toContain("Unavailable during skill review");
    expect(swarmMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
    expect(harness.spawnTool.execute).not.toHaveBeenCalled();
  });

  it.each(["abort", "catalog"] as const)(
    "discards queued collector launches after %s closure",
    async (closure) => {
      const entered = createDeferred();
      const release = createDeferred();
      const launches: Array<Promise<ReturnType<typeof jsonResult>>> = [];
      const harness = createSwarmHarness(() => {
        const launch = release.promise.then(() =>
          jsonResult({ status: "accepted", runId: "late-collector" }),
        );
        launches.push(launch);
        if (launches.length === config.maxPendingToolCalls) {
          entered.resolve();
        }
        return launch;
      });
      const controller = new AbortController();
      const executing = harness.tools[0]!.execute(
        "queued-collector-closure",
        {
          code: `return await Promise.all(Array.from(
            { length: ${config.maxPendingToolCalls + 4} },
            (_, index) => agents.run("Research " + index),
          ));`,
        },
        controller.signal,
      );
      try {
        await Promise.race([
          entered.promise,
          executing.then(() => {
            throw new Error("execution ended before the collector frontier started");
          }),
        ]);
        if (closure === "abort") {
          controller.abort();
        } else {
          clearToolSearchCatalog(harness.ctx);
        }
        expect(resultDetails(await executing)).toMatchObject({ status: "failed", code: "aborted" });
      } finally {
        controller.abort();
        release.resolve();
        await Promise.allSettled(launches);
        await executing;
      }
      expect(harness.spawnTool.execute).toHaveBeenCalledTimes(config.maxPendingToolCalls);
      expect(swarmMocks.waitForCollectorCompletion).not.toHaveBeenCalled();
      expect(testing.activeRuns.size).toBe(0);
    },
  );

  it("re-settles a persisted collector after restart without double-spawn", async () => {
    let persisted: SubagentRunRecord | undefined;
    const harness = createSwarmHarness(async (_toolCallId, input) => {
      const spawnInput = input as Record<PropertyKey, unknown>;
      const replayKey = spawnInput[SWARM_CODE_MODE_IDEMPOTENCY_KEY];
      const requestFingerprint = spawnInput[SWARM_CODE_MODE_REQUEST_FINGERPRINT];
      expect(replayKey).toEqual(
        expect.stringMatching(/^cm_replay_[0-9a-f]{24}:bridge:agentSpawn:1$/u),
      );
      expect(requestFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
      persisted = collectorRecord({
        swarmRunId: "collector-1",
        collect: true,
        swarmLaunchReplayKey: String(replayKey),
        swarmLaunchRequestFingerprint: String(requestFingerprint),
      });
      return jsonResult({ status: "accepted", runId: "collector-1" });
    });
    swarmMocks.getSwarmRunByLaunchReplayKey.mockImplementation(() => persisted);
    const code = 'return await agents.run("Research");';

    const first = await runSwarmCode(harness, code);
    const replayed = await runSwarmCode(harness, code);

    expect(first).toMatchObject({ status: "completed", value: "restored" });
    expect(replayed).toMatchObject({ status: "completed", value: "restored" });
    expect(harness.spawnTool.execute).toHaveBeenCalledTimes(1);
    expect(swarmMocks.getSwarmRunByLaunchReplayKey).toHaveBeenCalledTimes(2);
    expect(swarmMocks.waitForCollectorCompletion).toHaveBeenCalledTimes(2);
  });

  it("rejects a persisted collector whose request fingerprint does not match", async () => {
    swarmMocks.getSwarmRunByLaunchReplayKey.mockReturnValue(
      collectorRecord({ swarmLaunchRequestFingerprint: collectorFingerprint("Different task") }),
    );
    const harness = createSwarmHarness();

    const result = await runSwarmCode(harness, 'return await agents.run("Research");');

    expect(result).toMatchObject({ status: "failed", code: "internal_error" });
    expect(String(result.error)).toContain("does not match the persisted collector");
    expect(harness.spawnTool.execute).not.toHaveBeenCalled();
  });

  it("rejects a pending reservation without durable launch state", async () => {
    swarmMocks.getSwarmRunByLaunchReplayKey.mockReturnValue(
      collectorRecord({
        swarmLaunchPending: true,
        swarmLaunchRequestFingerprint: collectorFingerprint(),
      }),
    );
    const harness = createSwarmHarness();

    const result = await runSwarmCode(harness, 'return await agents.run("Research");');

    expect(result).toMatchObject({ status: "failed", code: "internal_error" });
    expect(String(result.error)).toContain("launch reservation cannot be recovered");
    expect(swarmMocks.initSubagentRegistry).not.toHaveBeenCalled();
    expect(harness.spawnTool.execute).not.toHaveBeenCalled();
  });

  it("re-enqueues a durable pending reservation before returning its handle", async () => {
    swarmMocks.getSwarmRunByLaunchReplayKey.mockReturnValue(
      collectorRecord({
        swarmLaunchPending: true,
        swarmLaunchRequestFingerprint: collectorFingerprint(),
        queuedLaunch: { request: {}, timeoutMs: 1, schedulerGroupKey: "group", maxConcurrent: 1 },
      }),
    );
    const harness = createSwarmHarness();

    const result = await runSwarmCode(harness, 'return await agents.run("Research");');

    expect(result).toMatchObject({ status: "completed", value: "restored" });
    expect(swarmMocks.initSubagentRegistry).toHaveBeenCalledOnce();
    expect(harness.spawnTool.execute).not.toHaveBeenCalled();
  });

  it("renews expired snapshots while agentWait remains pending", () => {
    const now = 10_000;
    testing.activeRuns.set("cm-pending-agent", {
      owner: { close: () => undefined },
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
      owner: { close: () => undefined },
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
