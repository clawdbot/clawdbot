import { describe, expect, it, vi } from "vitest";
import type { UserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.types.js";
import type { PreparedEmbeddedRunInput } from "./run/execution-context.js";
import { createEmbeddedRunSessionPromptState } from "./run/session-prompt-state.js";

const CONTINUE_FROM_TRANSCRIPT_PROMPT =
  "Continue from the current transcript after the latest tool result. Do not repeat the original user request, and do not rerun completed tools unless the transcript shows they are still needed.";

const BASE_RUN_PARAMS = {
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

function createState(overrides: Partial<PreparedEmbeddedRunInput["runParams"]> = {}) {
  return createEmbeddedRunSessionPromptState({
    runParams: { ...BASE_RUN_PARAMS, ...overrides },
    sessionAgentId: "main",
    resolvedSessionKey: BASE_RUN_PARAMS.sessionKey,
    lifecycleGeneration: "test-generation",
  });
}

describe("embedded run session prompt state", () => {
  it("records canonical runtime persistence without mutating recorder lifecycle state", async () => {
    const persistedMessage = makeUserMessage();
    const persistApproved = vi.fn(async () => ({
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
    await state.prepareCompactedTranscriptRetry();

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
    await state.prepareCompactedTranscriptRetry();

    expect(persistApproved).toHaveBeenCalledOnce();
    expect(onUserMessagePersisted).not.toHaveBeenCalled();
    expect(state.activePrompt).toEqual({ persisted: false, internal: false });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });

  it("waits for pending canonical persistence before preparing a compacted retry", async () => {
    const persistedMessage = makeUserMessage();
    let resolvePersistence:
      | ((result: {
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }) => void)
      | undefined;
    const persistApproved = vi.fn(
      () =>
        new Promise<{
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }>((resolve) => {
          resolvePersistence = resolve;
        }),
    );
    const recorder = createRecorder({ persistApproved });
    const onUserMessagePersisted = vi.fn();
    const state = createState({
      userTurnTranscriptRecorder: recorder,
      onUserMessagePersisted,
    });

    state.onUserMessagePersisted(persistedMessage);
    let retryPrepared = false;
    const retryPromise = state.prepareCompactedTranscriptRetry().then(() => {
      retryPrepared = true;
    });
    await Promise.resolve();

    expect(recorder.waitForRuntimePersistence).toHaveBeenCalledOnce();
    expect(retryPrepared).toBe(false);
    expect(state.suppressNextUserMessagePersistence).toBe(false);

    resolvePersistence?.({
      sessionFile: BASE_RUN_PARAMS.sessionFile,
      sessionEntry: undefined,
      messageId: "msg-user-delayed",
      message: persistedMessage,
    });
    await retryPromise;

    expect(onUserMessagePersisted).toHaveBeenCalledWith(persistedMessage);
    expect(state.activePrompt.override).toBe(CONTINUE_FROM_TRANSCRIPT_PROMPT);
    expect(state.suppressNextUserMessagePersistence).toBe(true);
  });

  it("does not suppress an original prompt that precheck compaction never persisted", async () => {
    const state = createState();

    await state.prepareCompactedTranscriptRetry();

    expect(state.activePrompt).toEqual({ persisted: false, internal: false });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });

  it("preserves an unpersisted reasoning continuation across precheck compaction", async () => {
    const reasoningContinuation =
      "The previous assistant turn recorded reasoning; continue to the visible answer.";
    const state = createState();
    state.activateInternalPrompt(reasoningContinuation, false);

    await state.prepareCompactedTranscriptRetry();

    expect(state.activePrompt).toEqual({
      override: reasoningContinuation,
      persisted: false,
      internal: true,
    });
    expect(state.suppressNextUserMessagePersistence).toBe(false);
  });
});
