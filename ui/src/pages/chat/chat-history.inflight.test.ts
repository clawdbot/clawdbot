// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { handleChatGatewayEvent } from "./chat-gateway.ts";
import { loadChatHistory, type ChatHistoryResult, type ChatState } from "./chat-history.ts";

function createState(result: ChatHistoryResult): ChatState {
  return {
    client: { request: vi.fn().mockResolvedValue(result) } as unknown as GatewayBrowserClient,
    connected: true,
    connectionEpoch: 1,
    sessionKey: "main",
    chatLoading: false,
    chatMessages: [],
    chatThinkingLevel: null,
    chatVerboseLevel: null,
    chatSending: false,
    chatMessage: "",
    chatAttachments: [],
    chatQueue: [],
    chatRunId: null,
    chatStream: null,
    chatStreamStartedAt: null,
    planStatus: null,
    lastError: null,
    hello: null,
    sessions: { setModelOverride: vi.fn(), reconcileRunTerminal: vi.fn() },
    requestUpdate: vi.fn(),
  };
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
        __openclaw: { idempotencyKey: "run-steer:user" },
      },
    ];
    history.inFlightRun!.text = "Saved opening. Still working after the steer.";
    const state = createState(history);

    await loadChatHistory(state);

    expect(state.chatRunId).toBe("run-reconnected");
    expect(state.chatStream).toBe(" Still working after the steer.");
    expect(state.chatMessages).toEqual(history.messages);
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
