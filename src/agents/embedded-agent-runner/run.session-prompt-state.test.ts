import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";

const assertActive = () => {};

const CONTINUE_FROM_TRANSCRIPT_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";
const CONTINUE_AFTER_TOOL_FAILURE_PROMPT = `${CONTINUE_FROM_TRANSCRIPT_PROMPT} If a tool failed, say so; never claim completion or success.`;

const BASE_RUN_PARAMS = {
  admittedRunContext: createTestAdmittedRunContext("run-1"),
  agentId: "main",
  sessionId: "test-session",
  sessionKey: "agent:main:test-key",
  sessionFile: "agent:main:test-key",
  sessionTarget: {
    agentId: "main",
    sessionId: "test-session",
    sessionKey: "agent:main:test-key",
    storePath: "/tmp/openclaw-test.sqlite",
  },
  workspaceDir: "/tmp/workspace",
  prompt: "hello",
  timeoutMs: 30_000,
  runId: "run-1",
} satisfies PreparedEmbeddedRunInput["runParams"];

const TEST_ADMISSION = {
  agentId: "main",
  sessionId: BASE_RUN_PARAMS.sessionId,
  sessionKey: BASE_RUN_PARAMS.sessionKey,
  storePath: BASE_RUN_PARAMS.sessionTarget.storePath,
  generation: "test-generation",
  entryId: "msg-user-1",
  rawSeq: 1,
  effectiveParentId: null,
  activeMessagePosition: 0,
  logicalTurnId: "test-logical-turn",
  role: "user" as const,
};

function makeUserMessage(content = BASE_RUN_PARAMS.prompt) {
  return { role: "user" as const, content, timestamp: 1 };
}

function createRecorder(
  overrides: Partial<UserTurnTranscriptRecorder> = {},
): UserTurnTranscriptRecorder {
  let pendingPersistence: Promise<void> | undefined;
  return {
    message: makeUserMessage(),
    resolveMessage: vi.fn(async () => makeUserMessage()),
    getAdmissionReceipt: () => TEST_ADMISSION,
    markRuntimePersistencePending: vi.fn((pending) => {
      pendingPersistence = pending;
    }),
    markRuntimePersisted: vi.fn(),
    markBlocked: vi.fn(),
    hasPersisted: vi.fn(() => false),
    isBlocked: vi.fn(() => false),
    hasRuntimePersistencePending: vi.fn(() => pendingPersistence !== undefined),
    waitForRuntimePersistence: vi.fn(async () => {
      await pendingPersistence;
    }),
    persistApproved: vi.fn(async () => undefined),
    persistBlocked: vi.fn(async () => undefined),
    persistFallback: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createState(
  overrides: Partial<
    Omit<PreparedEmbeddedRunInput["runParams"], "compactionCountOwner" | "onCompactionAccounting">
  > = {},
) {
  return createEmbeddedRunSessionPromptState({
    runParams: { ...BASE_RUN_PARAMS, ...overrides },
    sessionAgentId: "main",
    resolvedSessionKey: BASE_RUN_PARAMS.sessionKey,
    lifecycleGeneration: "test-generation",
  });
}

describe("embedded run session prompt state", () => {
  it("adds failed-tool guidance to current-transcript continuation", () => {
    const state = createState();

    state.continueFromCurrentTranscript({ includeToolFailureInstruction: true });

    expect(state.activePrompt).toEqual({
      override: CONTINUE_AFTER_TOOL_FAILURE_PROMPT,
      persisted: true,
      internal: true,
    });
  });

  it("settles projection maintenance only for an owned transcript retry", async () => {
    const reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
    const waitForProjection = vi
      .spyOn(reconcile, "waitForSessionTranscriptProjection")
      .mockResolvedValue();
    const state = createState();
    const abortSignal = new AbortController().signal;

    try {
      await state.settleOwnedTranscriptProjection(BASE_RUN_PARAMS.sessionTarget);
      expect(waitForProjection).not.toHaveBeenCalled();

      await state.prepareCompactedTranscriptRetry(assertActive);
      await state.settleOwnedTranscriptProjection(BASE_RUN_PARAMS.sessionTarget, abortSignal);
      expect(waitForProjection).toHaveBeenCalledWith(BASE_RUN_PARAMS.sessionTarget, abortSignal);

      await state.settleOwnedTranscriptProjection(BASE_RUN_PARAMS.sessionTarget);
      expect(waitForProjection).toHaveBeenCalledOnce();
    } finally {
      waitForProjection.mockRestore();
    }
  });

  it("records canonical runtime persistence without mutating recorder lifecycle state", async () => {
    const persistedMessage = makeUserMessage();
    const persistApproved = vi.fn(async () => ({
      admission: TEST_ADMISSION,
      sessionFile: BASE_RUN_PARAMS.sessionFile,
      sessionEntry: undefined,
      messageId: "msg-user-1",
      message: persistedMessage,
    }));
    const recorder = createRecorder({ persistApproved });
    const onUserMessagePersisted = vi.fn();
    const state = createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(persistedMessage);
    await state.waitForCurrentUserMessagePersistence();

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(recorder.markRuntimePersistencePending).toHaveBeenCalledOnce();
    expect(recorder.markRuntimePersisted).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
    expect(state.activePrompt.persisted).toBe(true);
  });

  it("continues from the transcript after compaction when the runtime persisted the user turn", async () => {
    const runtimeMessage = makeUserMessage();
    const persistApproved = vi.fn(async () => undefined);
    const recorder = createRecorder({
      hasPersisted: vi.fn(() => true),
      persistApproved,
    });
    const onUserMessagePersisted = vi.fn();
    const state = createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(runtimeMessage);
    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(runtimeMessage);
    expect(state.activePrompt).toEqual({
      override: CONTINUE_FROM_TRANSCRIPT_PROMPT,
      persisted: true,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("persists before_agent_run block markers through the blocked path", async () => {
    const blockedMessage = {
      ...makeUserMessage("[blocked by before_agent_run]"),
      __openclaw: {
        beforeAgentRunBlocked: {
          blockedBy: "before_agent_run",
          blockedAt: 123,
        },
      },
    };
    const persistApproved = vi.fn(async () => undefined);
    const persistBlocked = vi.fn(async () => ({
      admission: TEST_ADMISSION,
      sessionFile: BASE_RUN_PARAMS.sessionFile,
      sessionEntry: undefined,
      messageId: "msg-user-blocked",
      message: blockedMessage,
    }));
    const recorder = createRecorder({ persistApproved, persistBlocked });
    const onUserMessagePersisted = vi.fn();
    const state = createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(blockedMessage);
    await state.waitForCurrentUserMessagePersistence();

    expect(persistApproved).not.toHaveBeenCalled();
    expect(persistBlocked).toHaveBeenCalledWith(blockedMessage);
    expect(recorder.markRuntimePersistencePending).toHaveBeenCalledOnce();
    expect(recorder.markBlocked).not.toHaveBeenCalled();
    expect(recorder.markRuntimePersisted).not.toHaveBeenCalled();
    expect(onUserMessagePersisted).toHaveBeenCalledWith(blockedMessage);
    expect(state.activePrompt.persisted).toBe(true);
  });

  it("keeps the original prompt when canonical persistence appends nothing", async () => {
    const persistApproved = vi.fn(async () => undefined);
    const recorder = createRecorder({ persistApproved });
    const onUserMessagePersisted = vi.fn();
    const state = createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(makeUserMessage());
    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).not.toHaveBeenCalled();
    expect(state.activePrompt).toEqual({ persisted: false, internal: false });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });

  it.each(["active", "closed"] as const)(
    "revalidates the %s owner after pending canonical persistence before retry",
    async (owner) => {
      const persistedMessage = makeUserMessage();
      const callerError = new Error("caller stopped while user persistence was pending");
      let closed = false;
      const assertPersistenceOwnerActive = () => {
        if (closed) {
          throw callerError;
        }
      };
      const persistence =
        createDeferred<Awaited<ReturnType<UserTurnTranscriptRecorder["persistApproved"]>>>();
      const persistApproved = vi.fn(() => persistence.promise);
      const recorder = createRecorder({ persistApproved });
      const onUserMessagePersisted = vi.fn();
      const state = createState({
        userTurnTranscriptRecorder: recorder,
        onUserMessagePersisted,
      });

      state.onUserMessagePersisted(persistedMessage);
      let retryPrepared = false;
      const retryPromise = state
        .prepareCompactedTranscriptRetry(assertPersistenceOwnerActive)
        .then(() => {
          retryPrepared = true;
        });
      await Promise.resolve();

      expect(recorder.waitForRuntimePersistence).toHaveBeenCalledOnce();
      expect(retryPrepared).toBe(false);
      expect(state.suppressNextUserMessagePersistence).toBe(false);

      closed = owner === "closed";
      persistence.resolve({
        admission: TEST_ADMISSION,
        sessionFile: BASE_RUN_PARAMS.sessionFile,
        sessionEntry: undefined,
        messageId: "msg-user-delayed",
        message: persistedMessage,
      });
      if (closed) {
        await expect(retryPromise).rejects.toBe(callerError);
        expect(retryPrepared).toBe(false);
        expect(state.activePrompt.override).toBeUndefined();
        expect(state.suppressNextUserMessagePersistence).toBe(false);
      } else {
        await retryPromise;
        expect(state.activePrompt.override).toBe(CONTINUE_FROM_TRANSCRIPT_PROMPT);
        expect(state.suppressNextUserMessagePersistence).toBe(true);
      }
      expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
    },
  );

  it("does not suppress an original prompt that precheck compaction never persisted", async () => {
    const state = createState();

    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(state.activePrompt).toEqual({ persisted: false, internal: false });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });

  it("keeps an internal reasoning continuation hidden across precheck compaction", async () => {
    const reasoningContinuation =
      "The previous assistant turn recorded reasoning; continue to the visible answer.";
    const state = createState();
    state.activateInternalPrompt(reasoningContinuation);

    await state.prepareCompactedTranscriptRetry(assertActive);

    expect(state.activePrompt).toEqual({
      override: reasoningContinuation,
      persisted: true,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });
});
