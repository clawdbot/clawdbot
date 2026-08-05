import { describe, expect, it, vi } from "vitest";
import { buildTimestampPrefix } from "../../../gateway/server-methods/agent-timestamp.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import type { AgentSession } from "../../sessions/index.js";
import { prepareEmbeddedAttemptSessionBoundary } from "./attempt-session-boundary.js";

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
    ...overrides,
  } as unknown as ReturnType<typeof guardSessionManager>;
}

describe("prepareEmbeddedAttemptSessionBoundary", () => {
  it("resets restored state and preserves exact prompt bytes for raw model probes", async () => {
    const { activeSession, reset } = createActiveSession();
    const setActiveSessionSystemPrompt = vi.fn();

    const boundary = prepareEmbeddedAttemptSessionBoundary({
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
    const boundary = prepareEmbeddedAttemptSessionBoundary({
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
    const boundary = prepareEmbeddedAttemptSessionBoundary({
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
    prepareEmbeddedAttemptSessionBoundary({
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
    prepareEmbeddedAttemptSessionBoundary({
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
    prepareEmbeddedAttemptSessionBoundary({
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
    (suppressNextUserMessagePersistence) => {
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

      const boundary = prepareEmbeddedAttemptSessionBoundary({
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

  it("preserves the admitted current user when its active-session copy is absent", () => {
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
      hasPersisted: () => true,
    } as NonNullable<
      Parameters<
        typeof prepareEmbeddedAttemptSessionBoundary
      >[0]["attempt"]["userTurnTranscriptRecorder"]
    >;

    const boundary = prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        onUserMessagePersistenceInvalidated,
        prompt: "current prompt",
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
  });

  it("preserves a recorder-owned durable user when the prepared message is unavailable", () => {
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
      buildSessionContext: () => ({ messages: [] }),
      getLeafEntry: () => ({
        id: "current-user",
        parentId: "previous-assistant",
        timestamp: "2026-07-13T00:00:00.000Z",
        type: "message",
        message: currentUser,
      }),
    });
    const recorder = {
      getPersistedMessage: () => currentUser,
      hasPersisted: () => true,
    } as unknown as NonNullable<
      Parameters<
        typeof prepareEmbeddedAttemptSessionBoundary
      >[0]["attempt"]["userTurnTranscriptRecorder"]
    >;

    const boundary = prepareEmbeddedAttemptSessionBoundary({
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

    expect(boundary.orphanRepair).toBeUndefined();
    expect(activeSession.agent.state.messages).toEqual([]);
    expect(branch).not.toHaveBeenCalled();
    expect(resetLeaf).not.toHaveBeenCalled();
    expect(clearNextUserMessagePersistenceSuppression).not.toHaveBeenCalled();
    expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
  });

  it("adopts an exact durable user leaf after recorder state is lost on restart", () => {
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
      getLeafEntry: () => ({
        id: "unconfirmed-user",
        parentId: "previous-assistant",
        timestamp: "2026-07-13T00:00:00.000Z",
        type: "message",
        message: currentUser,
      }),
      branch,
      resetLeaf,
      clearNextUserMessagePersistenceSuppression,
    });
    const recorder = {
      hasPersisted: () => false,
    } as NonNullable<
      Parameters<
        typeof prepareEmbeddedAttemptSessionBoundary
      >[0]["attempt"]["userTurnTranscriptRecorder"]
    >;

    const boundary = prepareEmbeddedAttemptSessionBoundary({
      activeSession,
      attempt: {
        onUserMessagePersistenceInvalidated,
        prompt: "current prompt",
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
    expect(branch).not.toHaveBeenCalled();
    expect(resetLeaf).not.toHaveBeenCalled();
    expect(clearNextUserMessagePersistenceSuppression).not.toHaveBeenCalled();
    expect(onUserMessagePersistenceInvalidated).not.toHaveBeenCalled();
    expect(activeSession.agent.state.messages).toEqual([]);
  });

  it("repairs a durable user leaf that does not match the admitted current user", () => {
    const currentUser = {
      role: "user" as const,
      content: "current prompt",
      idempotencyKey: "current-run:user",
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

    const boundary = prepareEmbeddedAttemptSessionBoundary({
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

    expect(boundary.orphanRepair?.removeLeaf).toBe(true);
    expect(branch).toHaveBeenCalledWith("previous-assistant");
    expect(clearNextUserMessagePersistenceSuppression).toHaveBeenCalledOnce();
    expect(onUserMessagePersistenceInvalidated).toHaveBeenCalledOnce();
    expect(activeSession.agent.state.messages).toBe(repairedMessages);
  });

  it("repairs an orphaned user leaf before rebuilding active session messages", () => {
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

    const boundary = prepareEmbeddedAttemptSessionBoundary({
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
