// Native terminal settlement bounds projection and checkpoint work without harming sibling runs.
import path from "node:path";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { onInternalSessionTranscriptUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import {
  readSessionTranscriptEvents,
  withSessionTranscriptWriteLock,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
  TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
} from "./attempt-timeouts.js";
import { CodexAppServerClient } from "./client.js";
import { isJsonObject } from "./protocol.js";
import { itemNotification, turnCompleted } from "./protocol.test-helpers.js";
import {
  createNativeRunParams,
  createStartedThreadHarness,
  createTestParams,
  fastWait,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { createClientHarness, waitForHarnessRequest } from "./test-support.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();

describe("Codex app-server terminal settlement", () => {
  beforeEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  afterEach(() => {
    resetSharedCodexAppServerClientForTests();
  });

  it.each([
    { stage: "onAssistantMessageStart", nativeCompleted: true },
    { stage: "onPartialReply", nativeCompleted: true },
    { stage: "onReasoningStream", nativeCompleted: true },
    { stage: "onReasoningEnd", nativeCompleted: true },
    { stage: "onReasoningStream", nativeCompleted: false },
  ] as const)(
    "settles held $stage with native completion: $nativeCompleted",
    async ({ stage, nativeCompleted }) => {
      const held = createDeferred<void>();
      const callback = vi.fn(() => held.promise);
      const onAttemptTimeout = vi.fn();
      const harness = createStartedThreadHarness();
      const params = {
        ...createTestParams(),
        [stage]: callback,
        onAttemptTimeout,
        timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
      };
      vi.useFakeTimers();
      const run = runCodexAppServerAttempt(params);
      const settled = vi.fn();
      void run.then(settled, settled);
      try {
        await harness.waitForMethod("turn/start");
        const assistantStage = stage === "onAssistantMessageStart" || stage === "onPartialReply";
        if (assistantStage) {
          await harness.notify({
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { id: "answer", type: "agentMessage", phase: "final_answer", text: "" },
            },
          });
        }
        void harness.notify({
          method: assistantStage ? "item/agentMessage/delta" : "item/reasoning/textDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: assistantStage ? "answer" : "reasoning-1",
            delta: assistantStage ? "Completed answer." : "Finishing the answer.",
          },
        });
        if (nativeCompleted) {
          void harness.notify(
            turnCompleted({
              id: "turn-1",
              status: "completed",
              items: [
                {
                  id: "answer",
                  type: "agentMessage",
                  phase: "final_answer",
                  text: "Completed answer.",
                },
              ],
            }),
          );
        }
        await vi.waitFor(() => expect(callback).toHaveBeenCalledOnce(), fastWait);
        await vi.advanceTimersByTimeAsync(TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), {
          interval: 100,
          timeout: 15_000,
        });
        vi.useRealTimers();
        const result = await run;
        if (nativeCompleted) {
          expect(result.terminal).toEqual({
            kind: "ok",
            settlementWarning: {
              pendingStage: stage,
              elapsedMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
              timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
            },
          });
          expect(result.assistantTexts).toEqual(["Completed answer."]);
          expect(result.lastAssistant?.stopReason).toBe("stop");
          expect(result.codexAppServerFailure).toBeUndefined();
          expect(onAttemptTimeout).not.toHaveBeenCalled();
        } else {
          expect(readAttemptTerminal(result)).toMatchObject({ timedOut: true, aborted: true });
          expect(onAttemptTimeout).toHaveBeenCalledOnce();
        }
      } finally {
        held.resolve();
        vi.useRealTimers();
        await run;
      }
    },
  );

  it("preserves a completed reply through degraded settlement without stopping a shared sibling", async () => {
    const physical = createClientHarness();
    const startClient = vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(physical.client);
    const projection = createDeferred<void>();
    const onReasoningStream = vi.fn(() => projection.promise);
    const onAttemptTimeout = vi.fn();
    const createSharedRunParams = (suffix: string) => ({
      ...createNativeRunParams(
        path.join(tempDir, `${suffix}.jsonl`),
        path.join(tempDir, "settlement-workspace"),
        `agent:main:${suffix}`,
      ),
      sessionId: `session-${suffix}`,
      sessionKey: `agent:main:${suffix}`,
      runId: `run-${suffix}`,
      provider: "openai",
      disableTools: false,
      timeoutMs: MAX_TIMER_TIMEOUT_MS,
    });
    const firstParams = {
      ...createSharedRunParams("settlement"),
      onReasoningStream,
      onAttemptTimeout,
    };
    const siblingParams = createSharedRunParams("sibling");
    const firstSettled = vi.fn();
    const firstRun = runCodexAppServerAttempt(firstParams);
    void firstRun.then(firstSettled, firstSettled);
    let siblingRun: ReturnType<typeof runCodexAppServerAttempt> | undefined;
    const wireRequests = () =>
      physical.writes.map(
        (write) =>
          JSON.parse(write) as {
            method?: string;
            params?: { threadId?: string };
          },
      );
    try {
      const initialize = await waitForHarnessRequest(physical, "initialize");
      physical.send({
        id: initialize.id,
        result: { userAgent: `openclaw/${CODEX_APP_SERVER_VERSION} (macOS; test)` },
      });
      const firstConfig = await waitForHarnessRequest(physical, "config/read");
      physical.send({ id: firstConfig.id, result: { config: {}, origins: {}, layers: [] } });
      const firstRequirements = await waitForHarnessRequest(physical, "configRequirements/read");
      physical.send({ id: firstRequirements.id, result: { requirements: null } });
      const firstThread = await waitForHarnessRequest(physical, "thread/start");
      physical.send({ id: firstThread.id, result: threadStartResult("thread-settlement") });
      const firstTurn = await waitForHarnessRequest(physical, "turn/start");
      physical.send({ id: firstTurn.id, result: turnStartResult("turn-settlement") });

      const siblingStart = physical.writes.length;
      siblingRun = runCodexAppServerAttempt(siblingParams);
      const siblingConfig = await waitForHarnessRequest(physical, "config/read", siblingStart);
      physical.send({ id: siblingConfig.id, result: { config: {}, origins: {}, layers: [] } });
      const siblingRequirements = await waitForHarnessRequest(
        physical,
        "configRequirements/read",
        siblingStart,
      );
      physical.send({ id: siblingRequirements.id, result: { requirements: null } });
      const siblingThread = await waitForHarnessRequest(physical, "thread/start", siblingStart);
      physical.send({ id: siblingThread.id, result: threadStartResult("thread-sibling") });
      const siblingTurn = await waitForHarnessRequest(physical, "turn/start", siblingStart);
      physical.send({ id: siblingTurn.id, result: turnStartResult("turn-sibling") });
      await vi.waitFor(() => {
        expect(resolveActiveEmbeddedRunSessionId(firstParams.sessionKey)).toBe(
          firstParams.sessionId,
        );
        expect(resolveActiveEmbeddedRunSessionId(siblingParams.sessionKey)).toBe(
          siblingParams.sessionId,
        );
      });

      vi.useFakeTimers();
      const receivedAt = Date.now();
      // Queue both frames before yielding. The second callback starts only after
      // the real router has finished handling the exact terminal notification.
      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-settlement",
          turn: {
            id: "turn-settlement",
            status: "completed",
            items: [
              { id: "answer", type: "agentMessage", text: "Completed work remains visible." },
            ],
          },
        },
      });
      physical.send({
        method: "item/reasoning/textDelta",
        params: {
          threadId: "thread-settlement",
          turnId: "turn-settlement",
          itemId: "late-reasoning",
          delta: "Queued projection after native completion.",
        },
      });
      await vi.waitFor(() => expect(onReasoningStream).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(
        receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now() - 1,
      );
      expect(onAttemptTimeout).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(onAttemptTimeout).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(firstSettled).toHaveBeenCalledOnce(), fastWait);
      const result = await firstRun;
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
        settlementWarning: { pendingStage: "onReasoningStream" },
      });
      expect(result.codexAppServerFailure).toBeUndefined();
      expect(result.promptTimeoutOutcome).toBeUndefined();
      expect(result.assistantTexts).toEqual(["Completed work remains visible."]);
      expect(
        wireRequests()
          .filter(
            ({ method }) =>
              method === "turn/interrupt" ||
              method === "thread/backgroundTerminals/list" ||
              method === "thread/unsubscribe",
          )
          .map(({ params }) => params?.threadId),
      ).toEqual([]);
      expect(physical.stdinDestroyed).toBe(false);
      expect(resolveActiveEmbeddedRunSessionId(firstParams.sessionKey)).toBeUndefined();
      expect(resolveActiveEmbeddedRunSessionId(siblingParams.sessionKey)).toBe(
        siblingParams.sessionId,
      );

      physical.send({
        method: "turn/completed",
        params: {
          threadId: "thread-sibling",
          turn: {
            id: "turn-sibling",
            status: "completed",
            items: [
              { id: "sibling-answer", type: "agentMessage", text: "Sibling stayed healthy." },
            ],
          },
        },
      });
      const siblingResult = await siblingRun;
      expect(readAttemptTerminal(siblingResult)).toMatchObject({
        aborted: false,
        timedOut: false,
        promptError: null,
      });
      expect(siblingResult.assistantTexts).toEqual(["Sibling stayed healthy."]);
      expect(startClient).toHaveBeenCalledOnce();
      expect(physical.stdinDestroyed).toBe(false);
    } finally {
      projection.resolve();
      vi.useRealTimers();
      physical.client.close();
      await Promise.allSettled([firstRun, ...(siblingRun ? [siblingRun] : [])]);
    }
  });

  it.each([
    { boundary: "callback", termination: "timeout", release: "during recovery" },
    { boundary: "checkpoint", termination: "timeout", release: "during recovery" },
    { boundary: "final", termination: "timeout", release: "during recovery" },
    { boundary: "final", termination: "timeout", release: "after cutoff" },
    { boundary: "checkpoint", termination: "abort", release: "after cutoff" },
    { boundary: "final", termination: "abort", release: "after cutoff" },
    { boundary: "final", termination: "abort", release: "during grace" },
    { boundary: "checkpoint", termination: "abort", release: "during grace" },
    { boundary: "publication", termination: "abort", release: "on publication" },
  ] as const)(
    "settles $termination at $boundary with writer release $release",
    async ({ boundary, termination, release }) => {
      const queuedNetworkResult = boundary === "checkpoint" && termination === "timeout";
      const params = createTestParams();
      await attachSqliteSessionTarget(
        params,
        path.join(tempDir, "settlement-checkpoint.sqlite"),
        "session-checkpoint",
      );
      const target = params.sessionTarget;
      if (!target?.sessionId || !target.sessionKey) {
        throw new Error("SQLite transcript target was not attached");
      }
      const transcriptTarget = {
        ...target,
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
      };
      const checkpoint = createDeferred<void>();
      const mirror = codexTranscriptMirrorRuntime.mirror;
      const checkpointWrites: Promise<unknown>[] = [];
      const holdWriter = async () => {
        const writerAcquired = createDeferred<void>();
        checkpointWrites.push(
          withSessionTranscriptWriteLock(transcriptTarget, async () => {
            writerAcquired.resolve();
            await checkpoint.promise;
          }),
        );
        await writerAcquired.promise;
      };
      const checkpointMirror = vi.spyOn(codexTranscriptMirrorRuntime, "mirror");
      if (boundary === "callback") {
        checkpointMirror.mockImplementation((input) => {
          const writing = checkpoint.promise.then(() => mirror(input));
          checkpointWrites.push(writing);
          return writing;
        });
      }
      const finalMirrorStarted = createDeferred<void>();
      if (boundary === "final") {
        const finalMirror = codexTranscriptMirrorRuntime.mirrorBestEffort;
        vi.spyOn(codexTranscriptMirrorRuntime, "mirrorBestEffort").mockImplementationOnce(
          async (input) => {
            await holdWriter();
            const writing = finalMirror(input);
            checkpointWrites.push(writing);
            finalMirrorStarted.resolve();
            return await writing;
          },
        );
      }
      const harness = createStartedThreadHarness();
      const onAttemptTimeout = vi.fn();
      const onAgentEvent = vi.fn();
      const abort = new AbortController();
      const successorAbort = new AbortController();
      const publishedTerminal = vi.fn();
      const unsubscribe = onInternalSessionTranscriptUpdate((update) => {
        if (boundary === "publication" && update.runId === params.runId) {
          publishedTerminal(update);
          abort.abort("cancelled after transcript commit");
        }
      });
      params.abortSignal = abort.signal;
      params.onAttemptTimeout = onAttemptTimeout;
      params.onAgentEvent = onAgentEvent;
      // Whole-message preparation must not erase the terminal owner's warning.
      params.prepareAssistantTranscriptMessage = (message) => ({
        ...message,
        __openclaw: undefined,
      });
      params.timeoutMs = 60 * 60_000;
      vi.useFakeTimers();
      const settled = vi.fn();
      const run = runCodexAppServerAttempt(params);
      let successor: ReturnType<typeof runCodexAppServerAttempt> | undefined;
      void run.then(settled, settled);
      try {
        await harness.waitForMethod("turn/start");
        if (boundary === "checkpoint") {
          await holdWriter();
        }
        await harness.notify({
          method: "rawResponse/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            responseId: "response-1",
            usage: {
              totalTokens: 12,
              inputTokens: 5,
              cachedInputTokens: 2,
              outputTokens: 7,
              reasoningOutputTokens: 0,
            },
          },
        });
        const completedCommand = {
          id: "checkpoint-command",
          type: "commandExecution",
          command: "echo saved",
          cwd: params.workspaceDir,
          commandActions: [],
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: "saved",
          exitCode: 0,
          durationMs: 1,
        };
        if (queuedNetworkResult) {
          void harness.notify(itemNotification("item/completed", completedCommand));
          await vi.waitFor(() => expect(checkpointMirror).toHaveBeenCalledOnce(), fastWait);
          void harness.notify(
            itemNotification("item/completed", {
              id: "queued-search",
              type: "webSearch",
              query: "synthetic network result",
              action: { type: "search", query: "synthetic network result" },
              results: null,
            }),
          );
        }
        const receivedAt = Date.now();
        void harness.notify(
          turnCompleted({
            id: "turn-1",
            status: "completed",
            items: [
              ...(queuedNetworkResult ? [] : [completedCommand]),
              {
                id: "checkpoint-answer",
                type: "agentMessage",
                text: "Completed before checkpoint.",
              },
            ],
          }),
        );
        await vi.waitFor(() => expect(checkpointMirror).toHaveBeenCalledOnce(), fastWait);
        if (boundary === "final") {
          await finalMirrorStarted.promise;
        }
        if (termination === "timeout") {
          await vi.advanceTimersByTimeAsync(
            receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now(),
          );
          expect(onAttemptTimeout).not.toHaveBeenCalled();
        } else if (boundary === "publication") {
          await vi.waitFor(() => expect(publishedTerminal).toHaveBeenCalledOnce(), fastWait);
        } else {
          abort.abort("cancelled");
        }
        if (release === "after cutoff") {
          await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
        } else if (release === "during recovery") {
          await vi.advanceTimersByTimeAsync(1);
        }
        if (release !== "after cutoff") {
          // The replacement final still queues behind the authoritative writer.
          checkpoint.resolve();
          await Promise.allSettled(checkpointWrites);
        }
        await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
        const result = await run;
        expect(readAttemptTerminal(result)).toMatchObject({
          aborted: termination === "abort",
          timedOut: false,
          promptError: null,
        });
        expect(result.codexAppServerFailure).toBeUndefined();
        if (termination === "timeout") {
          expect(result.terminal).toMatchObject({
            kind: "ok",
            settlementWarning: {
              pendingStage: boundary === "final" ? "transcript/mirror" : "transcript/checkpoint",
              timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
            },
          });
        }
        expect(result.promptTimeoutOutcome).toBeUndefined();
        expect(onAttemptTimeout).not.toHaveBeenCalled();
        expect(result.assistantTexts).toEqual(["Completed before checkpoint."]);
        expect(result.lastAssistant?.stopReason).toBe(termination === "abort" ? "aborted" : "stop");
        expect(result.attemptUsage).toMatchObject({ input: 3, output: 7, cacheRead: 2, total: 12 });
        if (termination === "abort") {
          expect(result.attemptUsage?.contextUsage).toEqual({ state: "unavailable" });
        }
        const assistantCommitted =
          (termination === "timeout" && release === "during recovery") ||
          boundary === "publication" ||
          (boundary === "checkpoint" && release === "during grace");
        expect(
          onAgentEvent.mock.calls.filter(
            ([event]) =>
              event.stream === "lifecycle" &&
              (event.data.phase === "end" || event.data.phase === "error"),
          ),
        ).toHaveLength(1);
        expect(resolveActiveEmbeddedRunSessionId(transcriptTarget.sessionKey)).toBeUndefined();
        if (termination === "timeout" || release !== "after cutoff" || boundary === "final") {
          checkpoint.resolve();
          await Promise.allSettled(checkpointWrites);
          const events = await readSessionTranscriptEvents(transcriptTarget);
          const assistantRows = events.filter(
            (event) =>
              isJsonObject(event) &&
              isJsonObject(event.message) &&
              event.message.role === "assistant" &&
              isJsonObject(event.message["__openclaw"]) &&
              event.message["__openclaw"].mirrorIdentity === "turn-1:assistant",
          );
          if (assistantCommitted) {
            expect(assistantRows).toEqual([
              expect.objectContaining({
                id: result.contextEngineTerminalAnchor?.entryId,
                message: expect.objectContaining({
                  stopReason:
                    termination === "timeout" || boundary === "publication" ? "stop" : "aborted",
                  idempotencyKey: result.assistantTranscriptIdempotencyKey,
                }),
              }),
            ]);
            if (termination === "timeout") {
              expect(assistantRows[0]).toMatchObject({
                message: {
                  __openclaw: {
                    settlementWarning: expect.objectContaining({
                      timeoutMs: TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
                    }),
                  },
                },
              });
              if (queuedNetworkResult) {
                expect(assistantRows[0]).toMatchObject({
                  message: { __openclaw: { turnTainted: true } },
                });
              }
            }
            if (boundary === "publication") {
              expect(publishedTerminal).toHaveBeenCalledExactlyOnceWith(
                expect.objectContaining({ messageId: result.contextEngineTerminalAnchor?.entryId }),
              );
            }
          } else {
            expect(assistantRows).toEqual([]);
          }
        }
        if (assistantCommitted) {
          expect(result.assistantTranscriptOwned).toBe(true);
          expect(result.assistantTranscriptIdempotencyKey).toEqual(expect.any(String));
          expect(result.contextEngineTerminalAnchor).toMatchObject({
            idempotencyKey: result.assistantTranscriptIdempotencyKey,
          });
        } else {
          expect(result.assistantTranscriptOwned).not.toBe(true);
          expect(result.assistantTranscriptIdempotencyKey).toBeUndefined();
          expect(result.contextEngineTerminalAnchor).toBeUndefined();
        }
        if (boundary === "final" && release === "after cutoff") {
          const nextHarness = createStartedThreadHarness(
            async (method) => {
              if (method === "thread/resume") {
                return threadStartResult("thread-1");
              }
              return method === "turn/start" ? turnStartResult("turn-next") : undefined;
            },
            { persistedThreads: ["thread-1"] },
          );
          successor = runCodexAppServerAttempt({
            ...params,
            runId: "run-next",
            abortSignal: successorAbort.signal,
          });
          await nextHarness.waitForMethod("turn/start");
          await nextHarness.notify(
            turnCompleted({
              id: "turn-next",
              status: "completed",
              items: [{ id: "next-answer", type: "agentMessage", text: "Next turn saved." }],
            }),
          );
          const next = await successor;
          expect(readAttemptTerminal(next)).toMatchObject({ aborted: false, timedOut: false });
          expect(next.assistantTranscriptOwned).toBe(true);
          const history = JSON.stringify(await readSessionTranscriptEvents(transcriptTarget));
          expect(history).toContain("Next turn saved.");
          expect(history).not.toContain("Completed before checkpoint.");
        }
      } finally {
        unsubscribe();
        checkpoint.resolve();
        abort.abort("test cleanup");
        successorAbort.abort("test cleanup");
        vi.useRealTimers();
        await Promise.allSettled([run, ...checkpointWrites, ...(successor ? [successor] : [])]);
      }
    },
  );
});
