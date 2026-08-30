/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatHistoryLoadState, loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import {
  applyChatPendingInputs,
  getChatPendingInputs,
  loadChatPendingInputs,
} from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession, readChatQueueForScope } from "./chat-queue.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { resetChatThreadState } from "./chat-thread.ts";

const sessionKey = "agent:main:accepted-inputs";
const sessionId = "accepted-input-session";
const input: ChatPendingInputsPage["items"][number] = {
  id: "input-1",
  runId: "run-queued",
  acceptedAt: 100,
  state: "interrupted",
  message: {
    role: "user",
    content: "Keep my accepted input",
    __openclaw: { id: "pending:input-1" },
  },
};
const page: ChatPendingInputsPage = { items: [input], total: 2, nextBefore: 2 };

function makeChatPageHost({
  requestHandlers,
  ...overrides
}: Partial<ChatPageHost> & { requestHandlers: Record<string, unknown> }) {
  const { client, hello, request, sessions } = makeChatHost({ requestHandlers });
  const context = { ...createInitializationContext(), sessions };
  const host = createPageState(
    context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    { querySelector: () => null },
  );
  Object.assign(host, { client, hello, connected: true }, overrides);
  return Object.assign(host, { request });
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  resetChatThreadState();
  vi.unstubAllGlobals();
});

describe("server-owned pending input display", () => {
  it.each(["send", "agent.run.started", "agent.input.settled"])(
    "refreshes accepted inputs on %s while a retained pane is running",
    async (reason) => {
      const host = makeChatPageHost({
        sessionKey,
        currentSessionId: sessionId,
        chatRunId: "active-run",
        chatStream: "Live output",
        requestHandlers: {
          "chat.history": {
            sessionId,
            messages: [],
            pendingInputs: page,
            sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, status: "running" },
          },
        },
      });
      applyChatPendingInputs(host, { items: [], total: 0 });
      handlePageGatewayEvent(
        host,
        {
          type: "event",
          event: "sessions.changed",
          payload: { sessionKey, agentId: "main", reason, hasActiveRun: true },
        },
        () => false,
      );
      await vi.waitFor(() => expect(getChatPendingInputs(host)?.page).toEqual(page));
      expect(host.chatRunId).toBe("active-run");
      expect(host.chatStream).toBe("Live output");
      expect(host.request.mock.calls.filter(([method]) => method === "chat.history")).toHaveLength(
        1,
      );
    },
  );

  it.each(["active-run", null])(
    "supersedes a stale custody read when a user input promotes with local run %s",
    async (runId) => {
      const stale = createDeferred<unknown>();
      const initialUser = {
        role: "user",
        content: "First turn",
        __openclaw: { id: "first", seq: 1 },
      };
      const promoted = {
        role: "user",
        content: "Keep my accepted input",
        __openclaw: { id: input.id, seq: 2 },
      };
      const toolMessage = { role: "assistant", runId: "active-run", toolCallId: "live-tool" };
      let historyReads = 0;
      const host = makeChatPageHost({
        sessionKey,
        currentSessionId: sessionId,
        chatRunId: runId,
        chatStream: runId ? "Live output" : null,
        chatMessages: [initialUser],
        chatHistoryPagination: { hasMore: false, totalMessages: 1 },
        chatToolMessages: [toolMessage],
        toolStreamOrder: ["live-tool"],
        toolStreamById: new Map([
          [
            "live-tool",
            {
              toolCallId: "live-tool",
              runId: "active-run",
              name: "exec",
              startedAt: 1,
              receivedAt: 1,
              message: toolMessage,
            },
          ],
        ]),
        requestHandlers: {
          "chat.history": () =>
            ++historyReads === 1
              ? stale.promise
              : {
                  sessionId,
                  messages: [initialUser, promoted],
                  pendingInputs: { items: [], total: 0 },
                  sessionInfo: {
                    key: sessionKey,
                    sessionId,
                    hasActiveRun: true,
                    status: "running",
                  },
                },
        },
      });
      applyChatPendingInputs(host, page);
      const loading = loadChatHistory(host);
      handlePageGatewayEvent(host, {
        type: "event",
        event: "session.message",
        payload: {
          sessionKey,
          agentId: "main",
          sessionId,
          hasActiveRun: true,
          messageId: input.id,
          messageSeq: 2,
          message: promoted,
        },
      });
      expect(historyReads).toBe(2);
      const refreshed = await loadChatHistory(host);
      expect(host.lastError).toBeNull();
      expect(getChatHistoryLoadState(host).phase).toBe("committed");
      expect(refreshed).toMatchObject({ pendingInputs: { items: [], total: 0 } });
      expect(getChatPendingInputs(host)?.page.total).toBe(0);
      stale.resolve({ sessionId, messages: [initialUser], pendingInputs: page });
      await loading;
      expect(getChatPendingInputs(host)?.page.total).toBe(0);
      expect(host.chatMessages).toEqual([initialUser, promoted]);
      expect(host.chatRunId).toBe(runId);
      expect(host.chatStream).toBe(runId ? "Live output" : null);
      expect(host.chatToolMessages).toEqual([toolMessage]);
      expect(host.toolStreamById.has("live-tool")).toBe(true);
      expect(historyReads).toBe(2);
    },
  );

  it("retires browser retry custody while keeping accepted input separate from history", async () => {
    const history = [
      { role: "assistant", content: "Still working", __openclaw: { id: "reply-1", seq: 1 } },
    ];
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": { messages: history, sessionId, pendingInputs: page } },
    });
    const queued = {
      id: "outbox-1",
      text: "Keep my accepted input",
      createdAt: 100,
      sessionKey,
      sendRunId: input.runId,
      sendState: "waiting-reconnect" as const,
    };
    expect(admitQueuedMessageForSession(host, sessionKey, queued)).toBe(true);
    await loadChatHistory(host);
    expect(readChatQueueForScope(host, sessionKey)).toEqual([]);
    expect(host.chatMessages).toEqual(history);
    expect(getChatPendingInputs(host)?.page).toEqual(page);
    const items = buildChatItems({
      paneId: "pending-pane",
      sessionKey,
      messages: host.chatMessages,
      pendingInputs: page.items,
      queue: host.chatQueue,
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    expect(items.filter((item) => item.kind === "group" && item.role === "user")).toHaveLength(1);
    expect(items).toContainEqual(
      expect.objectContaining({
        kind: "notice",
        text: expect.stringContaining("will not run automatically"),
      }),
    );
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });

  it("pages custody without replacing transcript or applying a stale physical-session response", async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise((done) => {
      resolve = done;
    });
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: { "chat.history": () => response },
    });
    const history = [{ role: "user", content: "Canonical history" }];
    host.chatMessages = history;
    applyChatPendingInputs(host, page);
    const loading = loadChatPendingInputs(host, 2);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 2 }),
    );
    host.currentSessionId = "replacement-session";
    resolve({ sessionId, pendingInputs: { items: [], total: 2 } });
    await loading;
    expect(host.chatMessages).toBe(history);
    expect(getChatPendingInputs(host)).toBeUndefined();
    expect(host.request).toHaveBeenCalledTimes(1);
  });

  it("replaces a server pending bubble with canonical persistence exactly once", () => {
    const promoted = {
      role: "user",
      content: "Keep my accepted input",
      __openclaw: { id: "input-1", seq: 2, idempotencyKey: "run-queued:user" },
    };
    const items = buildChatItems({
      paneId: "promoted-pane",
      sessionKey,
      messages: [promoted],
      pendingInputs: page.items,
      queue: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "group",
      role: "user",
      messages: [{ message: promoted }],
    });
  });

  it("does not treat another message sharing the run correlation as input promotion", () => {
    const items = buildChatItems({
      paneId: "correlated-pane",
      sessionKey,
      messages: [
        {
          role: "assistant",
          content: "Earlier result",
          __openclaw: { id: "another-entry", runId: input.runId },
        },
      ],
      pendingInputs: page.items,
      queue: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });
    expect(items.filter((item) => item.kind === "group" && item.role === "user")).toHaveLength(1);
  });
});
