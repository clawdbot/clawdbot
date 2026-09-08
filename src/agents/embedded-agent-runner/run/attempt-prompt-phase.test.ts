import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { persistHeartbeatOutcome } from "../../../infra/heartbeat-outcome-store.js";
import type { Context, Model, SimpleStreamOptions } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../../state/openclaw-agent-db.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import {
  estimateCompactionHistoryTokens,
  type CompactionRequestBudget,
} from "../../sessions/compaction/request-budget.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { SettingsManager } from "../../sessions/settings-manager.js";
import {
  getEmbeddedSessionPromptState,
  clearEmbeddedSessionPromptStates,
} from "../session-prompt-state.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";
import { buildRuntimeContextCustomMessage } from "./runtime-context-prompt.js";

const mocks = vi.hoisted(() => ({
  applyPromptToolsAllow: vi.fn(),
  beforeAgentRun: vi.fn(),
  handlePromptError: vi.fn(),
  handleMidTurnPrecheck: vi.fn(),
  observePrompt: vi.fn(),
  prepareGooglePromptCache: vi.fn(),
  preparePromptAssembly: vi.fn(),
  preparePromptContext: vi.fn(),
  preparePromptExecution: vi.fn(),
  preparePromptPreflight: vi.fn(),
  releasePendingSteering: vi.fn(),
  removeTrailingPrecheckError: vi.fn(),
  resolveApiKey: vi.fn(),
  submitPrompt: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../subagents/registry/subagent-registry.js", () => ({
  releasePendingAgentSteeringItems: mocks.releasePendingSteering,
  ackPendingAgentSteeringItems: vi.fn(),
}));
vi.mock("../google-prompt-cache.js", () => ({
  prepareGooglePromptCacheStreamFn: mocks.prepareGooglePromptCache,
}));
vi.mock("../logger.js", () => ({
  log: { debug: mocks.debug, warn: mocks.warn },
}));
vi.mock("../stream-resolution.js", () => ({
  resolveEmbeddedAgentApiKey() {
    return mocks.resolveApiKey();
  },
}));
vi.mock("./attempt-before-agent-run.js", () => ({
  runEmbeddedAttemptBeforeAgentRun: mocks.beforeAgentRun,
}));
vi.mock("./attempt-prompt-build.js", () => ({
  prepareEmbeddedAttemptPromptAssembly: mocks.preparePromptAssembly,
  prepareEmbeddedAttemptPromptContext: mocks.preparePromptContext,
}));
vi.mock("./attempt-prompt-submit.js", () => ({
  handleEmbeddedAttemptPromptError: mocks.handlePromptError,
  submitEmbeddedAttemptPrompt: mocks.submitPrompt,
}));
vi.mock("./prompt-image-preparation.js", () => ({
  prepareEmbeddedAttemptPromptExecution: mocks.preparePromptExecution,
}));
vi.mock("./attempt-prompt-preflight.js", () => ({
  handleEmbeddedAttemptMidTurnPrecheck: mocks.handleMidTurnPrecheck,
  prepareEmbeddedAttemptPromptPreflight: mocks.preparePromptPreflight,
}));
vi.mock("./attempt-prompt-support.js", () => ({
  applyPromptBuildToolsAllow: mocks.applyPromptToolsAllow,
  observeEmbeddedAttemptPrompt: mocks.observePrompt,
}));
vi.mock("./attempt-transcript-helpers.js", () => ({
  removeTrailingMidTurnPrecheckAssistantError: mocks.removeTrailingPrecheckError,
}));

import {
  projectAgentRunAttemptTerminal,
  type AgentRunAttemptTerminal,
} from "../../agent-run-terminal-outcome.js";
import { abortable } from "./abortable.js";
import {
  runEmbeddedAttemptPromptPhase,
  type EmbeddedAttemptPromptState,
} from "./attempt-prompt-phase.js";
import type { prepareEmbeddedAttemptPromptPreflight } from "./attempt-prompt-preflight.js";
import type { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";

type PromptPhaseInput = Parameters<typeof runEmbeddedAttemptPromptPhase>[0];
type AssemblyCall = {
  applyPromptBuildToolsAllow: (toolsAllow: string[] | undefined) => string[];
  setLeasedSteering: (lease: { leaseId: string; runIds: string[] }) => void;
};
type PromptPreflightCall = Parameters<typeof prepareEmbeddedAttemptPromptPreflight>[0];
type PromptSubmissionCall = Parameters<typeof submitEmbeddedAttemptPrompt>[0];
type PromptErrorCall = {
  error: unknown;
  markYieldAborted: () => void;
  releaseLeasedSteering: (error?: unknown) => void;
  yieldAbortSettled: Promise<void> | null;
  yieldDetected: boolean;
  yieldMessage: string | null;
};

const tempStateDirs: string[] = [];

function createFixture({ pendingPrompt = "hello", pendingImageCount = 1 } = {}) {
  const order: string[] = [];
  const promptState: EmbeddedAttemptPromptState = {
    contextBudgetStatus: undefined,
    preflightRecovery: undefined,
    promptCacheChangesForTurn: null,
    yieldAborted: false,
  };
  const executionState: PromptPhaseInput["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const yieldState = {
    yieldAbortSettled: null as Promise<void> | null,
    yieldDetected: false,
    yieldMessage: null as string | null,
  };
  const activeSession = {
    messages: [],
    agent: {
      state: { messages: [] },
      streamFn: vi.fn(),
    },
  };
  const sessionManager = {
    appendCustomEntry: vi.fn(),
    getEntries: vi.fn(() => []),
  };
  const sessionRuntimeState = { systemPromptText: "system", prePromptMessageCount: 1 };
  const stopAcceptingSteerMessages = vi.fn(() => {
    order.push("stop-steering");
  });

  mocks.preparePromptAssembly.mockImplementation(async (input: AssemblyCall) => {
    order.push("assembly");
    const lease = { leaseId: "lease-1", runIds: ["run-1"] };
    input.applyPromptBuildToolsAllow(undefined);
    input.setLeasedSteering(lease);
    return {
      hookCtx: {},
      promptCacheChangesForTurn: [],
      leasedSteering: lease,
      transcriptLeafId: "leaf-1",
    };
  });
  mocks.preparePromptContext.mockImplementation(() => {
    order.push("context");
    return {
      aggregatePressureEngaged: false,
      contextTokenBudget: 32_000,
      currentUserTimestampOverride: { timestamp: 123, text: "hello" },
      effectivePrompt: "hello",
      hookMessagesForCurrentPrompt: [],
      llmBoundaryPromptForPrecheck: pendingPrompt,
      prePromptMessageCount: 2,
      promptForModel: "hello",
      promptForSession: "hello",
      promptSubmission: { prompt: "hello", runtimeOnly: false },
      promptToolResultAggregateMaxChars: 2_000,
      promptToolResultMaxChars: 1_000,
      runtimeContextMessageForCurrentTurn: { role: "custom", content: "runtime" },
      systemPromptForHook: "system",
    };
  });
  mocks.beforeAgentRun.mockImplementation(async () => {
    order.push("before-agent-run");
    return undefined;
  });
  mocks.resolveApiKey.mockResolvedValue("test-key");
  mocks.prepareGooglePromptCache.mockImplementation(async () => {
    order.push("google-cache");
    return undefined;
  });
  mocks.preparePromptExecution.mockImplementation(async () => {
    order.push("images");
    return {
      images: Array.from({ length: pendingImageCount }, () => ({
        type: "image",
        data: "aW1hZ2U=",
        mimeType: "image/png",
      })),
      imageFactIndexes: [null],
      detectedRefs: [],
      failedMediaCount: 0,
      loadedCount: 1,
      skippedCount: 0,
    };
  });
  mocks.observePrompt.mockImplementation(() => {
    order.push("observe");
    return { skipPromptSubmission: false };
  });
  mocks.preparePromptPreflight.mockImplementation(async (preflightInput: PromptPreflightCall) => {
    order.push("preflight");
    return preflightInput.state;
  });
  mocks.submitPrompt.mockImplementation(async (submissionInput: PromptSubmissionCall) => {
    order.push("submit");
    submissionInput.onFinalPromptText("hello");
    submissionInput.onSteeringAcknowledged();
  });
  mocks.handlePromptError.mockResolvedValue({});
  const input = {
    attempt: {
      model: { id: "model-1", provider: "test" },
      modelId: "model-1",
      provider: "test",
      runId: "run-1",
      sessionId: "session-1",
    },
    isRawModelRun: false,
    runAbortController: new AbortController(),
    state: executionState,
    sessionLock: {
      withOwnedTranscriptWrite: async <T>(operation: () => Promise<T> | T) => await operation(),
    },
    setup: {
      effectiveFsWorkspaceOnly: false,
      effectiveWorkspace: "/tmp/workspace",
      sandbox: null,
      sessionAgentId: "main",
    },
    diagnostics: { diagnosticTrace: {}, runTrace: {} },
    prepared: {
      sessionRuntime: {
        agentSession: {
          activeSession,
          hookRunner: null,
          setActiveSessionSystemPrompt: vi.fn(),
          settingsManager: { getCompactionReserveTokens: () => 77 },
        },
        boundary: {
          includeBoundaryTimestamp: false,
          setCurrentUserTimestampOverride: vi.fn(),
        },
        cacheTrace: null,
        contextGuards: { takePendingMidTurnPrecheckRequest: () => undefined },
        preparedUserTurnMessage: {
          role: "user",
          content: "hello",
          timestamp: 100,
          __openclaw: { senderName: "Alice" },
        },
        sessionManager,
        sessionPromptState: {},
        state: sessionRuntimeState,
        toolResultPromptProjectionState: {},
        trajectoryRecorder: null,
        transcriptPolicy: { appendOnlyRuntimeContext: true },
        transport: {
          effectiveAgentTransport: "sse",
          effectiveExtraParams: {},
          streamStrategy: "default",
          compactionReplayEnabled: false,
        },
      },
      systemPrompt: { runtimeInfo: { model: "model-1" } },
      toolCatalog: { toolSearch: { compacted: false } },
      promptToolPolicy: {
        current: {
          activeToolNames: ["read"],
          effectiveTools: [{ name: "read" }],
          uncompactedEffectiveTools: [{ name: "read" }],
          tools: [{ name: "read" }],
        },
        apply(toolsAllow: string[] | undefined) {
          Object.assign(this.current, mocks.applyPromptToolsAllow({ toolsAllow }));
          return this.current;
        },
        refresh: vi.fn(),
      },
    },
    preparedStreamRuntime: {
      cache: {},
      history: {
        contextEngineAssemblySucceeded: false,
        contextEnginePromptAuthority: "assembled",
      },
      promptActiveSession: vi.fn(),
      stream: { stopAcceptingSteerMessages },
    },
    lifecycle: { readYieldState: () => yieldState },
  } as unknown as PromptPhaseInput;

  return {
    input,
    order,
    promptState,
    sessionRuntimeState,
    readState: () => ({
      ...promptState,
      ...projectAgentRunAttemptTerminal(executionState.terminal),
    }),
    yieldState,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.applyPromptToolsAllow.mockReturnValue({
    activeToolNames: ["read"],
    effectiveTools: [{ name: "read" }],
    uncompactedEffectiveTools: [{ name: "read" }],
    tools: [{ name: "read" }],
  });
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  vi.unstubAllEnvs();
  for (const stateDir of tempStateDirs.splice(0)) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

registerAgentSessionLoopTestLifecycle();
afterEach(() => {
  clearEmbeddedSessionPromptStates(["phase-context-replay"]);
});

describe("runEmbeddedAttemptPromptPhase", () => {
  it.each([
    { appendOnlyRuntimeContext: true, queued: false },
    { appendOnlyRuntimeContext: false, queued: false },
    { appendOnlyRuntimeContext: true, queued: true },
    { appendOnlyRuntimeContext: false, queued: true },
  ])(
    "budgets submitted context with a recorded carrier (appendOnly=$appendOnlyRuntimeContext, queued=$queued)",
    async ({ appendOnlyRuntimeContext, queued }) => {
      const fixture = createFixture({ pendingPrompt: "hello", pendingImageCount: 0 });
      const currentUser = {
        role: "user" as const,
        content: "hello",
        timestamp: 1,
        idempotencyKey: "current:user",
      };
      const oldCarrier = buildRuntimeContextCustomMessage("Previously recorded context");
      const nextCarrier = buildRuntimeContextCustomMessage(
        "New transient context. ".repeat(queued ? 1 : 200),
      );
      if (!oldCarrier || !nextCarrier) {
        throw new Error("Expected both runtime carriers");
      }
      const manager = SessionManager.inMemory();
      if (queued) {
        manager.appendMessage({
          role: "user",
          content: "Earlier project archive. ".repeat(1_500),
          timestamp: 1,
        });
        manager.appendMessage(
          createAssistant(testModel, [
            { type: "text", text: "Recorded project facts. ".repeat(900) },
          ]),
        );
        manager.appendMessage({
          role: "user",
          content: "Current project archive. ".repeat(1_500),
          timestamp: 3,
        });
        const priorInput = Math.ceil(
          JSON.stringify(
            manager.buildSessionContext().messages.map((message) => {
              if (message.role !== "user" && message.role !== "assistant") {
                throw new Error("Expected seeded user/assistant history");
              }
              return { role: message.role, content: message.content };
            }),
          ).length / 4,
        );
        const priorText = "Recorded current facts. ".repeat(800);
        const prior = createAssistant(
          testModel,
          [{ type: "text", text: priorText }],
          "stop",
          priorInput,
        );
        prior.usage.output = Math.ceil(priorText.length / 4);
        prior.usage.totalTokens = priorInput + prior.usage.output;
        prior.usage.contextUsage = {
          state: "available",
          promptTokens: priorInput,
          totalTokens: prior.usage.totalTokens,
        };
        expect(prior.usage.totalTokens).toBeGreaterThan(24_576);
        expect(prior.usage.totalTokens).toBeLessThan(testModel.contextWindow!);
        manager.appendMessage(prior);
      }
      manager.appendMessage(currentUser);
      manager.appendCustomMessageEntry(
        oldCarrier.customType,
        oldCarrier.content,
        oldCarrier.display,
        oldCarrier.details,
      );
      const { session, settingsManager } = await createTestSession({
        sessionManager: manager,
        ...(queued
          ? {
              settingsManager: SettingsManager.inMemory({
                compaction: { enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 },
                retry: { enabled: false },
              }),
            }
          : {}),
      });
      const queuedContext = "Queued project material. ".repeat(1_120).trim();
      const queuedMessage = {
        role: "custom" as const,
        customType: "test.ordinary-queued-context",
        content: queuedContext,
        display: false,
        timestamp: 1,
      };
      if (queued) {
        await session.sendCustomMessage(queuedMessage, { deliverAs: "nextTurn" });
      }
      const recorder = createUserTurnTranscriptRecorder({
        message: currentUser,
        target: () => undefined,
      });
      recorder.markRuntimePersisted(currentUser);
      const { sessionRuntime } = fixture.input.prepared;
      sessionRuntime.agentSession.activeSession = session;
      sessionRuntime.agentSession.settingsManager = settingsManager;
      sessionRuntime.sessionManager = manager;
      sessionRuntime.preparedUserTurnMessage = currentUser;
      sessionRuntime.state.systemPromptText = session.systemPrompt;
      fixture.input.attempt = {
        ...fixture.input.attempt,
        model: testModel,
        provider: testModel.provider,
        modelId: testModel.id,
        config: {},
        userTurnTranscriptRecorder: recorder,
      };
      fixture.input.attempt.sessionId = "phase-context-replay";
      const sessionPromptState = getEmbeddedSessionPromptState(fixture.input.attempt.sessionId);
      sessionRuntime.sessionPromptState = sessionPromptState;
      sessionRuntime.toolResultPromptProjectionState = sessionPromptState.toolResults;
      sessionRuntime.transcriptPolicy.appendOnlyRuntimeContext = appendOnlyRuntimeContext;
      fixture.input.preparedStreamRuntime.promptActiveSession = (prompt, options) =>
        session.prompt(prompt, options);
      await prepareEmbeddedAttemptSessionBoundary({
        activeSession: session,
        appendOnlyRuntimeContext,
        attempt: fixture.input.attempt,
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: currentUser,
        sessionManager: manager,
        setActiveSessionSystemPrompt: (prompt) => {
          session.agent.state.systemPrompt = prompt;
        },
      });
      const context = mocks.preparePromptContext.getMockImplementation()!;
      mocks.preparePromptContext.mockImplementation((...args) => ({
        ...context(...args),
        contextTokenBudget: testModel.contextWindow,
        runtimeContextMessageForCurrentTurn: nextCarrier,
        systemPromptForHook: session.systemPrompt,
      }));
      const budgets: CompactionRequestBudget[] = [];
      fixture.input.attempt.onCompactionRequestBudget = (budget) => {
        if (budget) {
          budgets.push(budget);
        }
      };
      const { submitEmbeddedAttemptPrompt } = await vi.importActual<
        typeof import("./attempt-prompt-submit.js")
      >("./attempt-prompt-submit.js");
      mocks.submitPrompt.mockImplementation(submitEmbeddedAttemptPrompt);
      const requests: string[] = [];
      const requestTokens: number[] = [];
      streamMocks.streamSimple.mockImplementation(
        (model: Model, providerContext: Context, options?: SimpleStreamOptions) => {
          const wire = JSON.stringify({
            system: providerContext.systemPrompt,
            tools: providerContext.tools,
            messages: providerContext.messages.map(({ role, content }) => ({ role, content })),
          });
          const tokens = Math.ceil(wire.length / 4);
          const foreground = !session.isCompacting;
          if (foreground) {
            requests.push(JSON.stringify(providerContext.messages));
            requestTokens.push(tokens);
          }
          const text = foreground
            ? "done"
            : "Project archive summary. "
                .repeat(700)
                .slice(0, (options?.maxTokens ?? model.maxTokens) * 4);
          const response = createAssistant(model, [{ type: "text", text }], "stop", tokens);
          response.usage.output = Math.ceil(text.length / 4);
          response.usage.totalTokens = tokens + response.usage.output;
          response.usage.contextUsage = {
            state: "available",
            promptTokens: tokens,
            totalTokens: response.usage.totalTokens,
          };
          expect(response.usage.totalTokens).toBeLessThanOrEqual(model.contextWindow!);
          return createAssistantResultStream(response);
        },
      );

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(mocks.handlePromptError.mock.calls.map(([input]) => input.error)).toEqual([]);
      expect(fixture.readState().promptError).toBeNull();
      expect(requests).toHaveLength(1);
      if (queued) {
        const captured = budgets[0]!;
        const completePendingTokens =
          captured.pendingTokens + estimateCompactionHistoryTokens([queuedMessage]);
        expect(
          captured.contextWindow -
            captured.reserveTokens -
            captured.fixedTokens -
            completePendingTokens,
        ).toBeGreaterThan(0);
        expect(requests[0]).toContain(queuedContext);
        expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
        expect(requestTokens[0], JSON.stringify({ requestTokens, budgets })).toBeLessThanOrEqual(
          testModel.contextWindow! - settingsManager.getCompactionReserveTokens(),
        );
      }
      expect(requests[0]).toContain(
        appendOnlyRuntimeContext ? "Previously recorded context" : "New transient context.",
      );
      expect(requests[0]).not.toContain(
        appendOnlyRuntimeContext ? "New transient context." : "Previously recorded context",
      );
      if (appendOnlyRuntimeContext) {
        expect(budgets[0]?.pendingTokens).toBeLessThan(nextCarrier.content.length / 4);
      } else {
        expect(budgets[0]?.pendingTokens).toBeGreaterThan(nextCarrier.content.length / 4);
      }
      expect(budgets.at(-1)).toMatchObject({ pendingTokens: 0, pendingQueuedContextTokens: 0 });
    },
  );

  it.each([
    {
      persisted: true,
      skip: false,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: "current:user",
    },
    {
      persisted: true,
      skip: true,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: undefined,
    },
    {
      persisted: false,
      skip: false,
      pendingPrompt: "",
      pendingImageCount: 1,
      expectedKey: undefined,
    },
    {
      persisted: true,
      skip: false,
      pendingPrompt: "hello",
      pendingImageCount: 0,
      expectedKey: "current:user",
    },
  ])(
    "captures pending text/images and exact ingress identity (persisted=$persisted, skip=$skip, images=$pendingImageCount)",
    async ({ persisted, skip, pendingPrompt, pendingImageCount, expectedKey }) => {
      const fixture = createFixture({ pendingPrompt, pendingImageCount });
      const { activeSession } = fixture.input.prepared.sessionRuntime.agentSession;
      const currentUser = {
        role: "user" as const,
        content: pendingPrompt,
        timestamp: 1,
        idempotencyKey: "current:user",
      };
      const recorder = createUserTurnTranscriptRecorder({
        message: { ...currentUser, idempotencyKey: "draft:user" },
        target: async () => undefined,
      });
      if (persisted) {
        recorder.markRuntimePersisted(currentUser);
      }
      fixture.input.attempt.userTurnTranscriptRecorder = recorder;
      fixture.input.attempt.skipPreparedUserTurnMessage = skip;
      const budgets: CompactionRequestBudget[] = [];
      fixture.input.attempt.onCompactionRequestBudget = (budget) => {
        if (budget) {
          budgets.push(budget);
        }
      };
      const tool = {
        name: "read",
        label: "Read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
        execute: async () => ({ content: [], details: {} }),
      };
      activeSession.agent.state.tools = [tool];
      let compacting = false;
      Object.defineProperty(activeSession, "isCompacting", { get: () => compacting });
      mocks.preparePromptPreflight.mockImplementation(async (input: PromptPreflightCall) => {
        expect(budgets).toHaveLength(1);
        expect(budgets[0]).toMatchObject({ contextWindow: 32_000, reserveTokens: 77 });
        expect(budgets[0]?.pendingTokens).toBeGreaterThan(0);
        expect(budgets[0]?.pendingUserIdempotencyKey).toBe(expectedKey);
        return input.state;
      });
      mocks.submitPrompt.mockImplementation(async (submission: PromptSubmissionCall) => {
        expect(submission.compactionRequestBudget).toBe(budgets[0]);
        const model = fixture.input.attempt.model;
        const context = {
          systemPrompt: "Current foreground context. ".repeat(200),
          messages: [],
          tools: [{ ...tool, description: "Complete schema guidance. ".repeat(100) }],
        };
        await activeSession.agent.streamFn(model, context);
        expect(budgets).toHaveLength(2);
        expect(budgets[1]).toMatchObject({
          contextWindow: 32_000,
          reserveTokens: 77,
          pendingTokens: 0,
        });
        expect(budgets[1]?.fixedTokens).toBeGreaterThan(budgets[0]?.fixedTokens ?? 0);
        expect(budgets[1]?.pendingUserIdempotencyKey).toBeUndefined();
        compacting = true;
        await activeSession.agent.streamFn(
          { ...model, contextWindow: 200_000 },
          { systemPrompt: "Separate summarizer", messages: [], tools: [] },
        );
        expect(budgets).toHaveLength(2);
        compacting = false;
      });

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(fixture.readState().promptError).toBeNull();
    },
  );

  it("does not claim heartbeat outcomes for detached user-triggered runs", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-prompt-phase-heartbeat-"));
    tempStateDirs.push(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    await upsertSessionEntryCore(
      { agentId: "main", env: process.env, sessionKey: "agent:main:main" },
      { sessionId: "prompt-phase-heartbeat-test", updatedAt: 1 },
    );
    persistHeartbeatOutcome({
      agentId: "main",
      sessionKey: "agent:main:main",
      runSessionKey: "agent:main:main:heartbeat",
      response: { outcome: "progress", notify: false, summary: "Heartbeat context" },
      occurredAt: 1,
      env: process.env,
    });
    const fixture = createFixture();
    Object.assign(fixture.input.attempt, {
      sessionKey: "agent:main:main",
      sessionPersistence: "detached",
      trigger: "user",
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(mocks.preparePromptContext.mock.calls[0]?.[0]).not.toHaveProperty(
      "heartbeatOutcomeContext",
    );
    expect(
      openOpenClawAgentDatabase({ agentId: "main", env: process.env })
        .db.prepare("SELECT context_run_id, context_claimed_at FROM heartbeat_outcomes")
        .get(),
    ).toEqual({ context_run_id: null, context_claimed_at: null });
  });

  it("runs prompt work in phase order and publishes prompt outputs", async () => {
    const fixture = createFixture();

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: "leaf-1",
    });

    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "before-agent-run",
      "google-cache",
      "images",
      "observe",
      "preflight",
      "submit",
      "stop-steering",
    ]);
    expect(fixture.sessionRuntimeState.prePromptMessageCount).toBe(2);
    expect(fixture.promptState.promptCacheChangesForTurn).toEqual([]);
    expect(fixture.promptState.finalPromptText).toBe("hello");
    expect(mocks.preparePromptContext).toHaveBeenCalledWith(
      expect.objectContaining({
        appendOnlyRuntimeContext: true,
        preparedUserTurnMessage: expect.objectContaining({
          content: "hello",
          timestamp: 100,
          __openclaw: { senderName: "Alice" },
        }),
      }),
    );
    expect(mocks.preparePromptPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ appendOnlyRuntimeContext: true }),
    );
    expect(mocks.preparePromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello",
        skipPromptSubmission: false,
      }),
    );
    expect(mocks.observePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCount: 1,
        reserveTokens: 77,
        transcriptLeafId: "leaf-1",
      }),
    );
    expect(mocks.submitPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        images: [expect.objectContaining({ type: "image" })],
        appendOnlyRuntimeContext: true,
        leasedSteering: { leaseId: "lease-1", runIds: ["run-1"] },
        modelPrompt: "hello",
        runtimeContextMessage: expect.objectContaining({ content: "runtime" }),
        transcriptLeafId: "leaf-1",
        transcriptPrompt: "hello",
      }),
    );
    expect(mocks.releasePendingSteering).not.toHaveBeenCalled();
  });

  it("skips before_agent_run for settled-turn finalization", async () => {
    const fixture = createFixture();
    fixture.input.attempt.operation = "settled-tool-finalization";

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(mocks.beforeAgentRun).not.toHaveBeenCalled();
    expect(fixture.order).toEqual([
      "assembly",
      "context",
      "google-cache",
      "images",
      "observe",
      "preflight",
      "submit",
      "stop-steering",
    ]);
  });

  it("honors a tool-policy failure published during prompt assembly", async () => {
    const fixture = createFixture();
    const failure = new Error("explicit tool allowlist is empty");
    mocks.applyPromptToolsAllow.mockImplementationOnce(() => {
      fixture.input.prepared.toolCatalog.emptyExplicitToolAllowlistError = failure;
      return fixture.input.prepared.promptToolPolicy.current;
    });
    mocks.observePrompt.mockImplementationOnce((input: { skipPromptSubmission: boolean }) => ({
      skipPromptSubmission: input.skipPromptSubmission,
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(failure);
    expect(fixture.readState().promptErrorSource).toBe("precheck");
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ error: failure.message, leaseId: "lease-1" }),
    );
  });

  it("admits the provider prompt when aggregate projection pressure is only heuristic", async () => {
    const fixture = createFixture();
    const preparePromptContext = mocks.preparePromptContext.getMockImplementation();
    mocks.preparePromptContext.mockImplementation(() => ({
      ...(preparePromptContext?.() as Record<string, unknown>),
      aggregatePressureEngaged: true,
    }));

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(mocks.preparePromptExecution).toHaveBeenCalledWith(
      expect.objectContaining({ skipPromptSubmission: false }),
    );
    expect(mocks.submitPrompt).toHaveBeenCalledOnce();
  });

  it("reads yield state after submission fails and publishes abort state before recovery", async () => {
    const fixture = createFixture();
    const submissionError = new Error("submission failed");
    const yieldAbortSettled = Promise.resolve();
    mocks.submitPrompt.mockImplementation(async () => {
      fixture.order.push("submit");
      fixture.yieldState.yieldDetected = true;
      fixture.yieldState.yieldAbortSettled = yieldAbortSettled;
      fixture.yieldState.yieldMessage = "yield context";
      throw submissionError;
    });
    mocks.handlePromptError.mockImplementation(async (input: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(input.yieldDetected).toBe(true);
      expect(input.yieldAbortSettled).toBe(yieldAbortSettled);
      expect(input.yieldMessage).toBe("yield context");
      input.releaseLeasedSteering(input.error);
      input.markYieldAborted();
      expect(fixture.readState()).toMatchObject({ aborted: false, cleanupYieldAborted: true });
      return {};
    });

    await expect(
      runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState),
    ).resolves.toEqual({
      promptStartedAt: expect.any(Number),
      transcriptLeafId: "leaf-1",
    });

    expect(fixture.order.slice(-3)).toEqual(["submit", "prompt-error", "stop-steering"]);
    expect(fixture.promptState.yieldAborted).toBe(true);
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({ leaseId: "lease-1", runIds: ["run-1"] }),
    );
  });

  it.each([
    { kind: "timeout", phase: "prompt", source: "external" },
    { kind: "aborted", source: "external" },
  ] satisfies AgentRunAttemptTerminal[])(
    "preserves an external $kind when yield cleanup observes the same unwind",
    async (terminal) => {
      const fixture = createFixture();
      fixture.input.state.terminal = terminal;
      mocks.submitPrompt.mockRejectedValueOnce(new Error("yield unwind"));
      mocks.handlePromptError.mockImplementationOnce(async (input: PromptErrorCall) => {
        input.markYieldAborted();
        expect(fixture.input.state.terminal).toEqual(terminal);
        return {};
      });

      await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

      expect(fixture.input.state.terminal).toEqual(terminal);
      expect(fixture.promptState.yieldAborted).toBe(true);
    },
  );

  it("keeps a run-budget timeout failure-free for partial-output salvage", async () => {
    const fixture = createFixture();
    fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
    fixture.input.runAbortController.abort(new Error("request timed out"));
    const timeoutAbort = await abortable(
      fixture.input.runAbortController.signal,
      Promise.resolve(),
    ).catch((error: unknown) => error);
    mocks.submitPrompt.mockRejectedValueOnce(timeoutAbort);
    mocks.handlePromptError.mockResolvedValueOnce({
      promptFailure: { error: timeoutAbort, source: "prompt" },
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBeNull();
    expect(fixture.readState().promptErrorSource).toBeNull();
  });

  it("records a provider failure that races a run-budget timeout", async () => {
    const fixture = createFixture();
    const providerError = new Error("provider failed");
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.input.state.terminal = { kind: "timeout", phase: "prompt", source: "run_budget" };
      fixture.input.runAbortController.abort(new Error("request timed out"));
      throw providerError;
    });
    mocks.handlePromptError.mockResolvedValueOnce({
      promptFailure: { error: providerError, source: "prompt" },
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(providerError);
    expect(fixture.readState().promptErrorSource).toBe("prompt");
  });

  it("releases steering when preflight skips provider submission", async () => {
    const fixture = createFixture();
    const promptError = new Error("preflight rejected");
    mocks.preparePromptExecution.mockResolvedValueOnce({
      images: [],
      imageFactIndexes: [],
      detectedRefs: [],
      failedMediaCount: 1,
      loadedCount: 0,
      skippedCount: 1,
    });
    mocks.observePrompt.mockImplementationOnce(() => {
      fixture.order.push("observe");
      return { skipPromptSubmission: true };
    });
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.readState().promptError).toBe(promptError);
    expect(mocks.releasePendingSteering).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "preflight rejected",
        leaseId: "lease-1",
        runIds: ["run-1"],
      }),
    );
    expect(mocks.submitPrompt).not.toHaveBeenCalled();
  });

  it("publishes preflight state before a submission failure", async () => {
    const fixture = createFixture();
    const promptError = new Error("admission warning");
    const submitError = new Error("provider failed");
    mocks.preparePromptPreflight.mockImplementationOnce(
      async (preflightInput: PromptPreflightCall) => {
        fixture.order.push("preflight");
        return {
          ...preflightInput.state,
          promptError,
          promptErrorSource: "precheck",
        };
      },
    );
    mocks.submitPrompt.mockImplementationOnce(async () => {
      fixture.order.push("submit");
      expect(fixture.readState().promptError).toBe(promptError);
      throw submitError;
    });
    mocks.handlePromptError.mockImplementationOnce(async (errorInput: PromptErrorCall) => {
      fixture.order.push("prompt-error");
      expect(errorInput.error).toBe(submitError);
      return {};
    });

    await runEmbeddedAttemptPromptPhase(fixture.input, fixture.promptState);

    expect(fixture.order.slice(-4)).toEqual([
      "preflight",
      "submit",
      "prompt-error",
      "stop-steering",
    ]);
  });
});
