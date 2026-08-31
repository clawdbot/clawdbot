import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SessionManager } from "../sessions/session-manager.js";
import { makeAssistantMessageFixture } from "../test-helpers/assistant-message-fixtures.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedBuildEmbeddedRunPayloads,
  mockedCompactDirect,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
  useOpenAIPlatformAuthFixture,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type {
  CompactionAccountingFact,
  EmbeddedRunAttemptInternalParams,
} from "./run/internal-params.js";

function timeoutAttempt() {
  const assistant = makeAssistantMessageFixture();
  assistant.usage = { ...assistant.usage, input: 180_000, totalTokens: 180_000 };
  return makeAttemptResult({
    terminal: { kind: "timeout", phase: "prompt", source: "idle", aborted: true },
    assistantTexts: [],
    lastAssistant: assistant,
    currentAttemptAssistant: assistant,
  });
}

describe("recovery cancellation through the public run owner", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let runEmbeddedAgent: TestRunEmbeddedAgent;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>> | undefined;
  let sessionAccessor: typeof import("../../config/sessions/session-accessor.js");
  let contextEngine: Awaited<
    ReturnType<(typeof import("../../context-engine/registry.js"))["resolveContextEngine"]>
  >;
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    sessionAccessor = await import("../../config/sessions/session-accessor.js");
    const { resolveContextEngine } = await import("../../context-engine/registry.js");
    contextEngine = await resolveContextEngine();
  });
  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
    contextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (name) => name === "before_compaction" || name === "after_compaction",
    );
    mockedGlobalHookRunner.runBeforeCompaction.mockReset().mockResolvedValue(undefined);
    mockedGlobalHookRunner.runAfterCompaction.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    contextEngine.info.ownsCompaction = false;
    await session?.cleanup();
    session = undefined;
  });

  describe.each(["caller", "subscription"] as const)("%s accounting owner", (owner) => {
    it.each([
      { kind: "overflow", committed: false },
      { kind: "timeout", committed: false },
      { kind: "overflow", committed: true },
      { kind: "timeout", committed: true },
    ] as const)(
      "preserves caller rejection and committed=$committed facts after $kind cancellation",
      async ({ kind, committed }) => {
        const workspaceDir = tempDirs.make("openclaw-recovery-cancel-");
        const sessionManager = SessionManager.inMemory(workspaceDir);
        const abort = new AbortController();
        const callerError = new Error("caller stopped recovery");
        const onCompactionAccounting =
          vi.fn<(fact: CompactionAccountingFact | undefined) => void>();
        if (owner === "subscription") {
          session = await createSharedRunIntegrationSession();
        }
        const runParams = {
          ...(session
            ? session.runParams
            : {
                ...createOverflowRunParams({ workspaceDir }),
                sessionId: sessionManager.getSessionId(),
                sessionManager,
                sessionPersistence: "detached" as const,
              }),
          abortSignal: abort.signal,
        };
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(
          kind === "overflow"
            ? makeAttemptResult({
                promptError: makeOverflowError(),
                sessionIdUsed: runParams.sessionId,
                assistantTexts: [],
              })
            : { ...timeoutAttempt(), sessionIdUsed: runParams.sessionId },
        );
        if (committed) {
          mockedCompactDirect.mockResolvedValueOnce(
            makeCompactionSuccess({ summary: "Committed before Stop", tokensAfter: 40 }),
          );
          mockedGlobalHookRunner.runAfterCompaction.mockImplementationOnce(async () => {
            abort.abort(callerError);
          });
        } else {
          mockedCompactDirect.mockImplementationOnce(async () => {
            abort.abort(callerError);
            throw callerError;
          });
        }

        const run =
          owner === "caller"
            ? runEmbeddedAgent({
                ...runParams,
                onCompactionAccounting,
              })
            : runEmbeddedAgent(runParams);
        await expect(run).rejects.toBe(callerError);

        expect(mockedCompactDirect).toHaveBeenCalledOnce();
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
        if (session) {
          const entry = sessionAccessor.loadSessionEntry({
            ...session.runParams.sessionTarget,
            readConsistency: "latest",
          });
          expect(entry).toMatchObject({ sessionId: runParams.sessionId });
          expect(entry?.compactionCount ?? 0).toBe(committed ? 1 : 0);
          expect(entry?.totalTokens).toBe(committed ? 40 : undefined);
          expect(onCompactionAccounting).not.toHaveBeenCalled();
        } else {
          expect(onCompactionAccounting).toHaveBeenCalledExactlyOnceWith(
            committed
              ? { kind: "presentation-only", count: 1, currentContextSnapshot: { tokens: 40 } }
              : undefined,
          );
        }
      },
    );
  });

  it.each(["writer-replaced", "admission-replaced", "deleted"] as const)(
    "does not persist completed default facts after its owner is %s",
    async (change) => {
      session = await createSharedRunIntegrationSession();
      const runParams = session.runParams;
      const { sessionTarget } = runParams;
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      let replacement: ReturnType<typeof prepareSystemAgentRunAdmission> | undefined;
      const abort = new AbortController();
      const callerError = new Error("caller stopped after owner changed");
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(timeoutAttempt());
      mockedCompactDirect.mockResolvedValueOnce(
        makeCompactionSuccess({ summary: "Committed before owner change", tokensAfter: 40 }),
      );
      mockedGlobalHookRunner.runAfterCompaction.mockImplementationOnce(async () => {
        if (change !== "deleted") {
          await sessionAccessor.updateSessionEntry(sessionTarget, () => ({
            compactionCount: 7,
            totalTokens: 999,
          }));
          if (change === "writer-replaced") {
            const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
            await claimAgentSessionWriter({ ...runParams, runId: "replacement-writer" });
          } else {
            replacement = prepareSystemAgentRunAdmission(
              {},
              runParams.runId,
              "main",
              "replacement",
            );
            await replacement.admit("embedded");
          }
        } else {
          await sessionAccessor.deleteSessionEntryLifecycle({
            agentId: sessionTarget.agentId,
            storePath: sessionTarget.storePath,
            archiveTranscript: false,
            target: {
              canonicalKey: sessionTarget.sessionKey,
              storeKeys: [sessionTarget.sessionKey],
            },
          });
        }
        abort.abort(callerError);
      });

      try {
        await expect(runEmbeddedAgent({ ...runParams, abortSignal: abort.signal })).rejects.toBe(
          callerError,
        );

        const entry = sessionAccessor.loadSessionEntry({
          ...sessionTarget,
          readConsistency: "latest",
        });
        if (change !== "deleted") {
          expect(entry).toMatchObject({
            compactionCount: 7,
            totalTokens: 999,
            activeWriterRunId:
              change === "writer-replaced" ? "replacement-writer" : runParams.runId,
          });
        } else {
          expect(entry).toBeUndefined();
        }
        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      } finally {
        replacement?.close();
      }
    },
  );

  it.each(["returned", "thrown"] as const)(
    "settles observed default counts once when the attempt is %s",
    async (settlement) => {
      session = await createSharedRunIntegrationSession();
      const attemptError = new Error("attempt cleanup failed after completed compaction");
      const { createSubscribedSessionHarness } =
        await import("../embedded-agent-subscribe.e2e-harness.js");
      const onAgentEvent = vi.fn();
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async (input) => {
          const attempt = input as EmbeddedRunAttemptInternalParams;
          const harness = createSubscribedSessionHarness({
            agentId: attempt.agentId,
            runId: attempt.runId,
            sessionKey: attempt.sessionKey,
            sessionExtras: { messages: [] },
            compactionCountOwner: attempt.compactionCountOwner,
            onContextAccountingEvent: attempt.onContextAccountingEvent,
            onAgentEvent: attempt.onAgentEvent,
          });
          try {
            // The attempt owns commitment; the public event only projects its completion.
            attempt.onContextAccountingEvent?.({ kind: "compaction", tokensAfter: 80 });
            harness.emit({
              type: "compaction_end",
              reason: "threshold",
              outcome: {
                status: "completed",
                tokensBefore: 180_000,
                tokensAfter: 80,
                willRetry: false,
              },
            });
            await harness.subscription.waitForPendingEvents();
            if (settlement === "thrown") {
              throw attemptError;
            }
            return {
              ...timeoutAttempt(),
              compactionCount: harness.subscription.getCompactionCount(),
              compactionTokensAfter: 80,
            };
          } finally {
            harness.subscription.unsubscribe();
          }
        })
        .mockImplementationOnce(async (input) => {
          const attempt = input as EmbeddedRunAttemptInternalParams;
          const harness = createSubscribedSessionHarness({
            runId: attempt.runId,
            onContextAccountingEvent: attempt.onContextAccountingEvent,
          });
          const assistant = makeAssistantMessageFixture({
            stopReason: "stop",
            errorMessage: undefined,
          });
          assistant.usage = { ...assistant.usage, input: 120, totalTokens: 120 };
          try {
            harness.emit({ type: "message_start", message: assistant });
            harness.emit({ type: "message_end", message: assistant });
            await harness.subscription.waitForPendingEvents();
            return makeAttemptResult();
          } finally {
            harness.subscription.unsubscribe();
          }
        });
      mockedCompactDirect.mockResolvedValueOnce(
        makeCompactionSuccess({ summary: "Outer timeout recovery", tokensAfter: 40 }),
      );

      const run = runEmbeddedAgent({ ...session.runParams, onAgentEvent });
      if (settlement === "returned") {
        expect((await run).meta.agentMeta?.compactionCount).toBe(2);
      } else {
        await expect(run).rejects.toBe(attemptError);
      }

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(settlement === "returned" ? 2 : 1);
      expect(mockedCompactDirect).toHaveBeenCalledTimes(settlement === "returned" ? 1 : 0);
      expect(
        sessionAccessor.loadSessionEntry({
          ...session.runParams.sessionTarget,
          readConsistency: "latest",
        }),
      ).toMatchObject({
        compactionCount: settlement === "returned" ? 2 : 1,
        totalTokens: settlement === "returned" ? 120 : 80,
      });
      expect(onAgentEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: "compaction",
          data: expect.objectContaining({ phase: "end", completed: true }),
        }),
      );
    },
  );

  it.each([
    { order: "model-then-compaction", currentContextTokens: 40, count: 1 },
    { order: "compaction-then-model", currentContextTokens: 120, count: 1 },
    { order: "compaction-then-unknown", currentContextTokens: undefined, count: 1 },
    { order: "model-only", currentContextTokens: 120, count: 0 },
  ] as const)("carries producer chronology through the run owner ($order)", async (testCase) => {
    session = await createSharedRunIntegrationSession();
    const { runParams } = session;
    const facts = vi.fn<(fact: CompactionAccountingFact | undefined) => void>();
    mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Done." }]);
    const { createSubscribedSessionHarness } =
      await import("../embedded-agent-subscribe.e2e-harness.js");
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
      const attempt = input as EmbeddedRunAttemptInternalParams;
      const harness = createSubscribedSessionHarness({
        agentId: attempt.agentId,
        runId: attempt.runId,
        sessionKey: attempt.sessionKey,
        sessionExtras: { messages: [] },
        compactionCountOwner: attempt.compactionCountOwner,
        onContextAccountingEvent: attempt.onContextAccountingEvent,
      });
      const assistant = makeAssistantMessageFixture({
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Done." }],
      });
      assistant.usage = { ...assistant.usage, input: 120, totalTokens: 120 };
      const emitModel = () => {
        const message =
          testCase.order === "compaction-then-unknown"
            ? makeAssistantMessageFixture({
                stopReason: "stop",
                errorMessage: undefined,
                content: assistant.content,
              })
            : assistant;
        harness.emit({ type: "message_start", message });
        harness.emit({ type: "message_end", message });
      };
      try {
        if (testCase.order === "model-then-compaction") {
          emitModel();
        }
        if (testCase.count > 0) {
          attempt.onContextAccountingEvent?.({ kind: "compaction", tokensAfter: 40 });
          harness.emit({
            type: "compaction_end",
            reason: "threshold",
            outcome: {
              status: "completed",
              tokensBefore: 180_000,
              tokensAfter: 40,
              willRetry: false,
            },
          });
        }
        if (testCase.order !== "model-then-compaction") {
          emitModel();
        }
        await harness.subscription.waitForPendingEvents();
        // Terminal copies can still describe the pre-compaction assistant.
        return makeAttemptResult({
          sessionIdUsed: runParams.sessionId,
          lastAssistant: assistant,
          compactionCount: harness.subscription.getCompactionCount(),
          compactionTokensAfter: testCase.count > 0 ? 40 : undefined,
        });
      } finally {
        harness.subscription.unsubscribe();
      }
    });

    const result = await runEmbeddedAgent({
      ...runParams,
      onCompactionAccounting: facts,
    });

    expect(result.payloads).toEqual([{ text: "Done." }]);
    expect(facts).toHaveBeenCalledExactlyOnceWith({
      kind: "durable",
      count: testCase.count,
      currentContextSnapshot: { tokens: testCase.currentContextTokens },
      target: {
        ...runParams.sessionTarget,
        lifecycleRevision: undefined,
        activeWriterRunId: runParams.runId,
      },
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it.each(["current", "replaced"] as const)(
    "finalizes opaque native usage only for its %s writer",
    async (writer) => {
      session = await createSharedRunIntegrationSession();
      const { runParams } = session;
      const { sessionId, sessionKey, sessionTarget } = runParams;
      const { createAgentCommandSessionWorkingCopy } =
        await import("../command/session-helpers.js");
      const { createCommandCompactionAccounting } =
        await import("../command/compaction-accounting.js");
      const { updateSessionStoreAfterAgentRun } = await import("../command/session-store.js");
      const { SESSION_TOTAL_TOKENS_VERSION } = await import("../../config/sessions/types.js");
      const { normalizeUsage } = await import("../usage.js");
      useOpenAIPlatformAuthFixture();
      const initialEntry = {
        sessionId,
        updatedAt: 1,
        lifecycleRevision: "native-usage-generation",
        activeWriterRunId: "previous-writer",
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      };
      await sessionAccessor.replaceSessionEntry(sessionTarget, initialEntry);
      const { sessionEntry, sessionStore } = createAgentCommandSessionWorkingCopy({
        sessionKey,
        sessionEntry: initialEntry,
        sessionStore: { [sessionKey]: initialEntry },
      });
      if (!sessionEntry || !sessionStore) {
        throw new Error("The command must retain its pre-claim working copy");
      }
      const accounting = createCommandCompactionAccounting({
        sessionStore,
        persistCounts: true,
        onDurableFact: () => {},
        refreshSessionEntry: () => {},
      });
      const candidate = accounting.beginCandidate();
      const assistant = makeAssistantMessageFixture({
        model: "gpt-5.6-luna",
        stopReason: "stop",
        errorMessage: undefined,
        content: [{ type: "text", text: "Done." }],
      });
      assistant.usage = {
        ...assistant.usage,
        input: 3,
        output: 18,
        cacheRead: 0,
        cacheWrite: 13_354,
        totalTokens: 13_375,
        contextUsage: { state: "available", promptTokens: 13_357, totalTokens: 13_375 },
      };
      mockedBuildEmbeddedRunPayloads.mockReturnValue([{ text: "Done." }]);
      // Native attempts return usage without the built-in subscription's private events.
      // Keep admission, writer claim, settlement, and final persistence real.
      mockedRunEmbeddedAttempt.mockResolvedValueOnce(
        makeAttemptResult({
          sessionIdUsed: sessionId,
          assistantTexts: ["Done."],
          lastAssistant: assistant,
          currentAttemptAssistant: assistant,
          attemptUsage: normalizeUsage(assistant.usage),
        }),
      );

      const result = await runEmbeddedAgent({
        ...runParams,
        provider: "openai",
        model: "gpt-5.6-luna",
        onCompactionAccounting: candidate.observe,
      });
      await candidate.finish(sessionEntry);
      expect(result.meta.agentMeta?.lastCallUsage?.contextUsage).toEqual({
        state: "available",
        promptTokens: 13_357,
        totalTokens: 13_375,
      });
      expect(sessionStore[sessionKey]).toMatchObject({
        activeWriterRunId: "previous-writer",
        totalTokens: 0,
        totalTokensFresh: true,
      });
      expect(sessionAccessor.loadSessionEntry(sessionTarget)).toMatchObject({
        activeWriterRunId: runParams.runId,
      });
      if (writer === "replaced") {
        const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
        await claimAgentSessionWriter({ ...runParams, runId: "replacement-writer" });
      }
      const beforeFinalization = sessionAccessor.loadSessionEntry(sessionTarget);

      await updateSessionStoreAfterAgentRun({
        cfg: {},
        agentDir: path.dirname(sessionTarget.storePath),
        sessionId,
        sessionKey,
        storePath: sessionTarget.storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-luna",
        result,
        compactionAccounting: accounting.fact,
      });

      const persisted = sessionAccessor.loadSessionEntry({
        ...sessionTarget,
        readConsistency: "latest",
      });
      if (writer === "replaced") {
        expect(persisted).toEqual(beforeFinalization);
        expect(persisted).toMatchObject({ activeWriterRunId: "replacement-writer" });
      } else {
        expect(persisted?.totalTokens).toBe(13_357);
        expect(persisted).toMatchObject({
          activeWriterRunId: runParams.runId,
          inputTokens: 3,
          outputTokens: 18,
          cacheRead: 0,
          cacheWrite: 13_354,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        });
        expect(persisted?.compactionCount).toBeUndefined();
        expect(accounting.fact).toMatchObject({
          kind: "durable",
          count: 0,
          target: { ...sessionTarget, activeWriterRunId: runParams.runId },
        });
      }
      expect(accounting.fact?.currentContextSnapshot).toBeUndefined();
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
      expect(mockedCompactDirect).not.toHaveBeenCalled();
    },
  );

  it("compacts and accounts a fresh persistent run whose first append creates the session row", async () => {
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    const { SessionManager: PersistentSessionManager } =
      await import("../sessions/session-manager.js");
    const state = await createOpenClawTestState({ label: "fresh-persistent-recovery" });
    let manager: ReturnType<typeof PersistentSessionManager.open> | undefined;
    let firstKeptEntryId: string | undefined;
    const runParams = {
      sessionId: "fresh-plugin-task",
      runId: "fresh-plugin-run",
      workspaceDir: state.workspaceDir,
      prompt: "Summarize the latest changes",
      timeoutMs: 30_000,
    };
    try {
      mockedRunEmbeddedAttempt
        .mockImplementationOnce(async (input) => {
          const attempt = input as EmbeddedRunAttemptInternalParams;
          const target = attempt.sessionTarget;
          if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
            throw new Error("The public runner must resolve a complete durable target");
          }
          const durableTarget = {
            ...target,
            agentId: target.agentId,
            sessionId: target.sessionId,
            sessionKey: target.sessionKey,
            storePath: target.storePath,
          };
          expect(sessionAccessor.loadSessionEntry(durableTarget)).toBeUndefined();
          manager = PersistentSessionManager.open(durableTarget, state.workspaceDir);
          firstKeptEntryId = manager.appendMessage({
            role: "user",
            content: "hello",
            timestamp: 1,
          });
          expect(sessionAccessor.loadSessionEntry(durableTarget)).toMatchObject({
            sessionId: runParams.sessionId,
          });
          return { ...timeoutAttempt(), sessionIdUsed: runParams.sessionId };
        })
        .mockResolvedValueOnce(makeAttemptResult({ sessionIdUsed: runParams.sessionId }));
      mockedCompactDirect.mockImplementationOnce(async () => {
        if (!manager || !firstKeptEntryId) {
          throw new Error("First attempt must persist its real user turn before recovery");
        }
        manager.appendCompaction("Fresh session summary", firstKeptEntryId, 180_000);
        return makeCompactionSuccess({ summary: "Fresh session summary", tokensAfter: 40 });
      });

      const result = await runEmbeddedAgent(runParams);

      expect(mockedCompactDirect).toHaveBeenCalledOnce();
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(result.meta.agentMeta?.compactionCount).toBe(1);
      const target = manager?.getSessionTarget();
      if (!target) {
        throw new Error("Fresh session must remain durable");
      }
      expect(
        sessionAccessor.loadSessionEntry({ ...target, readConsistency: "latest" }),
      ).toMatchObject({
        sessionId: runParams.sessionId,
        compactionCount: 1,
      });
    } finally {
      const { forgetActiveSessionForShutdown } =
        await import("../../gateway/active-sessions-shutdown-tracker.js");
      forgetActiveSessionForShutdown(runParams.sessionId);
      await state.cleanup();
    }
  });
});
