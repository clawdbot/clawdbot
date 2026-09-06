import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  agentCommand,
  agentCommandFromGatewayIngress,
  compactionTestState as state,
  compactionTestRuntime,
  findCompactionSessionEntry as findStoredSessionEntry,
  requireCompactionStorePath as requireStorePath,
  makeCompactionResult,
  readCompactionLifecyclePhases,
  registerAgentCommandCompactionTestHooks,
  GATEWAY_INGRESS_ARGS,
} from "../agent-command.compaction.test-support.js";
import { waitForSessionMaintenance } from "../session-maintenance/coordinator.js";

const {
  replaceSessionEntry,
  loadSessionEntry,
  loadTranscriptEvents,
  acceptCompactionSuccessor,
  createAgentRunRestartAbortError,
} = compactionTestRuntime;

registerAgentCommandCompactionTestHooks();

describe("agent command foreground completion", () => {
  it.each(["none", "compaction", "memory"] as const)(
    "retains the accepted preflight successor (abort=%s)",
    async (abortStage) => {
      const aborted = abortStage !== "none";
      const sessionId = "preflight-predecessor";
      const successorId = "preflight-successor";
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const storePath = requireStorePath();
      const prompt = "Record the preflight successor marker.";
      const events: string[] = [];
      const controller = new AbortController();
      const onSessionIdChanged = vi.fn();
      const abortError = createAgentRunRestartAbortError();
      await replaceSessionEntry(
        { sessionKey, storePath },
        { sessionId, updatedAt: Date.now(), totalTokens: 90_000, totalTokensFresh: true },
      );
      state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
        events.push("checkpoint");
        if (abortStage === "memory") {
          controller.abort(abortError);
          return { sessionEntry: params.sessionEntry, outcome: "failed" };
        }
        return { sessionEntry: params.sessionEntry, outcome: "completed" };
      });
      state.runSessionPreflightCompactionMock.mockImplementationOnce(async (params) => {
        const entry = expectDefined(params.sessionEntry, "preflight predecessor");
        const checkpoint = expectDefined(params.beforeCompaction, "preflight checkpoint");
        const refreshed = expectDefined(await checkpoint(entry), "checkpoint session");
        const ownerEntry = expectDefined(
          loadSessionEntry({ agentId: "main", sessionKey, storePath }),
          "authoritative checkpoint owner",
        );
        events.push("compaction");
        const accepted = await acceptCompactionSuccessor({
          currentTarget: { agentId: "main", sessionId: refreshed.sessionId, sessionKey, storePath },
          currentSessionFile: sessionKey,
          expectedEntry: {
            sessionId: refreshed.sessionId,
            lifecycleRevision: ownerEntry.lifecycleRevision,
            activeWriterRunId: ownerEntry.activeWriterRunId,
          },
          assertActive: () => params.abortSignal?.throwIfAborted(),
          onCommitted: params.onCompactionCommitted,
          result: {
            ok: true,
            compacted: true,
            result: { sessionId: successorId, tokensBefore: 90_000, tokensAfter: 42 },
          },
        });
        if (params.sessionStore) {
          params.sessionStore[sessionKey] = accepted.entry;
        }
        if (aborted) {
          controller.abort(abortError);
          params.abortSignal?.throwIfAborted();
        }
        params.onSessionIdChanged?.(accepted.sessionId);
        return accepted.entry;
      });
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        events.push("attempt");
        await params.userTurnTranscriptRecorder?.persistApproved();
        return makeCompactionResult({
          sessionId: params.sessionId,
          text: "successor answer",
          runner: "embedded",
        });
      });

      const command = agentCommand({
        message: prompt,
        sessionId,
        sessionKey,
        oneShotCliRun: true,
        abortSignal: controller.signal,
        onSessionIdChanged,
      });
      if (aborted) {
        await expect(command).rejects.toBe(abortError);
        expect(onSessionIdChanged.mock.calls).toEqual(
          abortStage === "memory" ? [] : [[successorId]],
        );
        expect(events).toEqual(
          abortStage === "compaction" ? ["checkpoint", "compaction"] : ["checkpoint"],
        );
        expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(
          abortStage === "memory" ? sessionId : successorId,
        );
        expect(state.runAgentAttemptMock).not.toHaveBeenCalled();
        expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
        return;
      }
      await command;

      expect(events).toEqual(["checkpoint", "compaction", "attempt"]);
      expect(state.runMemoryFlushIfNeededMock).toHaveBeenCalledOnce();
      expect(state.runSessionPreflightCompactionMock).toHaveBeenCalledOnce();
      expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
      expect(state.runAgentAttemptMock.mock.calls[0]?.[0]).toMatchObject({
        sessionId: successorId,
        sessionTarget: { agentId: "main", sessionId: successorId, sessionKey, storePath },
      });
      expect(findStoredSessionEntry(sessionKey)?.sessionId).toBe(successorId);
      const successorEvents = await loadTranscriptEvents({
        agentId: "main",
        sessionId: successorId,
        storePath,
      });
      const predecessorEvents = await loadTranscriptEvents({
        agentId: "main",
        sessionId,
        storePath,
      });
      expect(JSON.stringify(successorEvents)).toContain(prompt);
      expect(JSON.stringify(predecessorEvents)).not.toContain(prompt);
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text: "successor answer" }],
          result: expect.objectContaining({
            meta: expect.objectContaining({
              agentMeta: expect.objectContaining({ sessionId: successorId }),
            }),
          }),
        }),
      );
    },
  );

  it("returns a completed Gateway reply before optional memory work finishes", async () => {
    const sessionId = "foreground-before-memory";
    const sessionKey = `agent:main:explicit:${sessionId}`;
    let releaseFlush = () => {};
    const flush = new Promise<void>((resolve) => {
      releaseFlush = resolve;
    });
    let markFlushStarted = () => {};
    const flushStarted = new Promise<void>((resolve) => {
      markFlushStarted = resolve;
    });
    let foregroundCompleted = false;
    const requestBudget = {
      contextWindow: 32_768,
      reserveTokens: 8_192,
      fixedTokens: 9_500,
      pendingTokens: 512,
    };
    let flushParameters: Parameters<typeof state.runMemoryFlushIfNeededMock>[0] | undefined;
    state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
      params.onSuccessfulAuthProfile?.({});
      params.onCompactionRequestBudget?.(requestBudget);
      return makeCompactionResult({
        sessionId,
        text: "Completed foreground answer.",
        runner: "embedded",
        agentHarnessId: "openclaw",
      });
    });
    state.runMemoryFlushIfNeededMock.mockImplementationOnce(async (params) => {
      flushParameters = params;
      markFlushStarted();
      await flush;
      return { sessionEntry: params.sessionEntry, outcome: "completed" };
    });
    const command = agentCommandFromGatewayIngress(
      {
        message: "continue",
        sessionId,
        sessionKey,
        allowModelOverride: true,
        runContext: {
          messageChannel: "webchat",
          accountId: "primary",
          groupId: "group-42",
          groupChannel: "channel-42",
          groupSpace: "space-42",
        },
      },
      ...GATEWAY_INGRESS_ARGS,
    ).then((result) => {
      foregroundCompleted = true;
      return result;
    });
    try {
      await flushStarted;
      expect(foregroundCompleted).toBe(true);
      expect(flushParameters?.followupRun.run).toMatchObject({
        messageProvider: "webchat",
        agentAccountId: "primary",
        groupId: "group-42",
        groupChannel: "channel-42",
        groupSpace: "space-42",
        senderIsOwner: false,
      });
      expect(state.deliverAgentCommandResultMock).toHaveBeenCalledWith(
        expect.objectContaining({
          payloads: [{ text: "Completed foreground answer." }],
        }),
      );
      expect(readCompactionLifecyclePhases()).toContain("end");
      expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
    } finally {
      releaseFlush();
      await command;
      await waitForSessionMaintenance(sessionKey);
    }
    expect(state.runSessionCompactionIfNeededMock).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionRequestBudget: { ...requestBudget, pendingTokens: 0 },
      }),
    );
  });

  it.each(["cli", "embedded"] as const)(
    "preserves the %s one-shot compaction boundary before delivery",
    async (runner) => {
      const sessionId = `one-shot-compaction-${runner}`;
      const sessionKey = `agent:main:explicit:${sessionId}`;
      const compactionStarted = createDeferred();
      const releaseCompaction = createDeferred();
      const events: string[] = [];
      state.runAgentAttemptMock.mockImplementationOnce(async (params) => {
        params.onSuccessfulAuthProfile?.({});
        return makeCompactionResult({
          sessionId,
          text: "one-shot answer",
          runner,
          agentHarnessId: "openclaw",
        });
      });
      state.runCliTurnCompactionLifecycleMock.mockImplementationOnce(async (params) => {
        events.push("compaction started");
        compactionStarted.resolve();
        await releaseCompaction.promise;
        events.push("compaction completed");
        return params.sessionEntry;
      });
      state.deliverAgentCommandResultMock.mockImplementationOnce(async () => {
        events.push("delivery");
        return { deliverySucceeded: true };
      });
      const command = agentCommand({
        message: "complete once",
        sessionId,
        sessionKey,
        oneShotCliRun: true,
      });
      try {
        if (runner === "cli") {
          await expect(
            Promise.race([
              compactionStarted.promise.then(() => "compaction"),
              command.then(() => "command completed before compaction"),
            ]),
          ).resolves.toBe("compaction");
          expect(state.deliverAgentCommandResultMock).not.toHaveBeenCalled();
          releaseCompaction.resolve();
        }
        await command;
        await waitForSessionMaintenance(sessionKey);

        expect(events).toEqual(
          runner === "cli"
            ? ["compaction started", "compaction completed", "delivery"]
            : ["delivery"],
        );
        expect(state.runCliTurnCompactionLifecycleMock).toHaveBeenCalledTimes(
          runner === "cli" ? 1 : 0,
        );
        expect(state.runSessionCompactionIfNeededMock).not.toHaveBeenCalled();
        expect(state.runMemoryFlushIfNeededMock).not.toHaveBeenCalled();
        expect(state.deliverAgentCommandResultMock).toHaveBeenCalledOnce();
      } finally {
        releaseCompaction.resolve();
        await Promise.allSettled([command]);
        await waitForSessionMaintenance(sessionKey);
      }
    },
  );
});
