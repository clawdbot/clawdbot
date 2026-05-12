import type { Api, Model } from "@earendil-works/pi-ai";
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
    authProfileStore: { version: 1, profiles: {} },
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
    timedOutDuringToolExecution: false,
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

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0): unknown {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`Expected mock call at index ${index}`);
  }
  return call[0];
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
        expect((cleanupResult as { agentHarnessId?: string }).agentHarnessId).toBe("native-v2");
        expect(error).toBeUndefined();
      },
    };

    const attemptResult = await runAgentHarnessV2LifecycleAttempt(harness, params);
    expect((attemptResult as { agentHarnessId?: string }).agentHarnessId).toBe("native-v2");
    expect(attemptResult.sessionIdUsed).toBe("session-1");
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
    const completedEvent = diagnostics.events[1]?.event as
      | (DiagnosticEventPayload & Record<string, unknown>)
      | undefined;
    expect(completedEvent?.type).toBe("harness.run.completed");
    expect(completedEvent?.runId).toBe("run-1");
    expect(completedEvent?.sessionKey).toBe("session-key");
    expect(completedEvent?.sessionId).toBe("session-1");
    expect(completedEvent?.provider).toBe("codex");
    expect(completedEvent?.model).toBe("gpt-5.4");
    expect(completedEvent?.channel).toBe("qa");
    expect(completedEvent?.trigger).toBe("manual");
    expect(completedEvent?.harnessId).toBe("codex");
    expect(completedEvent?.pluginId).toBe("codex-plugin");
    expect(completedEvent?.outcome).toBe("completed");
    expect(completedEvent?.resultClassification).toBe("reasoning-only");
    expect(completedEvent?.yieldDetected).toBe(true);
    expect(completedEvent?.itemLifecycle).toEqual({
      startedCount: 3,
      completedCount: 2,
      activeCount: 1,
    });
    expect(typeof completedEvent?.durationMs).toBe("number");
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
    const errorEvent = diagnostics.events[1]?.event as
      | (DiagnosticEventPayload & Record<string, unknown>)
      | undefined;
    expect(errorEvent?.type).toBe("harness.run.error");
    expect(errorEvent?.phase).toBe("send");
    expect(errorEvent?.errorCategory).toBe("Error");
    expect(errorEvent?.cleanupFailed).toBe(true);
    expect(errorEvent?.harnessId).toBe("codex");
    expect(typeof errorEvent?.durationMs).toBe("number");
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
    const cleanupInput = mockCallArg(cleanup) as {
      error?: unknown;
      prepared?: { lifecycleState?: string };
      session?: { lifecycleState?: string };
    };
    expect(cleanupInput.error).toBe(sendError);
    expect(cleanupInput.prepared?.lifecycleState).toBe("prepared");
    expect(cleanupInput.session?.lifecycleState).toBe("started");
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
    const cleanupInput = mockCallArg(cleanup) as {
      error?: unknown;
      prepared?: { lifecycleState?: string };
      session?: unknown;
    };
    expect(cleanupInput.error).toBe(startError);
    expect(cleanupInput.prepared?.lifecycleState).toBe("prepared");
    expect(cleanupInput.session).toBeUndefined();
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
    const cleanupInput = mockCallArg(cleanup) as {
      error?: unknown;
      result?: unknown;
      prepared?: { lifecycleState?: string };
      session?: { lifecycleState?: string };
    };
    expect(cleanupInput.error).toBe(outcomeError);
    expect(cleanupInput.result).toBe(rawResult);
    expect(cleanupInput.prepared?.lifecycleState).toBe("prepared");
    expect(cleanupInput.session?.lifecycleState).toBe("started");
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
    expect(session.harnessId).toBe("codex");
    expect(session.label).toBe("Codex");
    expect(session.pluginId).toBe("codex-plugin");
    expect(session.params).toBe(params);
    expect(session.lifecycleState).toBe("started");
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

    const outcome = await v2.resolveOutcome(session, result);
    expect(outcome.agentHarnessId).toBe("codex");
    expect(outcome.agentHarnessResultClassification).toBe("empty");
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

    const outcome = await v2.resolveOutcome(session, result);
    expect(outcome.agentHarnessId).toBe("codex");
    expect(outcome.agentHarnessResultClassification).toBe("reasoning-only");
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
    expect(classified.agentHarnessId).toBe("codex");
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
    ).resolves.toHaveProperty("compacted", true);
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
