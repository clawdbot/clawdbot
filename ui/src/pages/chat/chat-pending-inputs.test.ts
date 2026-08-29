/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  applyChatPendingInputs,
  getChatPendingInputs,
  loadChatPendingInputs,
} from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession, readChatQueueForScope } from "./chat-queue.ts";
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
beforeEach(() => {
  vi.stubGlobal("sessionStorage", createStorageMock());
});
afterEach(() => {
  resetChatThreadState();
  vi.unstubAllGlobals();
});

describe("server-owned pending input display", () => {
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
