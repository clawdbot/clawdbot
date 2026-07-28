// Verifies harness lifecycle capability checks, diagnostics, and trace scoping.
import type { Model } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import type { ContextEngine } from "../../context-engine/types.js";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticEventPrivateData,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  getActiveDiagnosticTraceContext,
  resetDiagnosticTraceContextForTest,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { createOpenClawAgentHarness } from "./builtin-openclaw.js";
import { runAgentHarnessLifecycleAttempt } from "./lifecycle.js";
import type { AgentHarness, AgentHarnessAttemptParams } from "./types.js";

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
    model: { id: "gpt-5.4", provider: "codex" } as Model,
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

function createContextEngineRequiringAssembly(): ContextEngine {
  // Requires the harness to advertise assemble-before-prompt. Tests use this
  // to prove context-engine capabilities are enforced before runAttempt.
  return {
    info: {
      id: "lossless-claw",
      name: "Lossless",
      hostRequirements: {
        "agent-run": {
          requiredCapabilities: ["assemble-before-prompt"],
        },
      },
    },
    async ingest() {
      return { ingested: true };
    },
    async assemble({ messages }) {
      return { messages, estimatedTokens: 0 };
    },
    async compact() {
      return { ok: true, compacted: false };
    },
  };
}

async function flushDiagnosticEvents(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

function captureDiagnosticEvents(
  filter: (event: DiagnosticEventPayload) => boolean = (event) =>
    event.type.startsWith("harness.run."),
): {
  events: Array<{
    event: DiagnosticEventPayload;
    metadata: DiagnosticEventMetadata;
    privateData: DiagnosticEventPrivateData;
  }>;
  unsubscribe: () => void;
} {
  const events: Array<{
    event: DiagnosticEventPayload;
    metadata: DiagnosticEventMetadata;
    privateData: DiagnosticEventPrivateData;
  }> = [];
  const unsubscribe = onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
    if (filter(event)) {
      events.push({ event, metadata, privateData });
    }
  });
  return { events, unsubscribe };
}

describe("AgentHarness lifecycle runner", () => {
  afterEach(() => {
    resetDiagnosticEventsForTest();
    resetDiagnosticTraceContextForTest();
  });

  it("runs a harness attempt without changing attempt params", async () => {
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

    const attemptResult = await runAgentHarnessLifecycleAttempt(harness, params);

    expect(attemptResult).toEqual({ ...result, agentHarnessId: "codex" });
    expect(runAttempt).toHaveBeenCalledWith(params);
  });

  it("rejects harnesses that do not advertise required context-engine capabilities", async () => {
    const params = createAttemptParams();
    params.contextEngine = createContextEngineRequiringAssembly();
    const runAttempt = vi.fn(async () => createAttemptResult());
    const harness: AgentHarness = {
      id: "custom",
      label: "Custom",
      supports: () => ({ supported: true }),
      runAttempt,
    };

    await expect(runAgentHarnessLifecycleAttempt(harness, params)).rejects.toThrow(
      'Context engine "lossless-claw" cannot run operation "agent-run" on agent harness "custom".',
    );
    expect(runAttempt).not.toHaveBeenCalled();
  });

  it("allows harnesses that advertise required context-engine capabilities", async () => {
    const params = createAttemptParams();
    params.contextEngine = createContextEngineRequiringAssembly();
    const result = createAttemptResult();
    const runAttempt = vi.fn(async () => result);
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      contextEngineHostCapabilities: ["assemble-before-prompt"],
      supports: () => ({ supported: true }),
      runAttempt,
    };

    await expect(runAgentHarnessLifecycleAttempt(harness, params)).resolves.toEqual({
      ...result,
      agentHarnessId: "codex",
    });
    expect(runAttempt).toHaveBeenCalledOnce();
  });

  it("advertises OpenClaw embedded host capabilities", async () => {
    const harness = createOpenClawAgentHarness();

    expect(harness.contextEngineHostCapabilities).toEqual(
      OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
    );
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
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleAttempt(harness, params);
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    // Harness diagnostics are internal lifecycle facts, so metadata must stay
    // trusted while the payload preserves enough fields for downstream traces.
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

  it("scopes plugin harness run diagnostics under a child run trace", async () => {
    resetDiagnosticEventsForTest();
    const params = createAttemptParams();
    params.messageChannel = undefined;
    params.messageProvider = "discord-voice";
    const harnessTrace = createDiagnosticTrace();
    const result = createAttemptResult();
    result.diagnosticTrace = undefined;
    let attemptResult: EmbeddedRunAttemptResult | undefined;
    let runAttemptTrace: DiagnosticTraceContext | undefined;
    let classifyTrace: DiagnosticTraceContext | undefined;
    const classify = vi.fn<NonNullable<AgentHarness["classify"]>>(() => {
      classifyTrace = getActiveDiagnosticTraceContext();
      return "ok";
    });
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        runAttemptTrace = getActiveDiagnosticTraceContext();
        return result;
      },
      classify,
    };
    const diagnostics = captureDiagnosticEvents(
      (event) =>
        event.type === "harness.run.started" ||
        event.type === "run.started" ||
        event.type === "run.completed" ||
        event.type === "harness.run.completed",
    );
    try {
      attemptResult = await runWithDiagnosticTraceContext(harnessTrace, () =>
        runAgentHarnessLifecycleAttempt(harness, params),
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events.map(({ event }) => event.type)).toEqual([
      "harness.run.started",
      "run.started",
      "run.completed",
      "harness.run.completed",
    ]);
    expect(diagnostics.events.every(({ metadata }) => metadata.trusted)).toBe(true);
    const runStarted = diagnostics.events[1]?.event as
      | (DiagnosticEventPayload & { trace?: DiagnosticTraceContext })
      | undefined;
    const runCompleted = diagnostics.events[2]?.event as
      | (DiagnosticEventPayload & {
          channel?: string;
          trace?: DiagnosticTraceContext;
          outcome?: string;
        })
      | undefined;
    const harnessCompleted = diagnostics.events[3]?.event as
      | (DiagnosticEventPayload & { channel?: string; trace?: DiagnosticTraceContext })
      | undefined;
    expect(runStarted?.trace?.traceId).toBe(harnessTrace.traceId);
    expect(runStarted?.trace?.parentSpanId).toBe(harnessTrace.spanId);
    expect(runAttemptTrace).toEqual(runStarted?.trace);
    expect(classifyTrace).toEqual(runStarted?.trace);
    expect(runCompleted?.trace).toEqual(runStarted?.trace);
    expect(runCompleted?.outcome).toBe("completed");
    expect(runCompleted?.channel).toBe("discord-voice");
    expect(harnessCompleted?.trace).toEqual(harnessTrace);
    expect(harnessCompleted?.channel).toBe("discord-voice");
    expect(attemptResult?.diagnosticTrace).toEqual(harnessTrace);
  });

  it("keeps plugin harness failure messages on the trusted private channel", async () => {
    const params = createAttemptParams();
    const harnessTrace = createDiagnosticTrace();
    const result = {
      ...createAttemptResult(),
      promptError: new Error("provider stream failed"),
    } as EmbeddedRunAttemptResult;
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents(
      (event) => event.type === "run.completed" || event.type === "harness.run.completed",
    );
    try {
      await runWithDiagnosticTraceContext(harnessTrace, () =>
        runAgentHarnessLifecycleAttempt(harness, params),
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    expect(diagnostics.events.map(({ event }) => event.type)).toEqual([
      "run.completed",
      "harness.run.completed",
    ]);
    for (const { event, privateData } of diagnostics.events) {
      expect(event).not.toHaveProperty("error");
      expect(privateData.errorMessage).toBe("provider stream failed");
    }
  });

  it("emits plugin before-agent-run hook blocks as blocked run completions", async () => {
    resetDiagnosticEventsForTest();
    const params = createAttemptParams();
    const harnessTrace = createDiagnosticTrace();
    const result = {
      ...createAttemptResult(),
      promptError: new Error("blocked by policy"),
      promptErrorSource: "hook:before_agent_run",
    } as EmbeddedRunAttemptResult;
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents((event) => event.type === "run.completed");
    try {
      await runWithDiagnosticTraceContext(harnessTrace, () =>
        runAgentHarnessLifecycleAttempt(harness, params),
      );
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    const completed = diagnostics.events[0]?.event as
      | (DiagnosticEventPayload & {
          blockedBy?: string;
          errorCategory?: string;
          outcome?: string;
        })
      | undefined;
    expect(completed?.outcome).toBe("blocked");
    expect(completed?.blockedBy).toBe("before_agent_run");
    expect(completed?.errorCategory).toBeUndefined();
  });

  it("emits trusted harness error diagnostics with the failing lifecycle phase", async () => {
    resetDiagnosticEventsForTest();
    const params = createAttemptParams();
    const sendError = new Error("codex app-server send failed");
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw sendError;
      },
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await expect(runAgentHarnessLifecycleAttempt(harness, params)).rejects.toThrow(
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
    expect(diagnostics.events[1]?.privateData.errorMessage).toBe("codex app-server send failed");
    expect(errorEvent).not.toHaveProperty("cleanupFailed");
    expect(errorEvent?.harnessId).toBe("codex");
    expect(typeof errorEvent?.durationMs).toBe("number");
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

    const outcome = await runAgentHarnessLifecycleAttempt(harness, params);

    expect(outcome.agentHarnessId).toBe("codex");
    expect(outcome.agentHarnessResultClassification).toBe("empty");
    expect(harness["classify"]).toHaveBeenCalledWith(result, params);
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

    const outcome = await runAgentHarnessLifecycleAttempt(harness, params);
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

    const classified = await runAgentHarnessLifecycleAttempt(harness, params);
    expect(classified.agentHarnessId).toBe("codex");
    expect(classified).not.toHaveProperty("agentHarnessResultClassification");
  });

  it("does not dispose harnesses after individual attempts", async () => {
    const dispose = vi.fn();
    const harness: AgentHarness = {
      id: "custom",
      label: "Custom",
      supports: () => ({ supported: true }),
      runAttempt: vi.fn(async () => createAttemptResult()),
      dispose,
    };

    await runAgentHarnessLifecycleAttempt(harness, createAttemptParams());

    expect(dispose).not.toHaveBeenCalled();
  });
});
