import type { Api, Model } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import type { EmbeddedRunAttemptResult } from "../pi-embedded-runner/run/types.js";
import type { AgentHarness, AgentHarnessAttemptParams } from "./types.js";
import type { AgentHarnessV2 } from "./v2.js";
import { adaptAgentHarnessToV2, runAgentHarnessV2LifecycleAttempt } from "./v2.js";

function createAttemptParams(): AgentHarnessAttemptParams {
  return {
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "session-key",
    runId: "run-1",
    sessionFile: "/tmp/session.jsonl",
    workspaceDir: "/tmp/workspace",
    timeoutMs: 5_000,
    provider: "codex",
    modelId: "gpt-5.4",
    model: { id: "gpt-5.4", provider: "codex" } as Model<Api>,
    authStorage: {} as never,
    modelRegistry: {} as never,
    thinkLevel: "low",
    messageChannel: "qa",
    trigger: "manual",
  } as AgentHarnessAttemptParams;
}

function createDiagnosticTrace() {
  return {
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    traceFlags: "01",
  };
}

function createAttemptResult(): EmbeddedRunAttemptResult {
  return {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    promptError: null,
    promptErrorSource: null,
    sessionIdUsed: "session-1",
    diagnosticTrace: createDiagnosticTrace(),
    messagesSnapshot: [],
    assistantTexts: ["ok"],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  };
}

async function flushDiagnosticEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function captureDiagnosticEvents(): {
  events: Array<{ event: DiagnosticEventPayload; metadata: DiagnosticEventMetadata }>;
  unsubscribe: () => void;
} {
  const events: Array<{ event: DiagnosticEventPayload; metadata: DiagnosticEventMetadata }> = [];
  const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
    if (event.type.startsWith("harness.run.")) {
      events.push({ event, metadata });
    }
  });
  return { events, unsubscribe };
}

describe("AgentHarness V2 compatibility adapter", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
  });

  it("executes prepare/start/send/outcome/cleanup as one bounded lifecycle", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const events: string[] = [];
    const harness: AgentHarnessV2 = {
      id: "native-v2",
      label: "Native V2",
      supports: () => ({ supported: true }),
      prepare: async (attemptParams) => {
        events.push("prepare");
        expect(attemptParams).toBe(params);
        return {
          harnessId: "native-v2",
          label: "Native V2",
          params,
          lifecycleState: "prepared",
        };
      },
      start: async (prepared) => {
        events.push(`start:${prepared.lifecycleState}`);
        return { ...prepared, lifecycleState: "started" };
      },
      send: async (session) => {
        events.push(`send:${session.lifecycleState}`);
        return result;
      },
      resolveOutcome: async (session, rawResult) => {
        events.push(`outcome:${session.lifecycleState}`);
        return { ...rawResult, agentHarnessId: session.harnessId };
      },
      cleanup: async ({ prepared, session, result: cleanupResult, error }) => {
        expect(prepared?.lifecycleState).toBe("prepared");
        expect(session?.lifecycleState).toBe("started");
        if (!session) {
          throw new Error("expected started session during successful cleanup");
        }
        events.push(`cleanup:${session.lifecycleState}`);
        expect(cleanupResult).toMatchObject({ agentHarnessId: "native-v2" });
        expect(error).toBeUndefined();
      },
    };

    await expect(runAgentHarnessV2LifecycleAttempt(harness, params)).resolves.toMatchObject({
      agentHarnessId: "native-v2",
      sessionIdUsed: "session-1",
    });
    expect(events).toEqual([
      "prepare",
      "start:prepared",
      "send:started",
      "outcome:started",
      "cleanup:started",
    ]);
  });

  it("emits trusted harness lifecycle diagnostics for successful attempts", async () => {
    resetDiagnosticEventsForTest();
    const params = createAttemptParams();
    const result = {
      ...createAttemptResult(),
      agentHarnessResultClassification: "reasoning-only",
      yieldDetected: true,
      itemLifecycle: { startedCount: 3, completedCount: 2, activeCount: 1 },
    } as EmbeddedRunAttemptResult;
    const harness: AgentHarnessV2 = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true }),
      prepare: async () => ({
        harnessId: "codex",
        label: "Codex",
        pluginId: "codex-plugin",
        params,
        lifecycleState: "prepared",
      }),
      start: async (prepared) => ({ ...prepared, lifecycleState: "started" }),
      send: async () => result,
      resolveOutcome: async (_session, rawResult) => rawResult,
      cleanup: async () => {},
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessV2LifecycleAttempt(harness, params);
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events.map(({ event }) => event.type)).toEqual([
      "harness.run.started",
      "harness.run.completed",
    ]);
    expect(diagnostics.events.every(({ metadata }) => metadata.trusted)).toBe(true);
    expect(diagnostics.events[1]?.event).toMatchObject({
      type: "harness.run.completed",
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-1",
      provider: "codex",
      model: "gpt-5.4",
      channel: "qa",
      trigger: "manual",
      harnessId: "codex",
      pluginId: "codex-plugin",
      outcome: "completed",
      resultClassification: "reasoning-only",
      yieldDetected: true,
      itemLifecycle: { startedCount: 3, completedCount: 2, activeCount: 1 },
      durationMs: expect.any(Number),
    });
  });

  it("emits trusted harness error diagnostics with the failing lifecycle phase", async () => {
    resetDiagnosticEventsForTest();
    const params = createAttemptParams();
    const sendError = new Error("codex app-server send failed");
    const harness: AgentHarnessV2 = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      prepare: async () => ({
        harnessId: "codex",
        label: "Codex",
        params,
        lifecycleState: "prepared",
      }),
      start: async (prepared) => ({ ...prepared, lifecycleState: "started" }),
      send: async () => {
        throw sendError;
      },
      resolveOutcome: async (_session, rawResult) => rawResult,
      cleanup: async () => {
        throw new Error("cleanup failed");
      },
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await expect(runAgentHarnessV2LifecycleAttempt(harness, params)).rejects.toThrow(
        "codex app-server send failed",
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events.map(({ event }) => event.type)).toEqual([
      "harness.run.started",
      "harness.run.error",
    ]);
    expect(diagnostics.events.every(({ metadata }) => metadata.trusted)).toBe(true);
    expect(diagnostics.events[1]?.event).toMatchObject({
      type: "harness.run.error",
      phase: "send",
      errorCategory: "Error",
      cleanupFailed: true,
      harnessId: "codex",
      durationMs: expect.any(Number),
    });
  });

  it("runs cleanup with the original failure and preserves that failure", async () => {
    const params = createAttemptParams();
    const sendError = new Error("codex app-server send failed");
    const cleanup = vi.fn(async () => {
      throw new Error("cleanup should not mask send failure");
    });
    const harness: AgentHarnessV2 = {
      id: "native-v2",
      label: "Native V2",
      supports: () => ({ supported: true }),
      prepare: async () => ({
        harnessId: "native-v2",
        label: "Native V2",
        params,
        lifecycleState: "prepared",
      }),
      start: async (prepared) => ({ ...prepared, lifecycleState: "started" }),
      send: async () => {
        throw sendError;
      },
      resolveOutcome: async (_session, rawResult) => rawResult,
      cleanup,
    };

    await expect(runAgentHarnessV2LifecycleAttempt(harness, params)).rejects.toThrow(
      "codex app-server send failed",
    );
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        error: sendError,
        prepared: expect.objectContaining({ lifecycleState: "prepared" }),
        session: expect.objectContaining({ lifecycleState: "started" }),
      }),
    );
  });

  it("runs cleanup for failed prepare/start lifecycle stages", async () => {
    const params = createAttemptParams();
    const startError = new Error("codex app-server start failed");
    const cleanup = vi.fn(async () => {});
    const harness: AgentHarnessV2 = {
      id: "native-v2",
      label: "Native V2",
      supports: () => ({ supported: true }),
      prepare: async () => ({
        harnessId: "native-v2",
        label: "Native V2",
        params,
        lifecycleState: "prepared",
      }),
      start: async () => {
        throw startError;
      },
      send: async () => createAttemptResult(),
      resolveOutcome: async (_session, rawResult) => rawResult,
      cleanup,
    };

    await expect(runAgentHarnessV2LifecycleAttempt(harness, params)).rejects.toThrow(
      "codex app-server start failed",
    );
    expect(cleanup).toHaveBeenCalledWith({
      error: startError,
      prepared: expect.objectContaining({ lifecycleState: "prepared" }),
      session: undefined,
    });
  });

  it("passes raw send results to cleanup when outcome resolution fails", async () => {
    const params = createAttemptParams();
    const rawResult = createAttemptResult();
    const outcomeError = new Error("outcome classification failed");
    const cleanup = vi.fn(async () => {});
    const harness: AgentHarnessV2 = {
      id: "native-v2",
      label: "Native V2",
      supports: () => ({ supported: true }),
      prepare: async () => ({
        harnessId: "native-v2",
        label: "Native V2",
        params,
        lifecycleState: "prepared",
      }),
      start: async (prepared) => ({ ...prepared, lifecycleState: "started" }),
      send: async () => rawResult,
      resolveOutcome: async () => {
        throw outcomeError;
      },
      cleanup,
    };

    await expect(runAgentHarnessV2LifecycleAttempt(harness, params)).rejects.toThrow(
      "outcome classification failed",
    );
    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        error: outcomeError,
        result: rawResult,
        prepared: expect.objectContaining({ lifecycleState: "prepared" }),
        session: expect.objectContaining({ lifecycleState: "started" }),
      }),
    );
  });

  it("surfaces cleanup failures after successful outcomes", async () => {
    const params = createAttemptParams();
    const harness: AgentHarnessV2 = {
      id: "native-v2",
      label: "Native V2",
      supports: () => ({ supported: true }),
      prepare: async () => ({
        harnessId: "native-v2",
        label: "Native V2",
        params,
        lifecycleState: "prepared",
      }),
      start: async (prepared) => ({ ...prepared, lifecycleState: "started" }),
      send: async () => createAttemptResult(),
      resolveOutcome: async (_session, rawResult) => rawResult,
      cleanup: async () => {
        throw new Error("cleanup failed");
      },
    };

    await expect(runAgentHarnessV2LifecycleAttempt(harness, params)).rejects.toThrow(
      "cleanup failed",
    );
  });

  it("runs a V1 harness through prepare/start/send without changing attempt params", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const runAttempt = vi.fn(async () => result);
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true, priority: 100 }),
      runAttempt,
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const prepared = await v2.prepare(params);
    const session = await v2.start(prepared);

    expect(v2.resume).toBeUndefined();
    expect(await v2.send(session)).toBe(result);
    expect(runAttempt).toHaveBeenCalledWith(params);
    expect(session).toMatchObject({
      harnessId: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      params,
      lifecycleState: "started",
    });
    expect(prepared.lifecycleState).toBe("prepared");
  });

  it("keeps result classification as an explicit outcome stage", async () => {
    const params = createAttemptParams();
    const result = createAttemptResult();
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "empty");
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => result),
      classify,
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(params));

    expect(await v2.resolveOutcome(session, result)).toMatchObject({
      agentHarnessId: "codex",
      agentHarnessResultClassification: "empty",
    });
    expect(harness.classify).toHaveBeenCalledWith(result, params);
  });

  it("preserves harness-supplied classification when no classify hook is registered", async () => {
    const params = createAttemptParams();
    const result = {
      ...createAttemptResult(),
      agentHarnessResultClassification: "reasoning-only",
    } as EmbeddedRunAttemptResult;
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => result),
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(params));

    expect(await v2.resolveOutcome(session, result)).toMatchObject({
      agentHarnessId: "codex",
      agentHarnessResultClassification: "reasoning-only",
    });
  });

  it("clears stale non-ok classification when classification resolves to ok", async () => {
    const params = createAttemptParams();
    const result = {
      ...createAttemptResult(),
      agentHarnessResultClassification: "empty",
    } as EmbeddedRunAttemptResult;
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => "ok");
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => result),
      classify,
    };

    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(params));

    const classified = await v2.resolveOutcome(session, result);
    expect(classified).toMatchObject({ agentHarnessId: "codex" });
    expect(classified).not.toHaveProperty("agentHarnessResultClassification");
  });

  it("preserves existing compact/reset/dispose hook this binding as compatibility methods", async () => {
    const harness: AgentHarness & {
      compactCalls: number;
      resetCalls: number;
      disposeCalls: number;
    } = {
      id: "custom",
      label: "Custom",
      compactCalls: 0,
      resetCalls: 0,
      disposeCalls: 0,
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      async compact() {
        this.compactCalls += 1;
        return {
          ok: true,
          compacted: true,
          result: {
            summary: "done",
            firstKeptEntryId: "entry-1",
            tokensBefore: 100,
          },
        };
      },
      reset(params) {
        expect(params).toEqual({ reason: "reset" });
        this.resetCalls += 1;
      },
      dispose() {
        this.disposeCalls += 1;
      },
    };

    const v2 = adaptAgentHarnessToV2(harness);

    await expect(
      v2.compact?.({
        sessionId: "session-1",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp/workspace",
      }),
    ).resolves.toMatchObject({
      compacted: true,
    });
    await v2.reset?.({ reason: "reset" });
    await v2.dispose?.();

    expect(harness.compactCalls).toBe(1);
    expect(harness.resetCalls).toBe(1);
    expect(harness.disposeCalls).toBe(1);
  });

  it("does not dispose V1 harnesses during per-attempt cleanup", async () => {
    const dispose = vi.fn();
    const harness: AgentHarness = {
      id: "custom",
      label: "Custom",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      dispose,
    };
    const v2 = adaptAgentHarnessToV2(harness);
    const session = await v2.start(await v2.prepare(createAttemptParams()));

    await v2.cleanup({ session, result: createAttemptResult() });

    expect(dispose).not.toHaveBeenCalled();
  });
});
