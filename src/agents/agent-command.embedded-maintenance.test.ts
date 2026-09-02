/** Tests proactive embedded maintenance and final-reply lifecycle safety. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestRuntime,
  compactionTestState as state,
  findCompactionSessionEntry as findStoredSessionEntry,
  makeCompactionResult as makeResult,
  readCompactionLifecyclePhases as readLifecyclePhases,
  registerAgentCommandCompactionTestHooks,
  requireCompactionStorePath as requireStorePath,
  COMPACTION_ERROR,
  GATEWAY_INGRESS_ARGS,
} from "./agent-command.compaction.test-support.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent.js";
import { LiveSessionModelSwitchError } from "./live-model-switch-error.js";

const {
  appendTranscriptEvent,
  appendTranscriptMessage,
  createAgentRunRestartAbortError,
  loadSessionEntry,
  loadTranscriptEvents,
  patchSessionEntryCore,
  replaceSessionEntry,
  rotateAgentEventLifecycleGeneration,
} = compactionTestRuntime;

// Register hooks for this file, not as a cached support-module side effect.
registerAgentCommandCompactionTestHooks();

describe("agentCommand embedded maintenance", () => {
  it("compacts persisted embedded turns before final delivery with memory flush disabled", async () => {
    const storePath = requireStorePath();
    const sessionId = "embedded-proactive-compaction";
    const successorSessionId = "embedded-proactive-successor";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    const model = "gpt-5.6-luna";
    const text = "answer generated before proactive compaction";
    state.cfg = {
      ...state.cfg,
      agents: {
        defaults: {
          model: { primary: `openai/${model}` },
          models: { [`openai/${model}`]: {} },
          compaction: { mode: "safeguard", memoryFlush: { enabled: false } },
        },
      },
      models: {
        providers: {
          openai: {
            baseUrl: "https://example.test",
            api: "openai-responses",
            models: [
              {
                id: model,
                name: "GPT-5.6 Luna",
                reasoning: false,
                input: ["text"],
                contextWindow: 1_050_000,
                maxTokens: 128_000,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId, updatedAt: Date.now(), compactionCount: 4 },
    );
    const lastCallUsage = {
      input: 3,
      output: 26,
      cacheRead: 904_813,
      cacheWrite: 53,
      total: 904_895,
    };
    const completed = makeResult({ sessionId, text, runner: "embedded" });
    completed.meta.agentMeta = {
      sessionId,
      provider: "openai",
      model,
      agentHarnessId: "openclaw",
      contextTokens: 922_000,
      promptTokens: 904_869,
      usage: lastCallUsage,
      lastCallUsage,
    };
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      await params.userTurnTranscriptRecorder?.persistApproved();
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text }],
            api: "openai-responses",
            provider: "openai",
            model,
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              ...lastCallUsage,
              totalTokens: lastCallUsage.total,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
          cwd: state.workspaceDir,
        },
      );
      params.onSuccessfulAuthProfile?.({
        authProfileId: "openai:completed",
        authProfileIdSource: "user",
      });
      return completed;
    });
    state.runSessionCompactionIfNeededMock.mockImplementationOnce(async (params) => {
      expect(findStoredSessionEntry(sessionKey)).toMatchObject({
        pendingFinalDelivery: { kind: "replayable", text },
        totalTokens: 904_869,
        inputTokens: lastCallUsage.input,
        outputTokens: lastCallUsage.output,
        cacheRead: lastCallUsage.cacheRead,
        cacheWrite: lastCallUsage.cacheWrite,
      });
      expect(params).toMatchObject({
        agentHarnessId: "openclaw",
        promptForEstimate: "",
        followupRun: {
          run: {
            sessionId,
            provider: "openai",
            model,
            senderIsOwner: false,
            authProfileId: "openai:completed",
            authProfileIdSource: "user",
          },
        },
      });
      expect(params.authorize?.()).toBe(true);
      if (!params.sessionEntry || !params.sessionStore) {
        throw new Error("compaction fixture needs a persisted session");
      }
      const successor: SessionEntry = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        compactionCount: 5,
        totalTokens: 12_000,
        totalTokensFresh: true,
      };
      await replaceSessionEntry({ sessionKey, storePath }, successor);
      params.sessionStore[sessionKey] = successor;
      return successor;
    });

    await agentCommandFromGatewayIngress(
      {
        message: "Recall the marker.",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        channel: "discord",
        to: "discord:dm:123",
        accountId: "main",
        deliver: true,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
    );

    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledOnce();
    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({
          meta: expect.objectContaining({
            agentMeta: expect.objectContaining({
              sessionId: successorSessionId,
              compactionCount: 1,
              compactionTokensAfter: 12_000,
              promptTokens: 904_869,
              usage: lastCallUsage,
              lastCallUsage,
            }),
          }),
        }),
      }),
    );
    expect(state.deliveryFreshEntries.at(-1)?.sessionId).toBe(successorSessionId);
    expect(findStoredSessionEntry(sessionKey)).toMatchObject({
      sessionId: successorSessionId,
      totalTokens: 12_000,
      totalTokensFresh: true,
      inputTokens: lastCallUsage.input,
      outputTokens: lastCallUsage.output,
      cacheRead: lastCallUsage.cacheRead,
      cacheWrite: lastCallUsage.cacheWrite,
    });
    expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toBeUndefined();
  });

  it.each([
    {
      retry: "model context",
      replaceWriter: false,
      initialTokens: 42,
      currentContextSnapshot: { tokens: 95_000 },
    },
    {
      retry: "model context",
      replaceWriter: true,
      initialTokens: 42,
      currentContextSnapshot: { tokens: 95_000 },
    },
    {
      retry: "custody only after unknown compaction",
      replaceWriter: false,
      initialTokens: undefined,
      currentContextSnapshot: undefined,
    },
  ])(
    "keeps count-zero retry $retry on its retained writer (replacement=$replaceWriter)",
    async ({ replaceWriter, initialTokens, currentContextSnapshot }) => {
      const sessionId = "retry-context-owner";
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const storePath = requireStorePath();
      let retainedWriter: string | undefined;
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        const target = params.sessionTarget;
        const entry = target ? loadSessionEntry(target) : undefined;
        if (!target || !entry) {
          throw new Error("expected the first candidate owner");
        }
        retainedWriter = entry.activeWriterRunId;
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 1,
          currentContextSnapshot: { tokens: initialTokens },
          target: {
            ...target,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
        });
        throw new LiveSessionModelSwitchError({
          provider: params.providerOverride,
          model: params.modelOverride,
          authProfileId: "switched-profile",
          authProfileIdSource: "user",
        });
      });
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        const target = params.sessionTarget;
        if (!target) {
          throw new Error("expected the retry target");
        }
        if (replaceWriter) {
          await patchSessionEntryCore(target, () => ({
            activeWriterRunId: "replacement-writer",
            compactionCount: 7,
            totalTokens: 777,
            totalTokensFresh: true,
            totalTokensVersion: 1,
          }));
        }
        const entry = loadSessionEntry(target);
        if (!entry) {
          throw new Error("expected the retry owner");
        }
        params.onCompactionAccounting?.({
          kind: "durable",
          count: 0,
          ...(currentContextSnapshot ? { currentContextSnapshot } : {}),
          target: {
            ...target,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
        });
        const result = makeResult({ sessionId, text: "retry answer", runner: "embedded" });
        if (!currentContextSnapshot) {
          const usage = { input: 95_000, output: 10 };
          result.meta.agentMeta = {
            ...result.meta.agentMeta!,
            promptTokens: 95_000,
            usage,
            lastCallUsage: usage,
          };
        }
        return result;
      });

      await agentCommand({ message: "continue", sessionId, sessionKey });

      expect(state.runAgentAttemptMock).toHaveBeenCalledTimes(2);
      const stored = findStoredSessionEntry(sessionKey);
      expect(stored).toMatchObject({
        sessionId,
        compactionCount: replaceWriter ? 7 : 1,
        totalTokensFresh: replaceWriter || currentContextSnapshot !== undefined,
      });
      expect(stored?.totalTokens).toBe(replaceWriter ? 777 : currentContextSnapshot?.tokens);
      if (!currentContextSnapshot) {
        expect(stored).toMatchObject({ inputTokens: 95_000, outputTokens: 10 });
      }
      expect(loadSessionEntry({ sessionKey, storePath })?.activeWriterRunId).toBe(
        replaceWriter ? "replacement-writer" : retainedWriter,
      );
    },
  );

  const excludedEmbeddedRuns: Array<{
    name: string;
    opts?: Partial<Parameters<typeof agentCommand>[0]>;
    agentHarnessId?: string;
    meta?: Partial<EmbeddedAgentRunResult["meta"]>;
    compactionCount?: number;
    observeAuth?: boolean;
    enabled?: boolean;
  }> = [
    { name: "native harness ownership", agentHarnessId: "codex" },
    { name: "an unavailable auth selection", observeAuth: false },
    { name: "disabled proactive compaction", enabled: false },
    { name: "already completed in-run compaction", compactionCount: 1 },
    { name: "a yielded turn", meta: { yielded: true } },
    { name: "an aborted turn", meta: { aborted: true } },
    { name: "a heartbeat", opts: { bootstrapContextRunKind: "heartbeat" } },
    { name: "a raw model run", opts: { modelRun: true } },
    { name: "preserved user-facing state", opts: { preserveUserFacingSessionModelState: true } },
    { name: "hidden session effects", opts: { sessionEffects: "internal" } },
  ];
  it.each(excludedEmbeddedRuns)("does not add command compaction for $name", async (testCase) => {
    const sessionId = "excluded-embedded-compaction";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.cfg = {
      ...state.cfg,
      agents: {
        ...state.cfg?.agents,
        defaults: {
          ...state.cfg?.agents?.defaults,
          compaction: { enabled: testCase.enabled, memoryFlush: { enabled: false } },
        },
      },
    };
    const completed = makeResult({
      sessionId,
      text: "completed answer",
      runner: "embedded",
      agentHarnessId: testCase.agentHarnessId ?? "openclaw",
      compactionCount: testCase.compactionCount,
    });
    completed.meta = { ...completed.meta, ...testCase.meta };
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      if (testCase.compactionCount) {
        const target = params.sessionTarget;
        const entry = target ? loadSessionEntry(target) : undefined;
        if (!target || !entry) {
          throw new Error("expected the in-run compaction owner");
        }
        params.onCompactionAccounting?.({
          kind: "durable",
          count: testCase.compactionCount,
          currentContextSnapshot: { tokens: undefined },
          target: {
            ...target,
            lifecycleRevision: entry.lifecycleRevision,
            activeWriterRunId: entry.activeWriterRunId,
          },
        });
      }
      if (testCase.observeAuth !== false) {
        params.onSuccessfulAuthProfile?.({});
      }
      return completed;
    });

    await agentCommand({ message: "continue", sessionId, sessionKey, ...testCase.opts });

    expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
    expect(state.runCliTurnCompactionLifecycleMock).not.toHaveBeenCalled();
    if (testCase.observeAuth === false) {
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
    }
  });

  it("keeps an observed ambient auth selection and a memory-flush successor for compaction", async () => {
    const sessionId = "ambient-auth-compaction";
    const successorSessionId = "memory-flush-successor";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      return makeResult({
        sessionId,
        text: "answer",
        runner: "embedded",
        agentHarnessId: "openclaw",
      });
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      const successor = {
        ...params.sessionEntry,
        sessionId: successorSessionId,
        updatedAt: Date.now(),
      };
      await replaceSessionEntry({ sessionKey, storePath: requireStorePath() }, successor);
      return { sessionEntry: successor, outcome: "completed" };
    });

    await agentCommand({ message: "continue", sessionId, sessionKey });

    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledOnce();
    const compaction = state.runSessionCompactionIfNeededMock.mock.calls[0]?.[0];
    expect(compaction).toMatchObject({
      sessionEntry: { sessionId: successorSessionId },
      followupRun: { run: { sessionId: successorSessionId } },
    });
    expect(compaction?.followupRun.run.authProfileId).toBeUndefined();
    expect(compaction?.followupRun.run.authProfileIdSource).toBeUndefined();
  });

  it("keeps embedded transcript ownership and flushes once for gateway ingress", async () => {
    const storePath = requireStorePath();
    const sessionId = "embedded-projected-final";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
        totalTokens: 180_000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
      },
    );
    state.runAgentAttemptMock.mockImplementationOnce(async (attempt) => {
      if (!attempt.userTurnTranscriptRecorder) {
        throw new Error("missing embedded user-turn transcript recorder");
      }
      await attempt.userTurnTranscriptRecorder.persistApproved();
      await appendTranscriptMessage(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "[Thu 2026-08-13 16:39 PDT] OVERRIDE-OK" }],
            api: "ollama",
            provider: "ollama",
            model: "llama3.2:latest",
            timestamp: Date.now(),
          },
          cwd: state.workspaceDir,
        },
      );
      await appendTranscriptEvent(
        { agentId: "main", sessionId, sessionKey, storePath },
        {
          type: "custom",
          customType: "openclaw:bootstrap-context:full",
          data: { runId: "embedded-run" },
        },
      );
      return makeResult({
        sessionId,
        text: "OVERRIDE-OK",
        runner: "embedded",
      });
    });

    await agentCommandFromGatewayIngress(
      {
        message: "Reply with exactly: OVERRIDE-OK",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        allowModelOverride: false,
      },
      ...GATEWAY_INGRESS_ARGS,
    );

    const events = (await loadTranscriptEvents({
      agentId: "main",
      sessionId,
      storePath,
    })) as Array<{
      type?: unknown;
      customType?: unknown;
      message?: { role?: unknown; api?: unknown };
    }>;
    const assistantEvents = events.filter(
      (event) => event.type === "message" && event.message?.role === "assistant",
    );
    expect(assistantEvents).toHaveLength(1);
    expect(assistantEvents.filter((event) => event.message?.api === "cli")).toHaveLength(0);
    expect(
      events.filter(
        (event) =>
          event.type === "custom" && event.customType === "openclaw:bootstrap-context:full",
      ),
    ).toHaveLength(1);
    expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledOnce();
    expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionEntry: expect.objectContaining({ totalTokens: 180_000 }) }),
    );
  });

  it.each(
    (
      [
        ["restart-during-compaction", "reply owned by restart recovery"],
        ["restart-after-successful-compaction", "reply owned by restart recovery after compaction"],
        ["stale-during-compaction", "reply owned by the next gateway lifecycle"],
      ] as const
    ).flatMap(([phase, text]) =>
      (["cli", "embedded"] as const).map((runner) => ({ phase, text, runner })),
    ),
  )(
    "does not deliver or clear the pending final for $runner $phase",
    async ({ phase, text, runner }) => {
      const sessionId = `${runner}-${phase}`;
      const restart = phase !== "stale-during-compaction";
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const abortController = new AbortController();
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        if (runner === "embedded") {
          params.onSuccessfulAuthProfile?.({});
        }
        return makeResult({ sessionId, text, runner, agentHarnessId: "openclaw" });
      });
      const compact = async (params: { sessionEntry?: SessionEntry }) => {
        expect(params.sessionEntry).toMatchObject({
          pendingFinalDelivery: { kind: "replayable", text },
        });
        if (restart) {
          abortController.abort(createAgentRunRestartAbortError());
        } else {
          rotateAgentEventLifecycleGeneration();
        }
        if (phase === "restart-after-successful-compaction") {
          return params.sessionEntry;
        }
        throw new Error(COMPACTION_ERROR);
      };
      if (runner === "embedded") {
        state.runSessionCompactionIfNeededMock.mockImplementationOnce(compact);
      } else {
        state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(compact);
      }

      await expect(
        agentCommand({
          message: "room message",
          sessionId,
          sessionKey,
          cwd: state.workspaceDir,
          channel: "discord",
          to: "discord:dm:123",
          accountId: "main",
          deliver: true,
          abortSignal: abortController.signal,
        }),
      ).rejects.toThrow(
        restart
          ? "agent run aborted for restart"
          : "Agent run belongs to a stale gateway lifecycle",
      );

      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
      expect(findStoredSessionEntry(sessionKey)).toMatchObject({
        pendingFinalDelivery: { kind: "replayable", text },
      });
    },
  );

  it.each(["cli", "embedded"] as const)(
    "preserves the %s maintenance failure policy for local replies",
    async (runner) => {
      const sessionId = `${runner}-no-delivery-compaction-failure`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        params.onSuccessfulAuthProfile?.({});
        return makeResult({ sessionId, text: "local final", runner, agentHarnessId: "openclaw" });
      });
      const compact =
        runner === "embedded"
          ? state.runSessionCompactionIfNeededMock
          : state.runCliTurnCompactionLifecycleMock;
      compact.mockRejectedValueOnce(new Error(COMPACTION_ERROR));

      const command = agentCommand({
        message: "local model run",
        sessionId,
        sessionKey,
        cwd: state.workspaceDir,
        json: true,
        deliver: false,
      });
      if (runner === "cli") {
        await expect(command).rejects.toThrow("Summarization failed: Connection error");
        expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
      } else {
        await command;
        expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
          expect.objectContaining({
            opts: expect.objectContaining({ json: true, deliver: false }),
            payloads: [{ text: "local final" }],
          }),
        );
        expect(readLifecyclePhases()).toContain("end");
        expect(readLifecyclePhases()).not.toContain("error");
      }
      expect(compact).toHaveBeenCalledOnce();
      expect(findStoredSessionEntry(sessionKey)?.pendingFinalDelivery).toBeUndefined();
    },
  );

  it.each(["abort", "rebound", "revision change"] as const)(
    "does not print a completed embedded reply after %s during maintenance",
    async (fault) => {
      const sessionId = "invalidated-local-maintenance";
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const controller = new AbortController();
      const cancelled = new Error("maintenance cancelled");
      const failure = new Error(COMPACTION_ERROR);
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        params.onSuccessfulAuthProfile?.({});
        return makeResult({
          sessionId,
          text: "local final",
          runner: "embedded",
          agentHarnessId: "openclaw",
        });
      });
      state.runSessionCompactionIfNeededMock.mockImplementationOnce(async ({ sessionEntry }) => {
        if (!sessionEntry) {
          throw new Error("maintenance fixture requires a persisted session");
        }
        if (fault === "abort") {
          controller.abort(cancelled);
        } else {
          await replaceSessionEntry(
            { sessionKey, storePath: requireStorePath() },
            {
              ...sessionEntry,
              sessionId: fault === "rebound" ? "replacement-session" : sessionId,
              lifecycleRevision: randomUUID(),
            },
          );
        }
        throw failure;
      });

      await expect(
        agentCommand({
          message: "local model run",
          sessionId,
          sessionKey,
          cwd: state.workspaceDir,
          json: true,
          deliver: false,
          abortSignal: controller.signal,
        }),
      ).rejects.toBe(fault === "abort" ? cancelled : failure);

      expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledOnce();
      expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
      expect(readLifecyclePhases()).not.toContain("end");
    },
  );
});
