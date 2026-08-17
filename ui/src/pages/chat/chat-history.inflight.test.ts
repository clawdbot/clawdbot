// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
  setChatSessionProjection,
} from "./history-merge.ts";
import { handleAgentEvent, type ToolStreamEntry } from "./tool-stream.ts";

type TestState = ChatState & Parameters<typeof handleAgentEvent>[0];
type TestSessions = NonNullable<ChatState["sessions"]> &
  Parameters<typeof handleAgentEvent>[0]["sessions"];

function createState(result: ChatHistoryResult): TestState {
  const host = makeChatHost({
    requestHandlers: { "chat.history": result },
    sessionKey: "main",
  });
  const sessions: TestSessions = {
    setModelOverride: vi.fn(),
    reconcileRunTerminal: vi.fn(),
  };
  return {
    ...host,
    chatToolMessages: host.chatToolMessages ?? [],
    chatStreamSegments: host.chatStreamSegments ?? [],
    connectionEpoch: 1,
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatStreamStartedAt: null,
    sessions,
    toolStreamById: host.toolStreamById ?? new Map<string, ToolStreamEntry>(),
    toolStreamOrder: host.toolStreamOrder ?? [],
    toolStreamSyncTimer: host.toolStreamSyncTimer ?? null,
    requestUpdate: vi.fn(),
  };
}

async function loadHistoryWithBrowserTimers(state: TestState): Promise<void> {
  const globalWithWindow = globalThis as typeof globalThis & {
    window?: Window & typeof globalThis;
  };
  const previousWindow = globalWithWindow.window;
  globalWithWindow.window = globalThis as unknown as Window & typeof globalThis;
  try {
    await loadChatHistory(state);
    await vi.waitFor(() => expect(state.chatToolMessages).toHaveLength(1));
  } finally {
    if (previousWindow) {
      globalWithWindow.window = previousWindow;
    } else {
      Reflect.deleteProperty(globalWithWindow, "window");
    }
  }
}

function activeHistory(runId: string): ChatHistoryResult {
  return {
    messages: [],
    sessionInfo: {
      key: "main",
      kind: "direct",
      updatedAt: 1,
      hasActiveRun: true,
      activeRunIds: [runId],
      status: "running",
    },
    inFlightRun: { runId, text: "" },
  };
}

describe("chat history in-flight assistant recovery", () => {
  it("restores active tool state and authoritative preamble time from the in-flight run snapshot", async () => {
    const history = activeHistory("run-live");
    (history.inFlightRun as { events?: unknown[] }).events = [
      {
        runId: "run-live",
        seq: 1,
        stream: "item",
        ts: 900,
        sessionKey: "main",
        data: {
          kind: "preamble",
          itemId: "preamble-restored",
          progressText: "Checking the workspace",
        },
      },
      {
        runId: "run-live",
        seq: 2,
        stream: "tool",
        ts: 1_000,
        sessionKey: "main",
        data: {
          toolCallId: "call-restored",
          name: "read",
          phase: "start",
          args: { path: "README.md" },
        },
      },
    ];
    const state = createState(history);

    await loadHistoryWithBrowserTimers(state);

    expect(state.chatToolMessages[0]).toMatchObject({
      runId: "run-live",
      toolCallId: "call-restored",
      content: [expect.objectContaining({ type: "toolcall", name: "read" })],
    });
    expect(state.chatStreamSegments).toContainEqual(
      expect.objectContaining({
        itemId: "preamble-restored",
        runId: "run-live",
        text: "Checking the workspace",
        ts: 900,
      }),
    );
  });

  it("restores cleared activity for an already-owned run after reconnect", async () => {
    const history = activeHistory("run-live");
    (history.inFlightRun as { events?: unknown[] }).events = [
      {
        runId: "run-live",
        seq: 2,
        stream: "tool",
        ts: 1_000,
        sessionKey: "main",
        data: {
          toolCallId: "call-reconnected",
          name: "read",
          phase: "start",
          args: { path: "README.md" },
        },
      },
    ];
    const state = createState(history);
    state.chatRunId = "run-live";
    state.chatStream = "The active response survived reconnect.";

    await loadHistoryWithBrowserTimers(state);

    expect(state.chatRunId).toBe("run-live");
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamSegments).toContainEqual(
      expect.objectContaining({
        runId: "run-live",
        text: "The active response survived reconnect.",
        toolCallId: "call-reconnected",
      }),
    );
    expect(state.chatToolMessages[0]).toMatchObject({
      runId: "run-live",
      toolCallId: "call-reconnected",
    });
  });

  it("restores an unpersisted assistant response from the active run snapshot", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [{ role: "user", content: "Continue working." }];
    history.inFlightRun!.text = "The response survived the reconnect.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe("The response survived the reconnect.");
    expect(state.chatStreamStartedAt).toEqual(expect.any(Number));
    expect(state.chatRunStartup).toEqual({ state: "activity", runId: "run-reconnected" });
  });

  it("restores the authoritative run start even before assistant text exists", async () => {
    const history = activeHistory("run-reconnected");
    history.inFlightRun!.startedAt = 123_456;
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBeNull();
    expect(state.chatStreamStartedAt).toBe(123_456);
  });

  it("adopts an active snapshot while binding its durable session identity", async () => {
    const history = activeHistory("run-reconnected");
    history.sessionId = "current-session";
    history.messages = [{ role: "user", content: "Continue working." }];
    history.inFlightRun!.text = "The response survived navigation.";
    const state = createState(history);
    state.currentSessionId = "previous-session";

    await loadChatHistory(state);

    expect(state.currentSessionId).toBe("current-session");
    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe("The response survived navigation.");
  });

  it("restores only the active response after its persisted assistant prefix", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "Continue working." },
      { role: "assistant", content: "Saved opening." },
    ];
    history.inFlightRun!.text = "Saved opening. Still working after reconnect.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(" Still working after reconnect.");
    expect(state.chatMessages).toEqual(history.messages);
  });

  it("retains the active-run prefix when a persisted steer follows its assistant", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "Start working." },
      {
        role: "assistant",
        content: "Saved opening.",
        __openclaw: { idempotencyKey: "run-reconnected" },
      },
      {
        role: "user",
        content: "Also check the result.",
        __openclaw: {
          idempotencyKey: "run-steer:user",
          steerTargetRunId: "run-reconnected",
        },
      },
    ];
    history.inFlightRun!.text = "Saved opening. Still working after the steer.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(" Still working after the steer.");
    expect(state.chatMessages).toEqual(history.messages);
  });

  it("replaces a pre-steer segment while retaining only the post-steer live tail", async () => {
    const history = activeHistory("run-reconnected");
    const originalUser = {
      role: "user",
      content: "Start working.",
      __openclaw: { idempotencyKey: "run-reconnected:user" },
    };
    const steerUser = {
      role: "user",
      content: "Also check the result.",
      __openclaw: {
        idempotencyKey: "run-steer:user",
        steerTargetRunId: "run-reconnected",
      },
    };
    history.messages = [
      originalUser,
      {
        role: "assistant",
        content: "Saved opening.",
        __openclaw: { idempotencyKey: "run-reconnected" },
      },
      steerUser,
    ];
    history.inFlightRun!.text = "Saved opening. Still working after the steer.";
    const state = createState(history);
    state.chatMessages = [originalUser, steerUser];
    state.chatRunId = "run-reconnected";
    handleChatGatewayEvent(state, {
      runId: "run-reconnected",
      sessionKey: "main",
      state: "delta",
      deltaText: "Saved opening. Still working after the steer.",
      message: {
        role: "assistant",
        content: "Saved opening. Still working after the steer.",
      },
    });
    state.chatStreamSegments = [
      {
        text: "Saved opening.",
        ts: 2,
        runId: "run-reconnected",
        boundaryRunId: "run-steer",
      },
    ];

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual(history.messages);
    expect(state.chatStreamSegments).toEqual([
      expect.objectContaining({
        text: "",
        boundaryMarker: true,
        boundaryRunId: "run-steer",
      }),
    ]);
    expect(state.chatStream).toBe(" Still working after the steer.");

    handleChatGatewayEvent(state, {
      runId: "run-reconnected",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Saved opening. Still working after the steer." }],
      },
    });
    expect(state.chatMessages).toHaveLength(4);
    expect(state.chatMessages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Still working after the steer." }],
    });
  });

  it("falls back from a trimmed live boundary to the persisted cumulative prefix", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      {
        role: "user",
        content: "Start working.",
        __openclaw: { idempotencyKey: "run-reconnected:user", seq: 1 },
      },
      {
        role: "assistant",
        content: "Saved opening.",
        __openclaw: { id: "saved-opening", idempotencyKey: "run-reconnected", seq: 2 },
      },
      {
        role: "user",
        content: "Also check the result.",
        __openclaw: {
          idempotencyKey: "run-steer:user",
          seq: 3,
          steerTargetRunId: "run-reconnected",
        },
      },
      {
        role: "user",
        content: "Queued follow-up.",
        __openclaw: { idempotencyKey: "queued-run:user", seq: 4 },
      },
    ];
    history.inFlightRun!.text = "Saved opening. Trimmed live tail.";
    const state = createState(history);

    await loadChatHistory(state);
    expect(state.chatStream).toBe(" Trimmed live tail.");
    const renderedBeforeTerminal = buildChatItems({
      paneId: "reconnected-steer-boundary",
      sessionKey: state.sessionKey,
      runId: state.chatRunId,
      messages: state.chatMessages,
      toolMessages: state.chatToolMessages,
      streamSegments: state.chatStreamSegments,
      stream: state.chatStream,
      streamStartedAt: state.chatStreamStartedAt,
      showToolCalls: true,
    }).flatMap((item) =>
      item.kind === "group"
        ? item.messages.map(({ message }) => extractText(message))
        : item.kind === "stream"
          ? [item.text.trim()]
          : [],
    );
    expect(renderedBeforeTerminal).toEqual([
      "Start working.",
      "Saved opening.",
      "Also check the result.",
      "Trimmed live tail.",
      "Queued follow-up.",
    ]);
    handleChatGatewayEvent(state, {
      runId: "run-reconnected",
      sessionKey: "main",
      state: "final",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Saved opening. Trimmed live tail. Final unseen suffix.",
          },
        ],
      },
    });

    expect(
      state.chatMessages.map((message) => ({
        role: (message as { role?: unknown }).role,
        text: extractText(message),
      })),
    ).toEqual([
      { role: "user", text: "Start working." },
      { role: "assistant", text: "Saved opening." },
      { role: "user", text: "Also check the result." },
      { role: "assistant", text: "Trimmed live tail. Final unseen suffix." },
      { role: "user", text: "Queued follow-up." },
    ]);

    reduceChatSessionProjection(
      state,
      {
        type: "messagePersisted",
        message: {
          role: "user",
          content: "Later authoritative user.",
          __openclaw: {
            id: "later-authoritative-user",
            idempotencyKey: "later-run:user",
            seq: 6,
          },
        },
        envelope: { messageId: "later-authoritative-user", messageSeq: 6 },
      },
      { scope: readChatSessionProjectionScope(state), runActive: false },
    );

    const visible = state.chatMessages.map((message) => extractText(message));
    expect(visible).toEqual([
      "Start working.",
      "Saved opening.",
      "Also check the result.",
      "Trimmed live tail. Final unseen suffix.",
      "Queued follow-up.",
      "Later authoritative user.",
    ]);
    expect(
      visible.filter((text) => text === "Trimmed live tail. Final unseen suffix."),
    ).toHaveLength(1);
  });

  it("does not trim a matching assistant prefix owned by an earlier run", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "An earlier request." },
      {
        role: "assistant",
        content: "Saved opening.",
        __openclaw: { idempotencyKey: "run-earlier" },
      },
      { role: "user", content: "Start the next request." },
    ];
    history.inFlightRun!.text = "Saved opening. Still working after reconnect.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe("Saved opening. Still working after reconnect.");
  });

  it("does not let unidentified older replies truncate a run-owned assistant", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "An earlier request." },
      { role: "assistant", content: "OK. Finished." },
      { role: "user", content: "Start the next request." },
      {
        role: "assistant",
        content: "OK.",
        __openclaw: { idempotencyKey: "run-reconnected" },
      },
    ];
    history.inFlightRun!.text = "OK. Finished. New details";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(" Finished. New details");
  });

  it("strips every persisted assistant segment from a tool-using turn", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "Continue working." },
      { role: "assistant", content: "Saved " },
      { role: "toolResult", content: "Tool output." },
      { role: "assistant", content: "opening." },
    ];
    history.inFlightRun!.text = "Saved opening. Still working after reconnect.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(" Still working after reconnect.");
    expect(state.chatMessages).toEqual(history.messages);
  });

  it("does not duplicate an assistant response already persisted in history", async () => {
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "Continue working." },
      { role: "assistant", content: "Already saved." },
    ];
    history.inFlightRun!.text = "Already saved.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBeNull();
    expect(state.chatMessages).toEqual(history.messages);
  });

  it("adopts an active run before its first assistant text arrives", async () => {
    const history = activeHistory("run-reconnected");
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBeNull();
    expect(state.chatRunStartup).toEqual({ state: "activity", runId: "run-reconnected" });
  });

  it.each([
    { name: "a terminal run", sessionInfo: { hasActiveRun: false, activeRunIds: [] } },
    {
      name: "a different authoritative active run",
      sessionInfo: { hasActiveRun: true, activeRunIds: ["run-newer"] },
    },
  ])("does not restore $name", async ({ sessionInfo }) => {
    const history = activeHistory("run-reconnected");
    history.sessionInfo = { ...history.sessionInfo!, ...sessionInfo };
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
  });

  it.each(["NO_REPLY", "HEARTBEAT_OK"])(
    "does not expose a suppressed %s response while restoring run ownership",
    async (hiddenResponse) => {
      const history = activeHistory("run-reconnected");
      history.inFlightRun!.text = hiddenResponse;
      const state = createState(history);

      await loadChatHistory(state);

      expect(state.chatRunId).toBe("run-reconnected");
      expect(state.chatStream).toBeNull();
    },
  );

  it("does not let delayed history overwrite a newer live run", async () => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const request = vi.fn().mockReturnValue(historyPromise);
    const state = createState(activeHistory("run-reconnected"));
    state.client = { request } as unknown as GatewayBrowserClient;

    const loadPromise = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    state.chatRunId = "run-newer";
    state.chatStream = "A newer live response.";
    resolveHistory(activeHistory("run-reconnected"));
    await loadPromise;

    expect(state.chatRunId).toBe("run-newer");
    expect(state.chatStream).toBe("A newer live response.");
  });

  it("adopts the snapshot when remount reconciliation replaces an unchanged run map", async () => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const request = vi.fn().mockReturnValue(historyPromise);
    const history = activeHistory("run-reconnected");
    history.inFlightRun!.text = "The response survived navigation.";
    const state = createState(history);
    state.client = { request } as unknown as GatewayBrowserClient;

    const loadPromise = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    const projection = getChatSessionProjection(state);
    setChatSessionProjection(state, { ...projection, runs: { ...projection.runs } });
    resolveHistory(history);
    await loadPromise;

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe("The response survived navigation.");
  });

  it.each([
    {
      name: "an incremental",
      snapshotText: "Saved opening. Buffered before reconnect.",
      deltaText: " And live.",
      cumulativeText: "Saved opening. Buffered before reconnect. And live.",
      expectedTail: " Buffered before reconnect. And live.",
    },
    {
      name: "a repeated-token",
      snapshotText: "Saved opening. repeat",
      deltaText: "repeat",
      cumulativeText: "Saved opening. repeatrepeat",
      expectedTail: " repeatrepeat",
    },
  ])(
    "merges $name same-run delta that arrives before history",
    async ({ snapshotText, deltaText, cumulativeText, expectedTail }) => {
      let resolveHistory!: (result: ChatHistoryResult) => void;
      const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
        resolveHistory = resolve;
      });
      const request = vi.fn().mockReturnValue(historyPromise);
      const history = activeHistory("run-reconnected");
      history.messages = [
        { role: "user", content: "Continue working." },
        { role: "assistant", content: "Saved opening." },
      ];
      history.inFlightRun!.text = snapshotText;
      const state = createState(history);
      state.client = { request } as unknown as GatewayBrowserClient;

      const loadPromise = loadChatHistory(state);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      handleChatGatewayEvent(state, {
        runId: "run-reconnected",
        sessionKey: "main",
        state: "delta",
        deltaText,
        message: { role: "assistant", content: cumulativeText },
      });
      resolveHistory(history);
      await loadPromise;

      expect(state.chatRunId).toBe("run-reconnected");
      expect(state.chatStream).toBe(expectedTail);
      expect(state.chatMessages).toEqual(history.messages);
    },
  );

  it("does not duplicate a live delta already covered by a newer history snapshot", async () => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const request = vi.fn().mockReturnValue(historyPromise);
    const history = activeHistory("run-reconnected");
    history.messages = [
      { role: "user", content: "Continue working." },
      { role: "assistant", content: "Saved opening." },
    ];
    history.inFlightRun!.text = "Saved opening. Buffered before reconnect. And live.";
    const state = createState(history);
    state.client = { request } as unknown as GatewayBrowserClient;

    const loadPromise = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    handleChatGatewayEvent(state, {
      runId: "run-reconnected",
      sessionKey: "main",
      state: "delta",
      deltaText: " Buffered before reconnect.",
      message: {
        role: "assistant",
        content: "Saved opening. Buffered before reconnect.",
      },
    });
    resolveHistory(history);
    await loadPromise;

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(" Buffered before reconnect. And live.");
  });

  it.each([
    {
      name: "ordinary persisted history",
      messages: [
        { role: "user", content: "Continue working." },
        { role: "assistant", content: "Saved opening. Buffered" },
      ],
    },
    {
      name: "run-owned history followed by a steer",
      messages: [
        { role: "user", content: "Continue working." },
        {
          role: "assistant",
          content: "Saved opening. Buffered",
          __openclaw: { idempotencyKey: "run-reconnected" },
        },
        {
          role: "user",
          content: "Also check the result.",
          __openclaw: { idempotencyKey: "run-steer:user" },
        },
      ],
    },
    {
      name: "multiple persisted assistant segments",
      messages: [
        { role: "user", content: "Continue working." },
        { role: "assistant", content: "Saved" },
        { role: "toolResult", content: "Tool output." },
        { role: "assistant", content: "opening. Buffered" },
      ],
    },
  ])("does not revive a live delta covered by $name", async ({ messages }) => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const request = vi.fn().mockReturnValue(historyPromise);
    const history = activeHistory("run-reconnected");
    history.messages = messages;
    history.inFlightRun!.text = "Saved opening. Buffered. New";
    const state = createState(history);
    state.client = { request } as unknown as GatewayBrowserClient;

    const loadPromise = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    handleChatGatewayEvent(state, {
      runId: "run-reconnected",
      sessionKey: "main",
      state: "delta",
      deltaText: "Saved opening.",
      message: { role: "assistant", content: "Saved opening." },
    });
    resolveHistory(history);
    await loadPromise;

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(". New");
    expect(state.chatMessages).toEqual(history.messages);
  });

  it.each([
    { name: "the snapshot run", completedRunId: "run-reconnected" },
    { name: "a newer intervening run", completedRunId: "run-newer" },
  ])("does not resurrect delayed history after $name completes", async ({ completedRunId }) => {
    let resolveHistory!: (result: ChatHistoryResult) => void;
    const historyPromise = new Promise<ChatHistoryResult>((resolve) => {
      resolveHistory = resolve;
    });
    const request = vi.fn().mockReturnValue(historyPromise);
    const state = createState(activeHistory("run-reconnected"));
    state.client = { request } as unknown as GatewayBrowserClient;

    const loadPromise = loadChatHistory(state);
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    handleChatGatewayEvent(state, {
      runId: completedRunId,
      sessionKey: "main",
      state: "delta",
      deltaText: "A response that completed while history was pending.",
    });
    handleChatGatewayEvent(state, {
      runId: completedRunId,
      sessionKey: "main",
      state: "final",
      message: { role: "assistant", content: "The intervening run completed." },
    });
    expect(state.chatRunId).toBeNull();

    resolveHistory(activeHistory("run-reconnected"));
    await loadPromise;

    expect(state.chatRunId).toBeNull();
    expect(state.chatStream).toBeNull();
  });
});
