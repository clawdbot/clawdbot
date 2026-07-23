// Codex tests cover run attempt.hooks plugin behavior.
import path from "node:path";
import {
  abortAgentHarnessRun,
  onAgentEvent,
  resolveActiveEmbeddedRunSessionId,
  type AgentEventPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  onInternalDiagnosticEvent,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createMockPluginRegistry,
  onTrustedInternalDiagnosticEvent,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { GPT5_BEHAVIOR_CONTRACT as CODEX_GPT5_BEHAVIOR_CONTRACT } from "openclaw/plugin-sdk/provider-model-shared";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  assistantMessage,
  createAppServerHarness,
  createCodexRuntimePlanFixture,
  createParams,
  createStartedThreadHarness,
  fastWait,
  mockCall,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";

type ReplyBackend = Parameters<
  NonNullable<ReturnType<typeof createParams>["replyOperation"]>["attachBackend"]
>[0];

function flushDiagnosticEvents() {
  return waitForDiagnosticEventsDrained();
}

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt hooks and model diagnostics", () => {
  it.each([
    { label: "completed", status: "completed" as const, error: undefined },
    { label: "failed", status: "failed" as const, error: "codex exploded" },
  ])("defers $label lifecycle terminal ownership", async ({ status, error }) => {
    const onRunAgentEvent = vi.fn();
    const sessionFile = path.join(tempDir, `deferred-${status}.jsonl`);
    const workspaceDir = path.join(tempDir, `workspace-${status}`);
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.deferTerminalLifecycle = true;
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");

    if (status === "completed") {
      await harness.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "msg-1",
          delta: "hello back",
        },
      });
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    } else {
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            error: { message: error },
          },
        },
      });
    }
    await run;

    const lifecycleEvents = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.stream === "lifecycle");
    expect(lifecycleEvents.map((event) => event.data.phase)).toEqual(["start", "finishing"]);
    expect(lifecycleEvents[1]?.data.error).toBe(error);
  });

  it("fires llm_input, llm_output, and agent_end hooks for codex turns", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    const globalAgentEvents: AgentEventPayload[] = [];
    onAgentEvent((event) => globalAgentEvents.push(event));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const sessionManager = SessionManager.openFile(sessionFile);
    sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    expect(llmInput).toHaveBeenCalled();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const [llmInputPayload, llmInputContext] = mockCall(llmInput, "llm_input") as [
      {
        historyMessages?: Array<{ role?: string }>;
        imagesCount?: number;
        model?: string;
        prompt?: string;
        provider?: string;
        runId?: string;
        sessionId?: string;
        systemPrompt?: string;
      },
      { runId?: string; sessionId?: string; sessionKey?: string },
    ];
    expect(llmInputPayload.runId).toBe("run-1");
    expect(llmInputPayload.sessionId).toBe("session-1");
    expect(llmInputPayload.provider).toBe("codex");
    expect(llmInputPayload.model).toBe("gpt-5.4-codex");
    expect(llmInputPayload.prompt).toBe("hello");
    expect(llmInputPayload.imagesCount).toBe(0);
    expect(llmInputPayload.historyMessages).toEqual([]);
    expect(llmInputPayload.systemPrompt).toContain(
      "You are a personal agent running inside OpenClaw.",
    );
    expect(llmInputPayload.systemPrompt).not.toContain(CODEX_GPT5_BEHAVIOR_CONTRACT);
    expect(llmInputContext.runId).toBe("run-1");
    expect(llmInputContext.sessionId).toBe("session-1");
    expect(llmInputContext.sessionKey).toBe("agent:main:session-1");

    await harness.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "msg-1",
        delta: "hello back",
      },
    });
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(result.assistantTexts).toEqual(["hello back"]);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data: {
        endedAt?: number;
        phase?: string;
        startedAt?: number;
        text?: string;
      };
      stream: string;
    }>;
    const lifecycleStart = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    expect(typeof lifecycleStart?.data.startedAt).toBe("number");
    const assistantEvents = agentEvents.filter((event) => event.stream === "assistant");
    expect(assistantEvents).toHaveLength(2);
    expect(assistantEvents[0]?.data).toEqual({
      text: "hello back",
      delta: "hello back",
      replaceable: true,
    });
    expect(assistantEvents[1]?.data).toEqual({ text: "hello back" });
    const lifecycleEnd = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(typeof lifecycleEnd?.data.startedAt).toBe("number");
    expect(typeof lifecycleEnd?.data.endedAt).toBe("number");
    const startIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    const assistantIndex = agentEvents.findIndex((event) => event.stream === "assistant");
    const endIndex = agentEvents.findIndex(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(startIndex).toBeGreaterThanOrEqual(0);
    expect(assistantIndex).toBeGreaterThan(startIndex);
    expect(endIndex).toBeGreaterThan(assistantIndex);
    const globalAssistantEvents = globalAgentEvents.filter((event) => event.stream === "assistant");
    expect(globalAssistantEvents).toHaveLength(2);
    expect(globalAssistantEvents[0]?.runId).toBe("run-1");
    expect(globalAssistantEvents[0]?.sessionKey).toBe("agent:main:session-1");
    expect(globalAssistantEvents[0]?.data).toEqual({
      text: "hello back",
      delta: "hello back",
      replaceable: true,
    });
    expect(globalAssistantEvents[1]?.data).toEqual({ text: "hello back" });
    const globalEndEvent = globalAgentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "end",
    );
    expect(globalEndEvent?.runId).toBe("run-1");
    expect(globalEndEvent?.sessionKey).toBe("agent:main:session-1");

    const [llmOutputPayload, llmOutputContext] = mockCall(llmOutput, "llm_output") as [
      {
        assistantTexts?: string[];
        harnessId?: string;
        lastAssistant?: { role?: string };
        model?: string;
        provider?: string;
        resolvedRef?: string;
        runId?: string;
        sessionId?: string;
        contextTokenBudget?: number;
        contextWindowSource?: string;
        contextWindowReferenceTokens?: number;
      },
      {
        runId?: string;
        sessionId?: string;
        contextTokenBudget?: number;
        contextWindowSource?: string;
        contextWindowReferenceTokens?: number;
      },
    ];
    expect(llmOutputPayload.runId).toBe("run-1");
    expect(llmOutputPayload.sessionId).toBe("session-1");
    expect(llmOutputPayload.provider).toBe("codex");
    expect(llmOutputPayload.model).toBe("gpt-5.4-codex");
    expect(llmOutputPayload.contextTokenBudget).toBe(150_000);
    expect(llmOutputPayload.contextWindowSource).toBe("agentContextTokens");
    expect(llmOutputPayload.contextWindowReferenceTokens).toBe(200_000);
    expect(llmOutputPayload.resolvedRef).toBe("codex/gpt-5.4-codex");
    expect(llmOutputPayload.harnessId).toBe("codex");
    expect(llmOutputPayload.assistantTexts).toEqual(["hello back"]);
    expect(llmOutputPayload.lastAssistant?.role).toBe("assistant");
    expect(llmOutputContext.runId).toBe("run-1");
    expect(llmOutputContext.sessionId).toBe("session-1");
    expect(llmOutputContext.contextTokenBudget).toBe(150_000);
    expect(llmOutputContext.contextWindowSource).toBe("agentContextTokens");
    expect(llmOutputContext.contextWindowReferenceTokens).toBe(200_000);
    const [agentEndPayload, agentEndContext] = mockCall(agentEnd, "agent_end") as [
      { messages?: Array<{ role?: string }>; success?: boolean },
      { runId?: string; sessionId?: string },
    ];
    expect(agentEndPayload.success).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "user")).toBe(true);
    expect(agentEndPayload.messages?.some((message) => message.role === "assistant")).toBe(true);
    expect(agentEndContext.runId).toBe("run-1");
    expect(agentEndContext.sessionId).toBe("session-1");
  });

  it("emits gated model-call content diagnostics for codex turns", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const diagnosticContentByType = new Map<string, DiagnosticEventPrivateData>();
    const llmOutput = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "llm_output", handler: llmOutput }]),
    );
    const stopDiagnostics = onTrustedInternalDiagnosticEvent((event, _metadata, privateData) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
        diagnosticContentByType.set(event.type, privateData);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createAppServerHarness(async (method) => {
        if (method === "thread/start") {
          return threadStartResult();
        }
        if (method === "turn/start") {
          return {
            turn: {
              ...turnStartResult("turn-1", "completed").turn,
              items: [
                {
                  id: "msg-1",
                  type: "agentMessage",
                  text: "hello back",
                  status: "completed",
                },
              ],
            },
          };
        }
        return {};
      });
      const params = createParams(sessionFile, workspaceDir);
      const sessionManager = SessionManager.openFile(sessionFile);
      sessionManager.appendMessage(assistantMessage("existing context", Date.now()));
      params.runtimePlan = createCodexRuntimePlanFixture();
      params.config = {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            traces: true,
            captureContent: true,
          },
        },
      } as never;
      params.sessionId = "diagnostic-session-1";
      params.sessionKey = "agent:diagnostic:diagnostic-session-1";
      params.runId = "diagnostic-run-1";
      const run = runCodexAppServerAttempt(params, {
        nativeHookRelay: { enabled: false },
        turnCompletionIdleTimeoutMs: 5,
      });
      await harness.waitForMethod("turn/start");
      await run;
      await vi.waitFor(
        () =>
          expect(diagnosticEvents.some((event) => event.type === "model.call.completed")).toBe(
            true,
          ),
        fastWait,
      );

      const startedEvent = diagnosticEvents.find((event) => event.type === "model.call.started");
      const completed = diagnosticEvents.find((event) => event.type === "model.call.completed");
      const expectedCallId = "diagnostic-run-1:codex-model:1";
      expect(startedEvent).toMatchObject({ callId: expectedCallId, observationUnit: "turn" });
      expect(startedEvent?.trace?.traceId).toBeTypeOf("string");
      expect(JSON.stringify(startedEvent)).not.toContain("hello");
      const startedContent = diagnosticContentByType.get("model.call.started")?.modelContent;
      expect(JSON.stringify(startedContent?.inputMessages)).toContain("hello");
      expect(JSON.stringify(startedContent?.inputMessages)).not.toContain("existing context");
      expect(startedContent?.systemPrompt).toBeUndefined();
      expect(completed).toMatchObject({ callId: expectedCallId, observationUnit: "turn" });
      expect(JSON.stringify(completed)).not.toContain("hello back");
      expect(
        JSON.stringify(diagnosticContentByType.get("model.call.completed")?.modelContent),
      ).toContain("hello back");
      expect(completed?.requestPayloadBytes).toBeGreaterThan(0);
      expect(llmOutput).toHaveBeenCalledTimes(1);
      expect(diagnosticEvents.map((event) => event.type)).not.toContain("model.call.error");
    } finally {
      stopDiagnostics();
    }
  }, 240_000);

  it("classifies codex model-call timeout diagnostics", async () => {
    const diagnosticEvents: DiagnosticEventPayload[] = [];
    const stopDiagnostics = onInternalDiagnosticEvent((event) => {
      if (event.type.startsWith("model.call.")) {
        diagnosticEvents.push(event);
      }
    });
    try {
      const sessionFile = path.join(tempDir, "session.jsonl");
      const workspaceDir = path.join(tempDir, "workspace");
      const harness = createStartedThreadHarness();
      const params = createParams(sessionFile, workspaceDir);
      params.config = {
        diagnostics: { enabled: true, otel: { enabled: true, traces: true } },
      } as never;
      params.timeoutMs = 200;

      const run = runCodexAppServerAttempt(params, { turnCompletionIdleTimeoutMs: 5 });
      await harness.waitForMethod("turn/start");
      const result = await run;
      await flushDiagnosticEvents();

      const errorEvent = diagnosticEvents.find((event) => event.type === "model.call.error") as
        | ({ failureKind?: string; errorCategory?: string } & DiagnosticEventPayload)
        | undefined;
      expect(readAttemptTerminal(result).timedOut).toBe(true);
      expect(errorEvent?.failureKind).toBe("timeout");
      expect(errorEvent?.errorCategory).toBe("timeout");
    } finally {
      stopDiagnostics();
    }
  });

  it("waits for agent_end hooks before resolving local codex turns", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    let settled = false;
    void run.then(() => {
      settled = true;
    });

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });

    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);
    releaseAgentEnd();
    expect(readAttemptTerminal(await run).promptError).toBeNull();
    expect(settled).toBe(true);
  });

  it("freezes recovered timeout success locally before agent_end", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onRunAgentEvent = vi.fn();
    const params = createParams(
      path.join(tempDir, "session.jsonl"),
      path.join(tempDir, "workspace"),
    );
    params.onAgentEvent = onRunAgentEvent;
    params.timeoutMs = 200;
    const attachBackend = vi.fn();
    const detachBackend = vi.fn();
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend,
      detachBackend,
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      turnAssistantCompletionIdleTimeoutMs: 5,
      turnTerminalIdleTimeoutMs: 500,
    });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-final-1",
          type: "agentMessage",
          text: "Done.",
          status: "completed",
        },
      },
    });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    const [replyBackend] = mockCall(attachBackend, "reply backend") as [
      { isAbortable?: () => boolean },
    ];
    expect(replyBackend.isAbortable?.()).toBe(false);
    expect(abortAgentHarnessRun("session-1")).toBe(false);
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBe("session-1");
    releaseAgentEnd();

    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(true);
    expect(freezeAbort).not.toHaveBeenCalled();
    const terminalLifecycleEvents = onRunAgentEvent.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.stream === "lifecycle" &&
          (event.data.phase === "end" || event.data.phase === "error"),
      );
    expect(terminalLifecycleEvents).toHaveLength(1);
    expect(terminalLifecycleEvents[0]?.data).toMatchObject({ phase: "end" });
    expect(terminalLifecycleEvents[0]?.data.aborted).toBeUndefined();
    expect(detachBackend).toHaveBeenCalledWith(replyBackend);
    expect(resolveActiveEmbeddedRunSessionId("agent:main:session-1")).toBeUndefined();
  });

  it("freezes recovered client-close success locally before agent_end", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend: Pick<ReplyBackend, "isAbortable"> | undefined;
    const params = createParams(
      path.join(tempDir, "recovered-client-close.jsonl"),
      path.join(tempDir, "recovered-client-close-workspace"),
    );
    params.onAttemptAbort = onAttemptAbort;
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort: vi.fn(),
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          id: "msg-final-1",
          type: "agentMessage",
          text: "Done before restart.",
          status: "completed",
        },
      },
    });
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(false);
    expect(abortAgentHarnessRun("session-1")).toBe(false);
    expect(onAttemptAbort).not.toHaveBeenCalled();

    releaseAgentEnd();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      timedOut: false,
      promptError: null,
    });
    expect(result.assistantTexts).toEqual(["Done before restart."]);
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(true);
  });

  it("keeps a successful memory preflight cancellable for the main turn", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend: Pick<ReplyBackend, "cancel" | "isAbortable"> | undefined;
    const params = createParams(
      path.join(tempDir, "memory-preflight.jsonl"),
      path.join(tempDir, "memory-preflight-workspace"),
    );
    params.trigger = "memory";
    params.memoryFlushWritePath = "memory/notes.md";
    params.onAttemptAbort = onAttemptAbort;
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    expect(readAttemptTerminal(await run)).toMatchObject({
      aborted: false,
      promptError: null,
    });
    expect(freezeAbort).not.toHaveBeenCalled();
  });

  it("keeps replay-safe client-close recovery cancellable during agent_end", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend:
      | {
          isAbortable?: () => boolean;
          cancel: (reason: "restart" | "superseded" | "user_abort") => void;
        }
      | undefined;
    const params = createParams(
      path.join(tempDir, "replay-safe-client-close.jsonl"),
      path.join(tempDir, "replay-safe-client-close-workspace"),
    );
    params.onAttemptAbort = onAttemptAbort;
    const freezeAbort = vi.fn();
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort,
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, { turnTerminalIdleTimeoutMs: 60_000 });

    await harness.waitForMethod("turn/start");
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      promptError: "codex app-server client closed before turn completed",
    });
    expect(result.codexAppServerFailure).toMatchObject({
      kind: "client_closed_before_turn_completed",
      replaySafe: true,
    });
    expect(freezeAbort).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "failed",
      status: "failed",
      error: { message: "codex exploded" },
      expectedPromptError: "codex exploded",
      expectedClassification: undefined,
    },
    {
      label: "interrupted",
      status: "interrupted",
      error: undefined,
      expectedPromptError: null,
      expectedClassification: "empty",
    },
    {
      label: "empty completed",
      status: "completed",
      error: undefined,
      expectedPromptError: null,
      expectedClassification: "empty",
    },
  ] as const)(
    "keeps ordinary $label turns cancellable until the orchestrator settles",
    async ({ label, status, error, expectedPromptError, expectedClassification }) => {
      let releaseAgentEnd: () => void = () => undefined;
      const agentEndSettled = new Promise<void>((resolve) => {
        releaseAgentEnd = resolve;
      });
      const agentEnd = vi.fn(() => agentEndSettled);
      initializeGlobalHookRunner(
        createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
      );
      const onAttemptAbort = vi.fn();
      let replyBackend: Pick<ReplyBackend, "cancel" | "isAbortable"> | undefined;
      const params = createParams(
        path.join(tempDir, `ordinary-${label}-turn.jsonl`),
        path.join(tempDir, `ordinary-${label}-turn-workspace`),
      );
      params.onAttemptAbort = onAttemptAbort;
      const freezeAbort = vi.fn();
      params.replyOperation = {
        attachBackend: (backend: ReplyBackend) => {
          replyBackend = backend;
        },
        detachBackend: vi.fn(),
        freezeAbort,
      } as unknown as NonNullable<typeof params.replyOperation>;
      const harness = createStartedThreadHarness();
      const run = runCodexAppServerAttempt(params);

      await harness.waitForMethod("turn/start");
      await harness.notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: {
            id: "turn-1",
            status,
            ...(error ? { error } : {}),
          },
        },
      });
      await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

      expect(replyBackend?.isAbortable?.()).toBe(true);
      replyBackend?.cancel("user_abort");
      expect(onAttemptAbort).toHaveBeenCalledTimes(1);

      releaseAgentEnd();
      const result = await run;
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: false,
        promptError: expectedPromptError,
      });
      expect(result.agentHarnessResultClassification).toBe(expectedClassification);
      expect(freezeAbort).not.toHaveBeenCalled();
    },
  );

  it("keeps websocket client-close failure cancellable until the orchestrator settles", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const onAttemptAbort = vi.fn();
    let replyBackend:
      | {
          isAbortable?: () => boolean;
          cancel: (reason: "restart" | "superseded" | "user_abort") => void;
        }
      | undefined;
    const params = createParams(
      path.join(tempDir, "websocket-client-close.jsonl"),
      path.join(tempDir, "websocket-client-close-workspace"),
    );
    params.onAttemptAbort = onAttemptAbort;
    params.replyOperation = {
      attachBackend: (backend: ReplyBackend) => {
        replyBackend = backend;
      },
      detachBackend: vi.fn(),
      freezeAbort: vi.fn(),
    } as unknown as NonNullable<typeof params.replyOperation>;
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(params, {
      pluginConfig: {
        appServer: {
          transport: "websocket",
          url: "ws://127.0.0.1:39175",
        },
      },
      turnTerminalIdleTimeoutMs: 60_000,
    });

    await harness.waitForMethod("turn/start");
    harness.close();
    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);

    expect(replyBackend?.isAbortable?.()).toBe(true);
    replyBackend?.cancel("user_abort");
    expect(onAttemptAbort).toHaveBeenCalledTimes(1);

    releaseAgentEnd();
    const result = await run;
    expect(readAttemptTerminal(result)).toMatchObject({
      aborted: false,
      promptError: "codex app-server client closed before turn completed",
    });
    expect(result.codexAppServerFailure).toMatchObject({ transport: "websocket" });
  });

  it("clears a stale binding when completed-turn coverage persistence fails", async () => {
    const sessionFile = path.join(tempDir, "binding-coverage-failure.jsonl");
    const workspaceDir = path.join(tempDir, "binding-coverage-workspace");
    const harness = createStartedThreadHarness();
    const bindingStore = {
      ...testCodexAppServerBindingStore,
      mutate: vi.fn(async (...args: Parameters<typeof testCodexAppServerBindingStore.mutate>) => {
        const mutation = args[1];
        if (mutation.kind === "patch" && mutation.patch.historyCoveredThrough) {
          throw new Error("simulated binding coverage write failure");
        }
        return await testCodexAppServerBindingStore.mutate(...args);
      }),
    };
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir), { bindingStore });
    await harness.waitForMethod("turn/start");

    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    expect(readAttemptTerminal(await run)).toMatchObject({ promptError: null, aborted: false });
    expect(bindingStore.mutate).toHaveBeenCalled();
    await expect(readCodexAppServerBinding(sessionFile)).resolves.toBeUndefined();
  });

  it("does not wait for agent_end hooks before resolving channel-backed codex turns", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();
    const params = createParams(sessionFile, workspaceDir);
    params.messageChannel = "discord";
    params.messageProvider = "discord";
    const run = runCodexAppServerAttempt(params);

    await harness.waitForMethod("turn/start");
    await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
    const result = await run;

    expect(readAttemptTerminal(result).promptError).toBeNull();
    expect(agentEnd).toHaveBeenCalledTimes(1);
    releaseAgentEnd();
  });

  it("waits for agent_end hooks before rejecting local codex turn-start failures", async () => {
    let releaseAgentEnd: () => void = () => undefined;
    const agentEndSettled = new Promise<void>((resolve) => {
      releaseAgentEnd = resolve;
    });
    const agentEnd = vi.fn(() => agentEndSettled);
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });
    const run = runCodexAppServerAttempt(createParams(sessionFile, workspaceDir));
    let settled = false;
    void run.catch(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(agentEnd).toHaveBeenCalledTimes(1), fastWait);
    expect(settled).toBe(false);
    releaseAgentEnd();
    await expect(run).rejects.toThrow("turn start exploded");
    expect(settled).toBe(true);
  });

  it("fires agent_end with failure metadata when the codex turn fails", async () => {
    const agentEnd = vi.fn();
    const onRunAgentEvent = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    const harness = createStartedThreadHarness();

    const params = createParams(sessionFile, workspaceDir);
    params.onAgentEvent = onRunAgentEvent;
    const run = runCodexAppServerAttempt(params);
    await harness.waitForMethod("turn/start");
    await harness.notify({
      method: "turn/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "codex exploded" },
        },
      },
    });

    const result = await run;

    expect(readAttemptTerminal(result).promptError).toBe("codex exploded");
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const agentEvents = onRunAgentEvent.mock.calls.map(([event]) => event) as Array<{
      data: { endedAt?: number; error?: string; phase?: string; startedAt?: number };
      stream: string;
    }>;
    const startEvent = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "start",
    );
    expect(typeof startEvent?.data.startedAt).toBe("number");
    const errorEvent = agentEvents.find(
      (event) => event.stream === "lifecycle" && event.data.phase === "error",
    );
    expect(typeof errorEvent?.data.startedAt).toBe("number");
    expect(typeof errorEvent?.data.endedAt).toBe("number");
    expect(errorEvent?.data.error).toBe("codex exploded");
    expect(agentEvents.some((event) => event.stream === "assistant")).toBe(false);
    const [agentEndPayload, agentEndContext] = mockCall(agentEnd, "agent_end") as [
      { error?: string; success?: boolean },
      { runId?: string; sessionId?: string },
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe("codex exploded");
    expect(agentEndContext.runId).toBe("run-1");
    expect(agentEndContext.sessionId).toBe("session-1");
  });

  it("fires llm_output and agent_end when turn/start fails", async () => {
    const llmInput = vi.fn();
    const llmOutput = vi.fn();
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "llm_input", handler: llmInput },
        { hookName: "llm_output", handler: llmOutput },
        { hookName: "agent_end", handler: agentEnd },
      ]),
    );
    const sessionFile = path.join(tempDir, "session.jsonl");
    const workspaceDir = path.join(tempDir, "workspace");
    SessionManager.openFile(sessionFile).appendMessage(
      assistantMessage("existing context", Date.now()),
    );
    createStartedThreadHarness(async (method) => {
      if (method === "turn/start") {
        throw new Error("turn start exploded");
      }
      return undefined;
    });

    const params = createParams(sessionFile, workspaceDir);
    params.runtimePlan = createCodexRuntimePlanFixture();
    params.messageChannel = "discord";
    params.messageProvider = "discord-voice";
    params.senderId = "user-123";
    params.senderName = "Test User";
    params.senderUsername = "testuser";
    params.inputProvenance = {
      kind: "external_user",
      sourceChannel: "discord",
    };

    await expect(runCodexAppServerAttempt(params)).rejects.toThrow("turn start exploded");

    expect(llmInput).toHaveBeenCalledTimes(1);
    expect(llmOutput).toHaveBeenCalledTimes(1);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [llmOutputPayload] = mockCall(llmOutput, "llm_output") as [
      {
        assistantTexts?: string[];
        harnessId?: string;
        model?: string;
        provider?: string;
        resolvedRef?: string;
        runId?: string;
        sessionId?: string;
      },
      unknown,
    ];
    expect(llmOutputPayload.assistantTexts).toEqual([]);
    expect(llmOutputPayload.model).toBe("gpt-5.4-codex");
    expect(llmOutputPayload.provider).toBe("codex");
    expect(llmOutputPayload.resolvedRef).toBe("codex/gpt-5.4-codex");
    expect(llmOutputPayload.harnessId).toBe("codex");
    expect(llmOutputPayload.runId).toBe("run-1");
    expect(llmOutputPayload.sessionId).toBe("session-1");
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [
      { error?: string; messages?: Array<{ role?: string }>; success?: boolean },
      unknown,
    ];
    expect(agentEndPayload.success).toBe(false);
    expect(agentEndPayload.error).toBe("turn start exploded");
    expect(agentEndPayload.messages?.some((message) => message.role === "assistant")).toBe(true);
    const userMessage = agentEndPayload.messages?.find((message) => message.role === "user") as
      | {
          content?: unknown;
          provenance?: unknown;
          role?: string;
          senderId?: unknown;
          senderLabel?: unknown;
          senderName?: unknown;
          senderUsername?: unknown;
          sourceChannel?: unknown;
        }
      | undefined;
    expect(userMessage).toMatchObject({
      role: "user",
      content: "hello",
      sourceChannel: "discord",
      senderId: "user-123",
      senderName: "Test User",
      senderUsername: "testuser",
      senderLabel: "Test User (user-123)",
      provenance: {
        kind: "external_user",
        sourceChannel: "discord",
      },
    });
  });

  it("fires agent_end with success false when the codex turn is aborted", async () => {
    const agentEnd = vi.fn();
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "agent_end", handler: agentEnd }]),
    );
    const { waitForMethod } = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(
      createParams(path.join(tempDir, "session.jsonl"), path.join(tempDir, "workspace")),
      { pluginConfig: { appServer: { mode: "yolo" } } },
    );

    await waitForMethod("turn/start");
    expect(abortAgentHarnessRun("session-1")).toBe(true);

    const result = await run;
    expect(readAttemptTerminal(result).aborted).toBe(true);
    expect(agentEnd).toHaveBeenCalledTimes(1);
    const [agentEndPayload] = mockCall(agentEnd, "agent_end") as [{ success?: boolean }, unknown];
    expect(agentEndPayload.success).toBe(false);
  });
});
