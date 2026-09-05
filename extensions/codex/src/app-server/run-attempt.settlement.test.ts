// Native terminal settlement bounds projection and checkpoint work without harming sibling runs.
import path from "node:path";
import { resolveActiveEmbeddedRunSessionId } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import {
  TURN_FINALIZE_DRAIN_ABORT_GRACE_MS,
  TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS,
} from "./attempt-timeouts.js";
import { CodexAppServerClient } from "./client.js";
import { turnCompleted } from "./protocol.test-helpers.js";
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

  it("bounds post-terminal projection and joins late abort cleanup without stopping a shared sibling", async () => {
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
      expect(onAttemptTimeout).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "codex app-server terminal settlement timed out" }),
      );

      const list = await waitForHarnessRequest(physical, "thread/backgroundTerminals/list");
      expect(wireRequests().some(({ method }) => method === "turn/interrupt")).toBe(false);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(firstSettled).not.toHaveBeenCalled();
      expect(wireRequests().some(({ method }) => method === "thread/unsubscribe")).toBe(false);
      physical.send({ id: list.id, result: { data: [], nextCursor: null } });
      await vi.advanceTimersByTimeAsync(0);

      // Native cleanup consumed four seconds. Projection gets its own
      // full grace after cleanup, rather than spending it on cleanup RPCs.
      await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS - 1);
      expect(firstSettled).not.toHaveBeenCalled();
      expect(wireRequests().some(({ method }) => method === "thread/unsubscribe")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const unsubscribe = await waitForHarnessRequest(physical, "thread/unsubscribe");
      physical.send({ id: unsubscribe.id, result: {} });
      const result = await firstRun;
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: true,
        timedOut: true,
        promptError: "codex app-server terminal settlement timed out",
      });
      expect(result.codexAppServerFailure?.kind).toBe("turn_settlement_timeout");
      expect(result.promptTimeoutOutcome).toMatchObject({ replayInvalid: true });
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
      ).toEqual(["thread-settlement", "thread-settlement"]);
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

  it("reports settlement failure when a terminal checkpoint remains blocked", async () => {
    const params = createTestParams();
    await attachSqliteSessionTarget(
      params,
      path.join(tempDir, "settlement-checkpoint.sqlite"),
      "session-checkpoint",
    );
    const checkpoint = createDeferred<void>();
    const mirror = codexTranscriptMirrorRuntime.mirror;
    const checkpointWrites: Promise<unknown>[] = [];
    const checkpointMirror = vi
      .spyOn(codexTranscriptMirrorRuntime, "mirror")
      .mockImplementation((input) => {
        const writing = checkpoint.promise.then(() => mirror(input));
        checkpointWrites.push(writing);
        return writing;
      });
    const harness = createStartedThreadHarness();
    const onAttemptTimeout = vi.fn();
    params.onAttemptTimeout = onAttemptTimeout;
    params.timeoutMs = 60 * 60_000;
    vi.useFakeTimers();
    const settled = vi.fn();
    const run = runCodexAppServerAttempt(params);
    void run.then(settled, settled);
    try {
      await harness.waitForMethod("turn/start");
      const receivedAt = Date.now();
      await harness.notify(
        turnCompleted({
          id: "turn-1",
          status: "completed",
          items: [
            {
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
            },
            { id: "checkpoint-answer", type: "agentMessage", text: "Completed before checkpoint." },
          ],
        }),
      );
      await vi.waitFor(() => expect(checkpointMirror).toHaveBeenCalledOnce(), fastWait);
      await vi.advanceTimersByTimeAsync(
        receivedAt + TURN_TERMINAL_SETTLEMENT_TIMEOUT_MS - Date.now(),
      );
      expect(onAttemptTimeout).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: "codex app-server terminal settlement timed out" }),
      );
      await vi.advanceTimersByTimeAsync(TURN_FINALIZE_DRAIN_ABORT_GRACE_MS);
      await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), fastWait);
      const result = await run;
      expect(readAttemptTerminal(result)).toMatchObject({
        aborted: true,
        timedOut: true,
        promptError: "codex app-server terminal settlement timed out",
      });
      expect(result.codexAppServerFailure?.kind).toBe("turn_settlement_timeout");
      expect(result.promptTimeoutOutcome).toMatchObject({ replayInvalid: true });
      expect(result.assistantTexts).toEqual(["Completed before checkpoint."]);
    } finally {
      checkpoint.resolve();
      vi.useRealTimers();
      await Promise.allSettled([run, ...checkpointWrites]);
    }
  });
});
