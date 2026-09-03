import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import {
  createGatewayBroadcaster,
  createHandler,
  createTranscriptUpdateBroadcastHandler,
  emitAssistantTranscriptUpdate,
  expectPrivateSessionInvalidation,
  fixedStoreRuntimeConfig,
  listAccessorSessionEntriesReadOnlyMock,
  loadAccessorSessionEntryReadOnlyMock,
  loadGatewaySessionEntryReadOnlyMock,
  loadGatewaySessionRowMock,
  ownerGoal,
  projectChatDisplayMessageMock,
  readSessionMessageByIdAsyncMock,
  readSessionMessageCountAsyncMock,
  resolveEmbeddedAgentRunProgressStateMock,
  resolveTranscriptSessionKeyBySessionIdMock,
  runtimeConfigState,
  sessionRow,
  storedMessage,
  subscribePluginSessionsChanged,
} from "./server-session-events.test-support.js";

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEmbeddedAgentRunProgressStateMock.mockReturnValue(undefined);
    listAccessorSessionEntriesReadOnlyMock.mockReturnValue([]);
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(undefined);
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({ entry: undefined, storePath: "" });
    loadGatewaySessionRowMock.mockReturnValue(sessionRow);
    readSessionMessageCountAsyncMock.mockReset().mockResolvedValue(undefined);
    readSessionMessageByIdAsyncMock
      .mockReset()
      .mockImplementation(async (_scope, id: string) => storedMessage(id));
    resolveTranscriptSessionKeyBySessionIdMock.mockReturnValue(undefined);
    runtimeConfigState.value = {};
    sessionRow.key = "agent:main:main";
    sessionRow.thinkingLevel = "ultra";
  });

  it("reads canonical content and placement from one selected snapshot", async () => {
    const transcriptPosition = { source: "replacement-generation", rawSeq: 10 };
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce({
      found: true,
      oversized: false,
      seq: 7,
      message: {
        role: "assistant",
        content: "replacement",
        __openclaw: { id: "same-id", transcriptPosition },
      },
    });
    const { broadcastToConnIds, handler } = createHandler(false);
    await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/canonical-update.sqlite",
      },
      messageId: "same-id",
      messageSeq: 1,
      message: { role: "assistant", content: "stale queued content" },
    });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        messageId: "same-id",
        messageSeq: 7,
        message: expect.objectContaining({
          content: "replacement",
          __openclaw: expect.objectContaining({ transcriptPosition }),
        }),
      }),
      expect.any(Set),
    );
  });

  it.each(["missing", "rebuilding"])(
    "invalidates history when the committed row is %s",
    async (kind) => {
      if (kind === "missing") {
        readSessionMessageByIdAsyncMock.mockResolvedValueOnce({ found: false, oversized: false });
      } else {
        readSessionMessageByIdAsyncMock.mockRejectedValueOnce(
          new SessionTranscriptProjectionUnavailableError("sess-main"),
        );
      }
      const { broadcastToConnIds, handler } = createHandler(false);
      await handler({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/canonical-update.sqlite",
        },
        messageId: "removed-id",
        message: { role: "assistant", content: "stale queued content" },
      });
      expect(broadcastToConnIds).toHaveBeenCalledOnce();
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "sessions.changed",
        expect.objectContaining({ sessionKey: "agent:main:main" }),
        expect.any(Set),
      );
      expect(broadcastToConnIds.mock.calls[0]?.[1]).not.toHaveProperty("message");
      expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
    },
  );

  it("never silently drops an authoritative session message for a slow subscriber", async () => {
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      message: { role: "user", content: [{ type: "text", text: "shared durable prompt" }] },
      messageId: "durable-user-1",
      messageSeq: 1,
    });

    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "durable-user-1",
        messageSeq: 1,
      }),
      expect.any(Set),
    );
  });

  it("invalidates broad and targeted subscribers once for an identity-only commit", async () => {
    const broadConnIds = new Set(["conn-broad", "conn-shared"]);
    const targetConnIds = new Set(["conn-targeted", "conn-shared"]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:main" ? targetConnIds : new Set<string>(),
    );
    const broadcastToConnIds = vi.fn();
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      lifecycleRevision: "committed-revision",
      updatedAt: 1,
    });
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => broadConnIds },
      sessionMessageSubscribers: { get: getSessionMessageSubscribers },
      chatAbortControllers: new Map(),
    });

    await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/identity-only-custom-sessions.json",
      },
      lifecycleRevision: "committed-revision",
    });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:main:main");
    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/identity-only-custom-sessions.json",
    });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        agentId: "main",
        sessionId: "sess-main",
        phase: "message",
      }),
      new Set(["conn-broad", "conn-shared", "conn-targeted"]),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("message");
    expect(payload).not.toHaveProperty("messageId");
    expect(payload).not.toHaveProperty("messageSeq");
    expect(payload).not.toHaveProperty("lifecycleRevision");
    expect(payload).not.toHaveProperty("storePath");
    expect(payload).not.toHaveProperty("target.storePath");
    expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
  });

  it("scopes a queued marker update to its final transcript key", async () => {
    resolveTranscriptSessionKeyBySessionIdMock
      .mockReturnValueOnce("agent:main:queued")
      .mockReturnValue("agent:main:current");
    listAccessorSessionEntriesReadOnlyMock.mockReturnValue([
      { key: "agent:main:current", entry: { sessionId: "sess-main" } },
    ]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:main:current" ? new Set(["conn-current"]) : new Set(["conn-stale"]),
    );
    const { broadcastToConnIds, handler } = createHandler(
      false,
      true,
      getSessionMessageSubscribers,
    );

    await handler({
      sessionFile: "sqlite:main:sess-main:/tmp/explicit-sessions.json",
    });

    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:main:current");
    expect(getSessionMessageSubscribers).not.toHaveBeenCalledWith("agent:main:queued");
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "agent:main:current" }),
      new Set(["conn-1", "conn-current"]),
    );
  });

  it("rejects an identity-only invalidation when its custom-store owner was deleted", async () => {
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/deleted-identity-only-sessions.json",
      },
      lifecycleRevision: "deleted-revision",
    });

    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).not.toHaveBeenCalled();
    expect(readSessionMessageCountAsyncMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      updateSource: "committed",
      ownerChange: "revised",
      lifecycleRevision: "revision-before-reset",
    },
    {
      updateSource: "legacy",
      ownerChange: "revised",
      lifecycleRevision: undefined,
    },
    {
      updateSource: "committed",
      ownerChange: "deleted",
      lifecycleRevision: "revision-before-reset",
    },
    {
      updateSource: "legacy",
      ownerChange: "deleted",
      lifecycleRevision: undefined,
    },
    {
      updateSource: "committed",
      ownerChange: "rebound",
      lifecycleRevision: "revision-before-reset",
    },
    {
      updateSource: "legacy",
      ownerChange: "rebound",
      lifecycleRevision: undefined,
    },
  ])(
    "discards a queued $updateSource message when its session owner is $ownerChange",
    async ({ lifecycleRevision, ownerChange }) => {
      let currentEntry:
        | { sessionId: string; lifecycleRevision: string; updatedAt: number }
        | undefined = {
        sessionId: "sess-main",
        lifecycleRevision: "revision-before-reset",
        updatedAt: 1,
      };
      loadAccessorSessionEntryReadOnlyMock.mockImplementation(() => currentEntry);
      loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
        entry: {
          sessionId: "sess-main",
          lifecycleRevision: "revision-before-reset",
          updatedAt: 1,
        },
        storePath: "/tmp/default-lifecycle-sessions.json",
      });
      let resolveMessageRead: ((value: ReturnType<typeof storedMessage>) => void) | undefined;
      readSessionMessageByIdAsyncMock.mockImplementation(
        () =>
          new Promise<ReturnType<typeof storedMessage>>((resolve) => {
            resolveMessageRead = resolve;
          }),
      );
      const { broadcastToConnIds, handler } = createHandler(false);

      const pendingBroadcast = handler({
        target: {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "agent:main:main",
          storePath: "/tmp/reset-lifecycle-sessions.json",
        },
        ...(lifecycleRevision ? { lifecycleRevision } : {}),
        message: { role: "user", content: [{ type: "text", text: "deleted by reset" }] },
        messageId: "message-before-reset",
      });

      await vi.waitFor(() => expect(readSessionMessageByIdAsyncMock).toHaveBeenCalledOnce());
      if (ownerChange === "deleted") {
        currentEntry = undefined;
      } else if (ownerChange === "rebound") {
        currentEntry.sessionId = "sess-replacement";
      } else {
        currentEntry.lifecycleRevision = "revision-after-reset";
      }
      resolveMessageRead?.(storedMessage("message-before-reset"));

      await pendingBroadcast;
      expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    },
  );

  it("validates a committed custom-store owner without exposing private identity", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      lifecycleRevision: "current-revision",
      updatedAt: 1,
    });
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({
      entry: {
        sessionId: "sess-main",
        lifecycleRevision: "unrelated-default-revision",
        updatedAt: 1,
      },
      storePath: "/tmp/default-lifecycle-sessions.json",
    });
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/current-lifecycle-sessions.json",
      },
      lifecycleRevision: "current-revision",
      message: { role: "user", content: [{ type: "text", text: "current prompt" }] },
      messageId: "message-current-lifecycle",
      messageSeq: 1,
    });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/current-lifecycle-sessions.json",
    });
    expect(loadGatewaySessionEntryReadOnlyMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "message-current-lifecycle",
        messageSeq: 1,
      }),
      expect.any(Set),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    expect(payload).not.toHaveProperty("lifecycleRevision");
    expect(payload).not.toHaveProperty("storePath");
    expect(payload).not.toHaveProperty("target.storePath");
  });

  it("keeps committed messages visible when the current owner has no legacy revision", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      updatedAt: 1,
    });
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/revisionless-owner-sessions.json",
      },
      lifecycleRevision: "committed-revision",
      message: { role: "user", content: [{ type: "text", text: "revisionless owner" }] },
      messageId: "revisionless-owner-message",
      messageSeq: 1,
    });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "revisionless-owner-message",
        messageSeq: 1,
      }),
      expect.any(Set),
    );
  });

  it("preserves revisionless transcript updates when ownership is unavailable", async () => {
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce(
      storedMessage("legacy-lifecycle-message", 3),
    );
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/legacy-lifecycle-sessions.json",
      },
      message: { role: "user", content: [{ type: "text", text: "legacy prompt" }] },
      messageId: "legacy-lifecycle-message",
    });

    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        messageId: "legacy-lifecycle-message",
        messageSeq: 3,
      }),
      expect.any(Set),
    );
  });

  it("carries terminal assistant run ownership while plugin finalization keeps the run active", async () => {
    // before_agent_finalize hooks run after the assistant transcript write but
    // before terminal delivery. The active-run registry remains authoritative
    // during that interval even when the persisted session row says done.
    const { broadcastToConnIds, handler } = createHandler(true);

    await handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: "agent:main:main",
      runId: "run-before-finalize",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      messageId: "message-1",
      messageSeq: 1,
    });

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({
        sessionKey: "agent:main:main",
        runId: "run-before-finalize",
        messageId: "message-1",
        messageSeq: 1,
        status: "running",
        hasActiveRun: true,
        session: expect.objectContaining({
          key: "agent:main:main",
          status: "running",
          hasActiveRun: true,
        }),
      }),
      expect.any(Set),
    );
  });

  it("projects running status into ordinary startup transcript snapshots", async () => {
    await expect(emitAssistantTranscriptUpdate(true, undefined, false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      status: "running",
      hasActiveRun: true,
      session: { key: "agent:main:main", status: "running", hasActiveRun: true },
    });
  });

  it("keeps stable thinking state without catalog-derived picker metadata", async () => {
    const payload = await emitAssistantTranscriptUpdate(false);

    expect(payload).toMatchObject({
      session: {
        thinkingLevel: "ultra",
        agentRuntime: { id: "openclaw" },
      },
    });
    expect(payload).not.toHaveProperty("thinkingLevels");
    expect(payload).not.toHaveProperty("thinkingOptions");
    expect(payload).not.toHaveProperty("thinkingDefault");
    expect(payload).not.toHaveProperty("session.thinkingLevels");
    expect(payload).not.toHaveProperty("session.thinkingOptions");
    expect(payload).not.toHaveProperty("session.thinkingDefault");
  });

  it("emits explicit tombstones in transcript snapshots", async () => {
    sessionRow.thinkingLevel = undefined;

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      agentStatus: null,
      observerDigest: null,
      session: { thinkingLevel: null, agentStatus: null, observerDigest: null },
    });
  });

  it("keeps stale-run recovery when terminal lifecycle has cleared active projection", async () => {
    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: false,
      session: { hasActiveRun: false },
    });
  });

  it("keeps transcript snapshots active for embedded or channel reply runs", async () => {
    resolveEmbeddedAgentRunProgressStateMock.mockImplementation((sessionId) =>
      sessionId === "sess-main" ? "running" : undefined,
    );

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: true,
      activeRunIds: null,
      session: {
        key: "agent:main:main",
        sessionId: "sess-main",
        hasActiveRun: true,
        activeRunIds: null,
      },
    });
    expect(resolveEmbeddedAgentRunProgressStateMock).toHaveBeenCalledWith("sess-main");
  });

  it.each([
    { name: "routes the configured persisted owner without publishing its goal" },
    { name: "publishes the explicit owner's identity and goal", agentId: "ops" },
  ])("$name", async ({ agentId }) => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["ops", "research"]);
    sessionRow.key = "global";
    const goal = { ...ownerGoal };
    loadGatewaySessionRowMock.mockReturnValue({ ...sessionRow, goal });
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "global"
        ? new Set(["conn-global"])
        : sessionKey === "agent:ops:global"
          ? new Set(["conn-scoped"])
          : new Set<string>(),
    );
    const broadcastToConnIds = vi.fn();
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set<string>() },
      sessionMessageSubscribers: { get: getSessionMessageSubscribers },
      chatAbortControllers: new Map(),
    });

    await handler({
      sessionKey: "global",
      ...(agentId ? { agentId } : {}),
      message: { role: "assistant", content: [{ type: "text", text: "Owner reply" }] },
      messageId: "message-global-owner",
      messageSeq: 1,
    });

    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:ops:global");
    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("global");
    expect(loadGatewaySessionRowMock).toHaveBeenCalledWith("global", {
      agentId: "ops",
      transcriptUsageMaxBytes: 64 * 1024,
    });
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "session.message",
      expect.objectContaining({ sessionKey: "global" }),
      new Set(["conn-scoped", "conn-global"]),
    );
    const payload = broadcastToConnIds.mock.calls[0]?.[1];
    if (agentId) {
      expect(payload).toMatchObject({ agentId: "ops", goal, session: { goal } });
    } else {
      expect(payload).not.toHaveProperty("agentId");
      expect(payload).not.toHaveProperty("goal");
      expect(payload).not.toHaveProperty("session.goal");
    }
  });

  it("keeps a retired fixed-store owner private instead of routing through another agent", async () => {
    runtimeConfigState.value = fixedStoreRuntimeConfig("ops", ["research"]);
    const getSessionMessageSubscribers = vi.fn((sessionKey: string) =>
      sessionKey === "agent:ops:global"
        ? new Set(["conn-ops"])
        : sessionKey === "agent:research:global"
          ? new Set(["conn-research"])
          : new Set<string>(),
    );
    const { broadcastToConnIds, handler } = createHandler(
      false,
      true,
      getSessionMessageSubscribers,
    );

    await handler({
      sessionKey: "global",
      message: { role: "assistant", content: [{ type: "text", text: "private owner" }] },
      messageId: "message-retired-owner",
      messageSeq: 1,
    });

    expect(getSessionMessageSubscribers).toHaveBeenCalledWith("agent:ops:global");
    expect(getSessionMessageSubscribers).not.toHaveBeenCalledWith("agent:research:global");
    expect(loadGatewaySessionRowMock).not.toHaveBeenCalled();
    expect(broadcastToConnIds).toHaveBeenCalledOnce();
    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({ sessionKey: "global", phase: "message" }),
      new Set(["conn-1", "conn-ops"]),
      {
        agentId: "ops",
        dropIfSlow: true,
        sessionKeys: ["agent:ops:global"],
      },
    );
    expectPrivateSessionInvalidation(broadcastToConnIds.mock.calls[0]?.[1]);
  });

  it("broadcasts user idempotency keys in session.message metadata", async () => {
    await expect(
      emitAssistantTranscriptUpdate(false, {
        role: "user",
        content: [{ type: "text", text: "Optimistic turn" }],
        idempotencyKey: "client-turn-3",
      }),
    ).resolves.toMatchObject({
      message: {
        __openclaw: {
          id: "message-1",
          idempotencyKey: "client-turn-3",
          seq: 1,
        },
      },
    });
  });

  it("broadcasts the authenticated sender ownership decision", async () => {
    await expect(
      emitAssistantTranscriptUpdate(false, {
        role: "user",
        content: [{ type: "text", text: "Owner turn" }],
        __openclaw: { senderIsOwner: true },
      }),
    ).resolves.toMatchObject({
      senderIsOwner: true,
    });
  });
  it("publishes message-phase changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients: new Set() });
    const handler = createTranscriptUpdateBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set() },
      sessionMessageSubscribers: { get: () => new Set() },
      chatAbortControllers: new Map(),
    });
    projectChatDisplayMessageMock.mockReturnValueOnce(undefined).mockReturnValueOnce(undefined);

    try {
      await handler({
        sessionFile: "/tmp/sess-main.jsonl",
        sessionKey: "agent:main:main",
        message: { role: "toolResult", content: [] },
        messageId: "message-1",
        messageSeq: 1,
      });
      expect(received).toHaveBeenCalledOnce();
      expect(received).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        phase: "message",
      });
    } finally {
      unsubscribe();
    }
  });

  it("reads the canonical message through the target's explicit store", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      updatedAt: 1,
    });
    readSessionMessageByIdAsyncMock.mockResolvedValueOnce(
      storedMessage("message-partial-target", 7),
    );
    const { broadcastToConnIds, handler } = createHandler(false);

    await handler({
      agentId: "main",
      message: { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
      messageId: "message-partial-target",
      sessionKey: "agent:main:main",
      target: {
        agentId: "main",
        sessionId: "partial-target-session",
        sessionKey: "agent:main:main",
        storePath: "/tmp/explicit-sessions.json",
      },
    });
    expect(broadcastToConnIds).toHaveBeenCalledTimes(1);

    expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:main",
      storePath: "/tmp/explicit-sessions.json",
    });
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ messageSeq: 7 });
  });

  it.each([
    {
      name: "distinct session keys",
      slowAgentId: "main",
      slowSessionKey: "agent:main:slow",
      fastAgentId: "main",
      fastSessionKey: "agent:main:main",
    },
    {
      name: "global sessions owned by different agents",
      slowAgentId: "main",
      slowSessionKey: "global",
      fastAgentId: "research",
      fastSessionKey: "global",
    },
  ])("does not stall $name behind another transcript's pending seq read", async (scenario) => {
    let releaseSlowCount: (value: number) => void = () => undefined;
    const readSequence = vi.fn((params: { agentId?: string; sessionKey?: string }) =>
      params.agentId === scenario.slowAgentId && params.sessionKey === scenario.slowSessionKey
        ? new Promise<number>((resolve) => {
            releaseSlowCount = resolve;
          })
        : Promise.resolve(3),
    );
    readSessionMessageCountAsyncMock.mockImplementation(readSequence);
    readSessionMessageByIdAsyncMock.mockImplementation(async (scope, id: string) =>
      storedMessage(id, await readSequence(scope)),
    );
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ sessionId: "sess-main" });
    const { broadcastToConnIds, handler } = createHandler(false);

    // No messageSeq: the slow lane blocks on its async transcript count.
    const slowTask = handler({
      message: { role: "assistant", content: [{ type: "text", text: "slow" }] },
      messageId: "slow-1",
      target: {
        agentId: scenario.slowAgentId,
        sessionId: "sess-slow",
        sessionKey: scenario.slowSessionKey,
        storePath: "/tmp/slow-sessions.json",
      },
    });
    await vi.waitFor(() => expect(readSequence).toHaveBeenCalledOnce());

    const fastTask = handler({
      sessionFile: "/tmp/sess-main.jsonl",
      agentId: scenario.fastAgentId,
      sessionKey: scenario.fastSessionKey,
      message: { role: "assistant", content: [{ type: "text", text: "fast" }] },
      messageId: "fast-1",
      messageSeq: 1,
    });

    try {
      // The independent lane must publish while the other transcript remains parked.
      await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledOnce(), {
        timeout: 100,
        interval: 5,
      });
      expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({ messageId: "fast-1" });
    } finally {
      releaseSlowCount(5);
      await Promise.allSettled([slowTask, fastTask]);
    }

    expect(broadcastToConnIds).toHaveBeenCalledTimes(2);
    expect(broadcastToConnIds.mock.calls[1]?.[1]).toMatchObject({ messageId: "slow-1" });
  });

  it.each([
    {
      name: "an agent-qualified session",
      firstSessionKey: "agent:main:main",
      secondSessionKey: "agent:main:main",
      agentId: "main",
    },
    {
      name: "an ownerless legacy global update",
      firstSessionKey: "global",
      secondSessionKey: "global",
      agentId: "main",
    },
    {
      name: "a global session and its agent-qualified alias",
      firstSessionKey: "global",
      secondSessionKey: "agent:main:global",
      agentId: "main",
    },
    {
      name: "a marker-only update and its canonical transcript key",
      firstSessionKey: "agent:main:main",
      secondSessionKey: "agent:main:main",
      agentId: "main",
      markerOnly: true,
    },
    {
      name: "an ownerless global update in its configured fixed store",
      firstSessionKey: "global",
      secondSessionKey: "global",
      agentId: "ops",
      config: {
        session: { store: "/tmp/owned-shared.sqlite" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
    },
  ])("preserves message order for $name", async (scenario) => {
    runtimeConfigState.value = scenario.config ?? {};
    let releaseFirstCount: (value: number) => void = () => undefined;
    const firstRead = new Promise<number>((resolve) => {
      releaseFirstCount = resolve;
    });
    readSessionMessageCountAsyncMock.mockImplementationOnce(() => firstRead);
    readSessionMessageByIdAsyncMock.mockImplementationOnce(async (_scope, id: string) =>
      storedMessage(id, await firstRead),
    );
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({ sessionId: "sess-main" });
    if (scenario.markerOnly) {
      listAccessorSessionEntriesReadOnlyMock.mockReturnValue([
        { key: scenario.firstSessionKey, entry: { sessionId: "sess-main" } },
      ]);
      resolveTranscriptSessionKeyBySessionIdMock.mockReturnValue(scenario.firstSessionKey);
    }
    const { broadcastToConnIds, handler } = createHandler(false);

    const firstTask = handler({
      message: { role: "assistant", content: [{ type: "text", text: "first" }] },
      messageId: "ordered-1",
      ...(scenario.markerOnly
        ? { sessionFile: `sqlite:${scenario.agentId}:sess-main:/tmp/explicit-sessions.json` }
        : {
            target: {
              agentId: scenario.agentId,
              sessionId: "sess-main",
              sessionKey: scenario.firstSessionKey,
              storePath: "/tmp/explicit-sessions.json",
            },
          }),
    });
    await vi.waitFor(() =>
      expect(
        readSessionMessageCountAsyncMock.mock.calls.length +
          readSessionMessageByIdAsyncMock.mock.calls.length,
      ).toBe(1),
    );
    const secondTask = handler({
      sessionFile: "/tmp/sess-main.jsonl",
      sessionKey: scenario.secondSessionKey,
      message: { role: "assistant", content: [{ type: "text", text: "second" }] },
      messageId: "ordered-2",
      messageSeq: 2,
    });

    await Promise.resolve();
    await Promise.resolve();
    try {
      expect(broadcastToConnIds).not.toHaveBeenCalled();
    } finally {
      releaseFirstCount(1);
      await Promise.allSettled([firstTask, secondTask]);
    }
    expect(broadcastToConnIds.mock.calls.map((call) => call[1]?.messageId)).toEqual([
      "ordered-1",
      "ordered-2",
    ]);
  });
});
