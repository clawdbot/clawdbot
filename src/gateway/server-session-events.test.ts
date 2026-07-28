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
  handler({
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    message,
    messageId: "message-1",
    messageSeq: 1,
  });
  await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledTimes(1));
  return broadcastToConnIds.mock.calls[0]?.[1];
}

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isEmbeddedAgentRunInProgressMock.mockReturnValue(false);
    loadAccessorSessionEntryReadOnlyMock.mockReturnValue(undefined);
    readSessionMessageCountAsyncMock.mockResolvedValue(undefined);
    sessionRow.thinkingLevel = "ultra";
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
      handler({
        sessionFile: "/tmp/sess-main.jsonl",
        sessionKey: "agent:main:main",
        message: { role: "toolResult", content: [] },
        messageId: "message-1",
        messageSeq: 1,
      });
      await vi.waitFor(() => expect(received).toHaveBeenCalledOnce());
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

    handler({
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
    await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledTimes(1));

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
