import path from "node:path";
import { Worker } from "node:worker_threads";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../../config/sessions/session-accessor.sqlite-scope.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
} from "../../../config/sessions/session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerMessage } from "../../../config/sessions/session-transcript-reconcile.worker.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-prepare.js";

function createActiveSession(messages: AgentMessage[] = []) {
  const reset = vi.fn();
  const convertToLlm = vi.fn((input: AgentMessage[]) => input as never);
  const activeSession = {
    agent: {
      reset,
      state: { messages },
      convertToLlm,
    },
  } as unknown as Pick<AgentSession, "agent">;
  return { activeSession, convertToLlm, reset };
}

function createSessionManager(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof guardSessionManager> {
  return {
    getLeafEntry: () => undefined,
    getSessionTarget: () => undefined,
    ...overrides,
  } as unknown as ReturnType<typeof guardSessionManager>;
}

async function withPersistedOrphanBoundary(
  options: { parent: boolean; metadata: boolean },
  run: (fixture: {
    input: Parameters<typeof prepareEmbeddedAttemptSessionBoundary>[0];
    manager: SessionManager;
    orphanId: string;
    target: NonNullable<ReturnType<SessionManager["getSessionTarget"]>>;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ label: "orphan-projection" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "orphan-projection",
      sessionKey: "agent:main:orphan-projection",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const seed = SessionManager.open(target, state.workspaceDir);
    if (options.parent) {
      seed.appendModelChange("openai", "gpt-5.5");
    }
    const orphanId = seed.appendMessage({ role: "user", content: "orphan wake", timestamp: 1 });
    if (options.metadata) {
      seed.appendThinkingLevelChange("low");
      seed.appendModelChange("openai", "gpt-5.5");
    }
    const manager = SessionManager.openBounded(target, {
      cwd: state.workspaceDir,
      maxBytes: 4096,
      maxEvents: 20,
    });
    const { activeSession } = createActiveSession(manager.buildSessionContext().messages);
    await run({
      input: {
        activeSession,
        attempt: { prompt: "new request", trigger: "user" },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: undefined,
        sessionManager: manager as ReturnType<typeof guardSessionManager>,
        setActiveSessionSystemPrompt: vi.fn(),
      },
      manager,
      orphanId,
      target,
    });
  });
}

describe("prepareEmbeddedAttemptSessionBoundary", () => {
  it.each(["aborted", "rebound-writer"] as const)(
    "does not persist orphan repair for an unavailable owner: %s",
    async (reason) => {
      await withPersistedOrphanBoundary(
        { parent: true, metadata: true },
        async ({ input, target }) => {
          const before = loadTranscriptEventsSync(target);
          const invalidated = vi.fn();
          input.attempt.onUserMessagePersistenceInvalidated = invalidated;
          if (reason === "aborted") {
            input.abortSignal = AbortSignal.abort(new Error("cancel before repair"));
          }
          const prepare = () => prepareEmbeddedAttemptSessionBoundary(input);
          const preparing =
            reason === "rebound-writer"
              ? withOwnedSessionTranscriptWrites(
                  {
                    sessionTarget: { ...target, expectedWriterRunId: "replaced-owner" },
                    withTranscriptWrite: async (operation) => await operation(),
                  },
                  prepare,
                )
              : prepare();
          await expect(preparing).rejects.toThrow(
            reason === "aborted"
              ? "cancel before repair"
              : SessionTranscriptWriterClaimReboundError,
          );
          expect(loadTranscriptEventsSync(target)).toEqual(before);
          expect(invalidated).not.toHaveBeenCalled();
        },
      );
    },
  );

  it("cancels its projection wait before publishing repaired prompt state", async () => {
    await withPersistedOrphanBoundary(
      { parent: true, metadata: true },
      async ({ input, target }) => {
        const claimed = createDeferred();
        const databaseOptions = toDatabaseOptions(resolveSqliteTranscriptScope(target));
        let releaseWorker: (() => void) | undefined;
        startSessionTranscriptIndexReconcile({
          ...databaseOptions,
          createWorker: (filename, options) => {
            const worker = new Worker(filename, options);
            const postMessage = worker.postMessage.bind(worker);
            let claiming = false;
            worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
              claiming = message.type === "plan-start";
            });
            // Hold the real worker after the owner claims the dirty projection.
            // No fixture sleeps or database mutation decides the ordering.
            worker.postMessage = (message: unknown, transferList) => {
              if (claiming && !releaseWorker) {
                releaseWorker = () => postMessage(message, transferList);
                claimed.resolve();
                return;
              }
              postMessage(message, transferList);
            };
            return worker;
          },
        });
        const controller = new AbortController();
        input.abortSignal = controller.signal;
        const messages = input.activeSession.agent.state.messages;
        const invalidated = vi.fn();
        input.attempt.onUserMessagePersistenceInvalidated = invalidated;
        const preparing = prepareEmbeddedAttemptSessionBoundary(input);
        const outcome = preparing.then(
          () => ({ kind: "resolved" as const }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
        try {
          await Promise.race([
            claimed.promise,
            outcome.then(() => {
              throw new Error("repair settled before its projection was claimed");
            }),
          ]);
          const abortReason = new Error("cancel owned projection wait");
          controller.abort(abortReason);
          await expect(outcome).resolves.toMatchObject({
            kind: "rejected",
            error: { name: "AbortError", cause: abortReason },
          });
          expect(input.activeSession.agent.state.messages).toBe(messages);
          expect(invalidated).not.toHaveBeenCalled();
        } finally {
          releaseWorker?.();
          await Promise.all([outcome, waitForSessionTranscriptIndexReconcile(databaseOptions)]);
        }
      },
    );
  });

  it.each([
    { parent: true, metadata: true },
    { parent: true, metadata: false },
    { parent: false, metadata: true },
    { parent: false, metadata: false },
  ])("settles its orphan repair before subsequent parent adoption: %j", async (options) => {
    await withPersistedOrphanBoundary(options, async ({ input, manager, orphanId, target }) => {
      const boundary = await prepareEmbeddedAttemptSessionBoundary(input);
      expect(boundary.orphanRepair?.removeLeaf).toBe(true);
      const reopened = SessionManager.openBounded(target, { maxBytes: 4096, maxEvents: 20 });
      expect(reopened.getBranch().map((entry) => entry.id)).not.toContain(orphanId);
      expect(loadTranscriptEventsSync(target)).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: orphanId })]),
      );
      expect(
        appendTranscriptMessageSync(target, {
          eventId: "out-of-band",
          message: { role: "assistant", content: "external continuation", timestamp: 2 },
        }).ok,
      ).toBe(true);
      const appended = manager.appendMessageWithTranscriptAnchor({
        role: "user",
        content: "replacement",
        timestamp: 3,
      });
      expect(appended.anchor?.effectiveParentId).toBe("out-of-band");
      expect(manager.getEntry(appended.entryId)?.parentId).toBe("out-of-band");
    });
  });

  it("resets restored state and preserves exact prompt bytes for raw model probes", async () => {
    const { activeSession, reset } = createActiveSession();
    const setActiveSessionSystemPrompt = vi.fn();

    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "exact probe" },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: true,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt,
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "exact probe" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).toHaveBeenCalledOnce();
    expect(setActiveSessionSystemPrompt).toHaveBeenCalledWith("");
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("exact probe");
    expect((converted[0] as { content?: unknown }).content).not.toContain("Conversation info");
  });

  it("preserves settled history while isolating the finalization prompt", async () => {
    const { activeSession, reset } = createActiveSession();
    const sessionManager = createSessionManager({
      getLeafEntry: () => ({
        id: "user-leaf",
        parentId: "parent-entry",
        type: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
    });
    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        operation: "settled-tool-finalization",
        prompt: "finalize exactly",
        trigger: "user",
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager,
      setActiveSessionSystemPrompt: vi.fn(),
    });
    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "finalize exactly" }],
        timestamp: 1,
        __openclaw: { senderName: "Must not leak" },
      } as AgentMessage,
    ]);

    expect(reset).not.toHaveBeenCalled();
    expect(boundary).toMatchObject({
      boundaryTimezone: undefined,
      includeBoundaryTimestamp: false,
      orphanRepair: undefined,
    });
    expect((converted[0] as { content?: unknown }).content).toBe("finalize exactly");
  });

  it("applies the prepared current-turn timestamp at the LLM boundary", async () => {
    const { activeSession } = createActiveSession();
    const preparedTimestamp = 1_717_570_800_000;
    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        config: { agents: { defaults: { userTimezone: "UTC" } } },
        prompt: "Current ask",
        trigger: "user",
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });
    boundary.setCurrentUserTimestampOverride({
      timestamp: preparedTimestamp,
      text: "Current ask",
    });

    const converted = await activeSession.agent.convertToLlm([
      {
        role: "user",
        content: [{ type: "text", text: "Current ask" }],
        timestamp: preparedTimestamp + 60_000,
      },
    ]);

    expect((converted[0] as { content?: unknown }).content).toBe(
      `${buildTimestampPrefix(new Date(preparedTimestamp), { timezone: "UTC" })}Current ask`,
    );
  });

  it("projects the exact persisted sender row for the active user turn", async () => {
    const runtimeMessage = {
      role: "user",
      content: [{ type: "text", text: "The launch is Friday" }],
      timestamp: 1,
    } as AgentMessage;
    const transcriptMessage = {
      role: "user",
      content: "The launch is Friday",
      timestamp: 1,
      __openclaw: { senderId: "alice-id", senderName: "Alice" },
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "The launch is Friday", trigger: "user" },
      getUserTranscriptContexts: () => [{ runtimeMessage, transcriptMessage }],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const converted = await activeSession.agent.convertToLlm([runtimeMessage]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name":"Alice"');
  });

  it("retains sender projection for earlier in-memory turns after a queued turn", async () => {
    const initialRuntime = {
      role: "user",
      content: [{ type: "text", text: "The launch is Friday" }],
      timestamp: 1,
    } as AgentMessage;
    const queuedRuntime = {
      role: "user",
      content: [{ type: "text", text: "I can present it" }],
      timestamp: 2,
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "The launch is Friday", trigger: "user" },
      getUserTranscriptContexts: () => [
        {
          runtimeMessage: initialRuntime,
          transcriptMessage: {
            role: "user",
            content: "The launch is Friday",
            timestamp: 1,
            __openclaw: { senderId: "alice-id", senderName: "Alice" },
          } as AgentMessage,
        },
        {
          runtimeMessage: queuedRuntime,
          transcriptMessage: {
            role: "user",
            content: "I can present it",
            timestamp: 2,
            __openclaw: { senderId: "bob-id", senderName: "Bob" },
          } as AgentMessage,
        },
      ],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const converted = await activeSession.agent.convertToLlm([initialRuntime, queuedRuntime]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name":"Alice"');
    expect((converted[1] as { content?: unknown }).content).toContain('"name":"Bob"');
  });

  it("reserves exact pairings before matching duplicate timestamp and text", async () => {
    const firstRuntime = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    } as AgentMessage;
    const secondRuntime = {
      role: "user",
      content: [{ type: "text", text: "same" }],
      timestamp: 1,
    } as AgentMessage;
    const { activeSession } = createActiveSession();
    await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: { prompt: "same", trigger: "user" },
      getUserTranscriptContexts: () => [
        {
          runtimeMessage: secondRuntime,
          transcriptMessage: {
            role: "user",
            content: "same",
            timestamp: 1,
            __openclaw: { senderName: "Bob" },
          } as AgentMessage,
        },
        {
          runtimeMessage: firstRuntime,
          transcriptMessage: {
            role: "user",
            content: "same",
            timestamp: 1,
            __openclaw: { senderName: "Alice" },
          } as AgentMessage,
        },
      ],
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager: createSessionManager(),
      setActiveSessionSystemPrompt: vi.fn(),
    });

    const converted = await activeSession.agent.convertToLlm([firstRuntime, secondRuntime]);

    expect((converted[0] as { content?: unknown }).content).toContain('"name":"Alice"');
    expect((converted[1] as { content?: unknown }).content).toContain('"name":"Bob"');
  });

  it.each([false, true])(
    "preserves the admitted current user with persistence suppression set to %s",
    async (suppressNextUserMessagePersistence) => {
      const currentUser = {
        role: "user" as const,
        content: "current prompt",
        idempotencyKey: "current-run:user",
        timestamp: 1,
      };
      const { activeSession } = createActiveSession([currentUser]);
      const branch = vi.fn();
      const resetLeaf = vi.fn();
      const clearNextUserMessagePersistenceSuppression = vi.fn();
      const onUserMessagePersistenceInvalidated = vi.fn();
      const sessionManager = createSessionManager({
        branch,
        resetLeaf,
        clearNextUserMessagePersistenceSuppression,
        getLeafEntry: () => ({
          id: "current-user",
          parentId: "previous-assistant",
          timestamp: "2026-07-13T00:00:00.000Z",
          type: "message",
          message: currentUser,
        }),
      });
      const recorder = {
        hasPersisted: () => true,
      } as NonNullable<
        Parameters<
          typeof prepareEmbeddedAttemptSessionBoundary
        >[0]["attempt"]["userTurnTranscriptRecorder"]
      >;

      const boundary = await prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: {
          onUserMessagePersistenceInvalidated,
          prompt: "current prompt",
          suppressNextUserMessagePersistence,
          trigger: "user",
          userTurnTranscriptRecorder: recorder,
        },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: currentUser,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });

      expect(boundary.orphanRepair).toBeUndefined();
      expect(activeSession.agent.state.messages).toEqual([]);
      expect(branch).not.toHaveBeenCalled();
      expect(resetLeaf).not.toHaveBeenCalled();
      expect(clearNextUserMessagePersistenceSuppression).not.toHaveBeenCalled();
      expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "the active-session copy is absent", prepared: true, recorded: false, persisted: true },
    {
      name: "only the recorder owns the durable user",
      prepared: false,
      recorded: true,
      persisted: true,
    },
    {
      name: "recorder state is lost on restart",
      prepared: true,
      recorded: false,
      persisted: false,
    },
  ])(
    "preserves the admitted current user when $name",
    async ({ prepared, recorded, persisted }) => {
      const currentUser = {
        role: "user" as const,
        content: "current prompt",
        idempotencyKey: "current-run:user",
        timestamp: 1,
      };
      const { activeSession } = createActiveSession([]);
      const branch = vi.fn();
      const resetLeaf = vi.fn();
      const clearNextUserMessagePersistenceSuppression = vi.fn();
      const onUserMessagePersistenceInvalidated = vi.fn();
      const sessionManager = createSessionManager({
        branch,
        resetLeaf,
        clearNextUserMessagePersistenceSuppression,
        getLeafEntry: () => ({
          id: "current-user",
          parentId: "previous-assistant",
          timestamp: "2026-07-13T00:00:00.000Z",
          type: "message",
          message: currentUser,
        }),
      });
      const recorder = {
        hasPersisted: () => persisted,
        ...(recorded ? { getPersistedMessage: () => currentUser } : {}),
      } as NonNullable<
        Parameters<
          typeof prepareEmbeddedAttemptSessionBoundary
        >[0]["attempt"]["userTurnTranscriptRecorder"]
      >;
      const boundary = await prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: {
          onUserMessagePersistenceInvalidated,
          prompt: "current prompt",
          trigger: "user",
          userTurnTranscriptRecorder: recorder,
        },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: prepared ? currentUser : undefined,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });
      expect(boundary.orphanRepair).toBeUndefined();
      expect(activeSession.agent.state.messages).toEqual([]);
      expect(branch).not.toHaveBeenCalled();
      expect(resetLeaf).not.toHaveBeenCalled();
      expect(clearNextUserMessagePersistenceSuppression).not.toHaveBeenCalled();
      expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "handles a different durable user leaf with current-turn exclusion %s",
    async (excludeFromContext) => {
      const currentUser = {
        role: "user" as const,
        content: "current prompt",
        idempotencyKey: "current-run:user",
        excludeFromContext,
        timestamp: 2,
      };
      const repairedMessages: AgentMessage[] = [currentUser];
      const { activeSession } = createActiveSession([]);
      const branch = vi.fn();
      const clearNextUserMessagePersistenceSuppression = vi.fn();
      const onUserMessagePersistenceInvalidated = vi.fn();
      const sessionManager = createSessionManager({
        getLeafEntry: () => ({
          id: "orphan-user",
          parentId: "previous-assistant",
          timestamp: "2026-07-13T00:00:00.000Z",
          type: "message",
          message: {
            role: "user",
            content: "old prompt",
            idempotencyKey: "previous-run:user",
            timestamp: 1,
          },
        }),
        branch,
        clearNextUserMessagePersistenceSuppression,
        buildSessionContext: () => ({ messages: repairedMessages }),
      });
      const recorder = {
        getPersistedMessage: () => currentUser,
        hasPersisted: () => true,
      } as unknown as NonNullable<
        Parameters<
          typeof prepareEmbeddedAttemptSessionBoundary
        >[0]["attempt"]["userTurnTranscriptRecorder"]
      >;

      const boundary = await prepareEmbeddedAttemptSessionBoundary({
        activeSession,
        attempt: {
          onUserMessagePersistenceInvalidated,
          prompt: "current prompt",
          trigger: "user",
          userTurnTranscriptRecorder: recorder,
        },
        getUserTranscriptContexts: () => undefined,
        isRawModelRun: false,
        preparedUserTurnMessage: undefined,
        sessionManager,
        setActiveSessionSystemPrompt: vi.fn(),
      });

      if (excludeFromContext) {
        expect(boundary.orphanRepair).toBeUndefined();
        expect(branch).not.toHaveBeenCalled();
        expect(clearNextUserMessagePersistenceSuppression).not.toHaveBeenCalled();
        expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
        expect(activeSession.agent.state.messages).toEqual([]);
      } else {
        expect(boundary.orphanRepair?.removeLeaf).toBe(true);
        expect(branch).toHaveBeenCalledWith("previous-assistant");
        expect(clearNextUserMessagePersistenceSuppression).toHaveBeenCalledOnce();
        expect(onUserMessagePersistenceInvalidated).toHaveBeenCalledOnce();
        expect(activeSession.agent.state.messages).toBe(repairedMessages);
      }
    },
  );

  it("repairs an orphaned user leaf before rebuilding active session messages", async () => {
    const repairedMessages: AgentMessage[] = [
      { role: "user", content: [{ type: "text", text: "repaired" }], timestamp: 2 },
    ];
    const { activeSession } = createActiveSession([
      { role: "user", content: [{ type: "text", text: "old" }], timestamp: 1 },
    ]);
    const branch = vi.fn();
    const clearNextUserMessagePersistenceSuppression = vi.fn();
    const onUserMessagePersistenceInvalidated = vi.fn();
    const sessionManager = createSessionManager({
      getLeafEntry: () => ({
        id: "user-leaf",
        parentId: "parent-entry",
        type: "message",
        timestamp: "2026-07-13T00:00:00.000Z",
        message: { role: "user", content: "old" },
      }),
      branch,
      clearNextUserMessagePersistenceSuppression,
      buildSessionContext: () => ({ messages: repairedMessages }),
    });

    const boundary = await prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        onUserMessagePersistenceInvalidated,
        prompt: "new",
        trigger: "user",
      },
      getUserTranscriptContexts: () => undefined,
      isRawModelRun: false,
      preparedUserTurnMessage: undefined,
      sessionManager,
      setActiveSessionSystemPrompt: vi.fn(),
    });

    expect(boundary.orphanRepair?.removeLeaf).toBe(true);
    expect(branch).toHaveBeenCalledWith("parent-entry");
    expect(clearNextUserMessagePersistenceSuppression).toHaveBeenCalledOnce();
    expect(onUserMessagePersistenceInvalidated).toHaveBeenCalledOnce();
    expect(activeSession.agent.state.messages).toBe(repairedMessages);
  });
});
