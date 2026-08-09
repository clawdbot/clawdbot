import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const sessionRow = vi.hoisted(() => ({
  key: "agent:main:main",
  kind: "direct",
  sessionId: "sess-main",
  status: "done",
  updatedAt: 1,
  thinkingLevel: "ultra" as string | undefined,
  thinkingLevels: [{ id: "ultra", label: "ultra" }],
  thinkingOptions: ["ultra"],
  thinkingDefault: "medium",
  agentRuntime: { id: "openclaw", source: "model" },
}));
const isEmbeddedAgentRunInProgressMock = vi.hoisted(() => vi.fn());
const projectChatDisplayMessageMock = vi.hoisted(() => vi.fn((message: unknown) => message));
const loadAccessorSessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
const loadGatewaySessionEntryReadOnlyMock = vi.hoisted(() => vi.fn());
const readSessionMessageCountAsyncMock = vi.hoisted(() => vi.fn());

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    loadSessionEntryReadOnly: loadAccessorSessionEntryReadOnlyMock,
  };
});
vi.mock("./chat-display-projection.js", () => ({
  projectChatDisplayMessage: projectChatDisplayMessageMock,
}));
vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: (message: unknown) => message,
  loadGatewaySessionRow: () => sessionRow,
  loadSessionEntry: () => ({ entry: undefined, storePath: "" }),
  loadSessionEntryReadOnly: loadGatewaySessionEntryReadOnlyMock,
}));
vi.mock("./session-transcript-readers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-transcript-readers.js")>();
  return {
    ...actual,
    readSessionMessageCountAsync: readSessionMessageCountAsyncMock,
  };
});
vi.mock("../agents/embedded-agent-runner/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../agents/embedded-agent-runner/runs.js")>(
    "../agents/embedded-agent-runner/runs.js",
  );
  return {
    ...actual,
    isEmbeddedAgentRunInProgress: (...args: unknown[]) => isEmbeddedAgentRunInProgressMock(...args),
  };
});

const { createLifecycleEventBroadcastHandler, createTranscriptUpdateBroadcastHandler } =
  await import("./server-session-events.js");
const { createGatewayBroadcaster } = await import("./server-broadcast.js");
const { subscribePluginSessionsChanged } = await import("../plugins/gateway-events.js");

function createActiveRun(projectSessionActive: boolean): ChatAbortControllerEntry {
  return {
    controller: new AbortController(),
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    startedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    projectSessionActive,
  };
}

function createHandler(projectSessionActive: boolean) {
  const broadcastToConnIds = vi.fn();
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: () => new Set<string>() },
    chatAbortControllers: new Map([["run-before-finalize", createActiveRun(projectSessionActive)]]),
  });
  return { broadcastToConnIds, handler };
}

async function emitAssistantTranscriptUpdate(
  projectSessionActive: boolean,
  message: unknown = { role: "assistant", content: [{ type: "text", text: "Final answer" }] },
) {
  const { broadcastToConnIds, handler } = createHandler(projectSessionActive);
  await handler({
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    message,
    messageId: "message-1",
    messageSeq: 1,
  });
  expect(broadcastToConnIds).toHaveBeenCalledTimes(1);
  return broadcastToConnIds.mock.calls[0]?.[1];
}

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isEmbeddedAgentRunInProgressMock.mockReturnValue(false);
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(undefined);
    loadGatewaySessionEntryReadOnlyMock.mockReturnValue({ entry: undefined, storePath: "" });
    readSessionMessageCountAsyncMock.mockResolvedValue(undefined);
    sessionRow.thinkingLevel = "ultra";
  });

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
      expectedEntryReads: 2,
    },
    {
      updateSource: "legacy",
      ownerChange: "revised",
      lifecycleRevision: undefined,
      expectedEntryReads: 3,
    },
    {
      updateSource: "committed",
      ownerChange: "deleted",
      lifecycleRevision: "revision-before-reset",
      expectedEntryReads: 2,
    },
    {
      updateSource: "legacy",
      ownerChange: "deleted",
      lifecycleRevision: undefined,
      expectedEntryReads: 3,
    },
    {
      updateSource: "committed",
      ownerChange: "rebound",
      lifecycleRevision: "revision-before-reset",
      expectedEntryReads: 2,
    },
    {
      updateSource: "legacy",
      ownerChange: "rebound",
      lifecycleRevision: undefined,
      expectedEntryReads: 3,
    },
  ])(
    "discards a queued $updateSource message when its session owner is $ownerChange",
    async ({ lifecycleRevision, expectedEntryReads, ownerChange }) => {
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
      let resolveMessageCount: ((value: number) => void) | undefined;
      readSessionMessageCountAsyncMock.mockImplementation(
        () =>
          new Promise<number>((resolve) => {
            resolveMessageCount = resolve;
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

      await vi.waitFor(() => expect(readSessionMessageCountAsyncMock).toHaveBeenCalledOnce());
      if (ownerChange === "deleted") {
        currentEntry = undefined;
      } else if (ownerChange === "rebound") {
        currentEntry.sessionId = "sess-replacement";
      } else {
        currentEntry.lifecycleRevision = "revision-after-reset";
      }
      resolveMessageCount?.(1);

      await pendingBroadcast;
      expect(loadAccessorSessionEntryReadOnlyMock).toHaveBeenCalledTimes(expectedEntryReads);
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
    readSessionMessageCountAsyncMock.mockResolvedValue(3);
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

  it("keeps transcript snapshots active while plugin finalization delays the terminal event", async () => {
    // before_agent_finalize hooks run after the assistant transcript write but
    // before terminal delivery. The active-run registry remains authoritative
    // during that interval even when the persisted session row says done.
    await expect(emitAssistantTranscriptUpdate(true)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: true,
      session: { key: "agent:main:main", status: "done", hasActiveRun: true },
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

  it("emits an explicit null when the thinking override is cleared", async () => {
    sessionRow.thinkingLevel = undefined;

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      session: { thinkingLevel: null },
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
    isEmbeddedAgentRunInProgressMock.mockImplementation((sessionId) => sessionId === "sess-main");

    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: true,
      session: { key: "agent:main:main", sessionId: "sess-main", hasActiveRun: true },
    });
    expect(isEmbeddedAgentRunInProgressMock).toHaveBeenCalledWith("sess-main");
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

  it("resolves messageSeq through a partial target's explicit store", async () => {
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue({
      sessionId: "sess-main",
      updatedAt: 1,
    });
    readSessionMessageCountAsyncMock.mockResolvedValue(7);
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
});

describe("createLifecycleEventBroadcastHandler", () => {
  it("projects swarm phase and log payload fields", () => {
    const broadcastToConnIds = vi.fn();
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
      chatAbortControllers: new Map(),
    });

    handler({
      sessionKey: "agent:main:main",
      reason: "swarm-note",
      swarmGroupId: "swarm:agent:main:main:run-1",
      kind: "phase",
      text: "Research",
    } as never);

    expect(broadcastToConnIds).toHaveBeenCalledWith(
      "sessions.changed",
      expect.objectContaining({
        swarmGroupId: "swarm:agent:main:main:run-1",
        kind: "phase",
        text: "Research",
      }),
      new Set(["conn-1"]),
      { dropIfSlow: true },
    );
  });

  it("publishes lifecycle changes to plugins without websocket subscribers", async () => {
    const received = vi.fn();
    const unsubscribe = subscribePluginSessionsChanged(received);
    const { broadcastToConnIds } = createGatewayBroadcaster({ clients: new Set() });
    const handler = createLifecycleEventBroadcastHandler({
      broadcastToConnIds,
      sessionEventSubscribers: { getAll: () => new Set() },
      chatAbortControllers: new Map(),
    });

    try {
      handler({
        sessionKey: "agent:main:main",
        reason: "rename",
        label: "Renamed session",
      });
      await Promise.resolve();
      expect(received).toHaveBeenCalledWith({
        sessionKey: "agent:main:main",
        label: "Renamed session",
        reason: "rename",
      });
    } finally {
      unsubscribe();
    }
  });
});
