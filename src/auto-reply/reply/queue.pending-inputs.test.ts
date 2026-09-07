import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptMessage,
  listSessionPendingInputs,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
  type UserTurnTranscriptRecorder,
} from "../../sessions/user-turn-transcript.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { executeAgentTurn } from "./agent-runner-execution.js";
import { executeFollowupTurn } from "./followup-turn-execution.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  FollowupRunDeferredError,
  scheduleFollowupDrain,
  type FollowupRun,
} from "./queue.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { createTypingController } from "./typing.js";

vi.mock("./agent-runner-execution.js", () => ({ executeAgentTurn: vi.fn() }));

describe("followup queue durable input consumption", () => {
  const fixture = useTempSessionsFixture("openclaw-queue-pending-");
  let caseSequence = 0;
  let sessionKey = "";
  const sessionId = "queue-pending-session";
  const recorders: UserTurnTranscriptRecorder[] = [];
  const scope = () => ({ agentId: "main", sessionId, sessionKey, storePath: fixture.storePath() });

  beforeEach(async () => {
    sessionKey = `agent:main:queue-pending-${++caseSequence}`;
    vi.mocked(executeAgentTurn).mockReset();
    await upsertSessionEntryCore(scope(), { sessionId, updatedAt: 1 });
  });

  afterEach(() => {
    clearFollowupQueue(sessionKey);
    for (const recorder of recorders.splice(0)) {
      recorder.finishPendingInput?.("interrupted");
    }
    closeOpenClawAgentDatabasesForTest();
  });

  const createStagedRun = async (runId: string) => {
    const beforeMessageWrite = vi.fn((params: { message: PersistedUserTurnMessage }) => ({
      ...params.message,
      content: `${runId} approved`,
    }));
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: `${runId} private source`, idempotencyKey: `${runId}:user` },
      target: { ...scope(), sessionEntry: undefined },
      beforeMessageWrite,
      updateMode: "none",
    });
    recorders.push(recorder);
    expect(await recorder.stageApproved?.({ runId, assertCurrent: () => {} })).toBe(true);
    const run: FollowupRun = {
      ...createQueueTestRun({ prompt: `${runId} approved`, messageId: runId }),
      // A stale display projection must not undo the approval when sources combine.
      transcriptPrompt: `${runId} private source`,
      userTurnTranscriptRecorder: recorder,
      currentInboundContext: { text: `${runId} runtime context` },
      turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: async () => {} },
      run: {
        ...createQueueTestRun({ prompt: "" }).run,
        agentId: "main",
        sessionKey,
        sessionId,
        config: { session: { store: fixture.storePath() } },
      },
    };
    return { run, beforeMessageWrite };
  };

  const persistQueuedRun = async (run: FollowupRun) => {
    const recorder = run.userTurnTranscriptRecorder;
    if (!recorder?.withPendingInput) {
      throw new Error("queued turn is missing its transcript owner");
    }
    return await recorder.withPendingInput(() => recorder.persistApproved());
  };

  it("preserves the committed prefix when a native batch falls back after a later source write fails", async () => {
    const first = await createStagedRun("first");
    const second = await createStagedRun("second");
    await persistQueuedRun(first.run);
    const database = openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteScope(scope()))).db;
    database.exec(
      "CREATE TEMP TRIGGER fail_second_source BEFORE INSERT ON transcript_events WHEN instr(NEW.event_json, 'second:user') > 0 BEGIN SELECT RAISE(ABORT, 'injected second source failure'); END",
    );
    try {
      await expect(persistQueuedRun(second.run)).rejects.toThrow("injected second source failure");
    } finally {
      database.exec("DROP TRIGGER fail_second_source");
    }
    expect(first.run.userTurnTranscriptRecorder?.hasPersisted()).toBe(true);
    expect(second.run.userTurnTranscriptRecorder?.hasPersisted()).toBe(false);
    const before = await loadTranscriptEvents(scope());
    const settings = { mode: "collect" as const, debounceMs: 0 };
    expect(enqueueFollowupRun(sessionKey, first.run, settings)).toBe(true);
    expect(enqueueFollowupRun(sessionKey, second.run, settings)).toBe(true);
    const prompts: string[] = [];
    const consumers: UserTurnTranscriptRecorder[] = [];
    const failures: unknown[] = [];
    scheduleFollowupDrain(sessionKey, async (run) => {
      try {
        await admitFollowupRunLifecycle(run);
        await persistQueuedRun(run);
        prompts.push(run.prompt);
        consumers.push(run.userTurnTranscriptRecorder!);
      } catch (error) {
        failures.push(error);
      }
    });
    await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());
    expect(failures).toEqual([]);
    expect(prompts).toEqual(["first approved", "second approved"]);
    expect(consumers).toEqual([
      first.run.userTurnTranscriptRecorder,
      second.run.userTurnTranscriptRecorder,
    ]);
    const after = await loadTranscriptEvents(scope());
    expect(after.slice(0, before.length)).toEqual(before);
    const messages = after.filter(isRecord).filter((event) => event.type === "message");
    expect(messages.map((event) => event.message)).toEqual([
      expect.objectContaining({ content: "first approved", idempotencyKey: "first:user" }),
      expect.objectContaining({ content: "second approved", idempotencyKey: "second:user" }),
    ]);
    expect(listSessionPendingInputs(scope()).items).toEqual([]);
    expect(first.beforeMessageWrite).toHaveBeenCalledOnce();
    expect(second.beforeMessageWrite).toHaveBeenCalledOnce();
  });

  it("keeps unstaged input out of an already-approved collect group", async () => {
    const staged = await createStagedRun("staged");
    const unstaged: FollowupRun = {
      ...staged.run,
      prompt: "unstaged runtime body",
      transcriptPrompt: "unstaged transcript body",
      messageId: "unstaged",
      userTurnTranscriptRecorder: createUserTurnTranscriptRecorder({
        input: { text: "unstaged transcript body" },
        target: { ...scope(), sessionEntry: undefined },
      }),
      turnAdoptionLifecycle: { admission: "cancel-only", onAdopted: async () => {} },
    };
    const settings = { mode: "collect" as const, debounceMs: 0 };
    expect(enqueueFollowupRun(sessionKey, staged.run, settings)).toBe(true);
    expect(enqueueFollowupRun(sessionKey, unstaged, settings)).toBe(true);
    const calls: FollowupRun[] = [];
    scheduleFollowupDrain(sessionKey, async (run) => {
      calls.push(run);
    });
    await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());

    expect(calls.map((run) => run.prompt)).toEqual([
      "[Queued messages while agent was busy]\n\n---\nQueued #1\nstaged approved",
      "[Queued messages while agent was busy]\n\n---\nQueued #1\nunstaged runtime body",
    ]);
    expect(calls[1]?.transcriptPrompt).toContain("unstaged transcript body");
  });

  it.each([false, true])(
    "binds collected custody before runtime append (cancel during preparation: %s)",
    async (abortDuringPreparation) => {
      const first = await createStagedRun("first");
      const second = await createStagedRun("second");
      first.run.prompt = "first private source";
      second.run.prompt = "second private source";
      const settings = { mode: "collect" as const, debounceMs: 0 };
      expect(enqueueFollowupRun(sessionKey, first.run, settings)).toBe(true);
      expect(enqueueFollowupRun(sessionKey, second.run, settings)).toBe(true);
      const calls: FollowupRun[] = [];
      const failures: unknown[] = [];
      const pendingTotals: number[] = [];
      vi.mocked(executeAgentTurn).mockImplementation(async (params) => {
        const message = await params.followupRun.userTurnTranscriptRecorder?.resolveMessage();
        if (!message) {
          throw new Error("runtime user message missing");
        }
        // The runtime writes directly, not through the recorder's self-persistence helper.
        await appendTranscriptMessage(scope(), { message });
        return { runId: "collected-run", outcome: { kind: "rejected", payload: { text: "done" } } };
      });
      scheduleFollowupDrain(sessionKey, async (run) => {
        calls.push(run);
        const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
        const typing = createTypingController({});
        try {
          pendingTotals.push(listSessionPendingInputs(scope()).total);
          await admitFollowupRunLifecycle(run);
          if (abortDuringPreparation) {
            const recorder = second.run.userTurnTranscriptRecorder!;
            const resolveMessage = recorder.resolveMessage;
            vi.spyOn(recorder, "resolveMessage").mockImplementation(async () => {
              await Promise.resolve();
              operation.abortForRestart();
              return resolveMessage();
            });
          }
          await executeFollowupTurn({
            turn: {
              runId: "collected-run",
              queued: run,
              operation,
              config: run.run.config,
              session: {
                kind: "detached",
                current: () => undefined,
                publish: () => {},
                adopt: () => {},
              },
              sendPolicy: "allow",
              preflightCompactionApplied: false,
            },
            defaults: { typing, typingMode: "never", defaultModel: "gpt-test" },
            onToolResult: async () => {},
            onCompactionNoticePayload: async () => {},
          });
          pendingTotals.push(listSessionPendingInputs(scope()).total);
        } catch (error) {
          failures.push(error);
        } finally {
          operation.complete();
          typing.cleanup();
        }
      });
      await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());

      expect(failures).toHaveLength(abortDuringPreparation ? 1 : 0);
      expect(pendingTotals).toEqual(abortDuringPreparation ? [2] : [2, 0]);
      expect(calls).toHaveLength(1);
      expect(executeAgentTurn).toHaveBeenCalledTimes(abortDuringPreparation ? 0 : 1);
      const expected =
        "[Queued messages while agent was busy]\n\n---\nQueued #1\nfirst approved\n\n---\nQueued #2\nsecond approved";
      expect(calls[0]?.prompt).toBe(expected);
      expect(calls[0]?.transcriptPrompt).toBe(expected);
      expect(calls[0]?.currentInboundContext?.text).toBe(
        "Queued #1 context:\nfirst runtime context\n\nQueued #2 context:\nsecond runtime context",
      );
      const messages = (await loadTranscriptEvents(scope()))
        .filter(isRecord)
        .filter((event) => event.type === "message");
      expect(messages).toHaveLength(abortDuringPreparation ? 0 : 1);
      if (!abortDuringPreparation) {
        expect(messages[0]?.message).toMatchObject({ role: "user", content: expected });
      }
      expect(listSessionPendingInputs(scope()).total).toBe(abortDuringPreparation ? 2 : 0);
      expect(first.beforeMessageWrite).toHaveBeenCalledOnce();
      expect(second.beforeMessageWrite).toHaveBeenCalledOnce();
    },
  );

  it("retains elided and retried overflow sources until their summary commits", async () => {
    const sources = await Promise.all(["first", "second", "third"].map(createStagedRun));
    const settings = {
      mode: "followup" as const,
      debounceMs: 0,
      cap: 1,
      dropPolicy: "summarize" as const,
    };
    for (const source of sources) {
      source.run.summaryLine = `${source.run.messageId} private summary`;
      expect(enqueueFollowupRun(sessionKey, source.run, settings)).toBe(true);
    }
    const calls: FollowupRun[] = [];
    const failures: unknown[] = [];
    const pendingRunIds: string[][] = [];
    scheduleFollowupDrain(sessionKey, async (run) => {
      calls.push(run);
      if (calls.length === 1) {
        throw new FollowupRunDeferredError();
      }
      try {
        await admitFollowupRunLifecycle(run);
        await persistQueuedRun(run);
        pendingRunIds.push(listSessionPendingInputs(scope()).items.map((input) => input.runId));
      } catch (error) {
        failures.push(error);
      }
    });
    await vi.waitFor(() => expect(getExistingFollowupQueue(sessionKey)).toBeUndefined());

    expect(failures).toEqual([]);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.prompt).toBe(
      "[Queue overflow] Dropped 2 messages due to cap.\nSummary:\n- second approved",
    );
    expect(pendingRunIds).toEqual([["third"], []]);
    const messages = (await loadTranscriptEvents(scope()))
      .filter(isRecord)
      .filter((event) => event.type === "message");
    expect(messages).toHaveLength(2);
    expect(messages[0]?.message).toMatchObject({ content: calls[1]?.prompt });
    expect(messages[1]?.message).toMatchObject({ content: "third approved" });
    expect(sources.map((source) => source.beforeMessageWrite.mock.calls.length)).toEqual([1, 1, 1]);
  });
});
