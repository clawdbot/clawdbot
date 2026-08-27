// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import {
  cacheChatSessionSnapshot,
  readChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";

function createState(handler: (params?: unknown) => unknown) {
  return makeChatHost({
    requestHandlers: { "chat.history": handler },
    sessionKey: "main",
    connectionEpoch: 1,
  });
}

function message(role: "assistant" | "user", content: unknown, id: string, seq: number) {
  return { role, content, __openclaw: { id, seq } };
}

function seedCachedHistory(
  state: ReturnType<typeof createState>,
  messages: unknown[],
  deltaCursor?: string,
): ChatMessageCache {
  const cache: ChatMessageCache = new Map();
  state.chatMessagesBySession = cache;
  state.chatMessages = messages;
  state.chatHistoryPagination = { hasMore: false, completeSnapshot: true };
  state.currentSessionId = "session-cursor";
  cacheChatSessionSnapshot(
    cache,
    state,
    { sessionKey: state.sessionKey },
    {
      ...(deltaCursor !== undefined ? { deltaCursor } : {}),
      messages,
      pagination: state.chatHistoryPagination,
      sessionId: "session-cursor",
    },
  );
  return cache;
}

async function loadHistoryWithBrowserTimers(state: ReturnType<typeof createState>): Promise<void> {
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

describe("chat history cursor revalidation", () => {
  it("keeps cached paint while replay updates an existing tool message in place", async () => {
    const cached = message(
      "assistant",
      [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
      "assistant-tool",
      1,
    );
    const replayed = message(
      "assistant",
      [
        { type: "toolCall", id: "call-1", name: "read", arguments: {} },
        { type: "toolResult", toolCallId: "call-1", text: "file contents" },
      ],
      "assistant-tool",
      1,
    );
    const response = createDeferred<Record<string, unknown>>();
    const handler = vi.fn(() => response.promise);
    const state = createState(handler);
    const cache = seedCachedHistory(state, [cached], "cursor-1");

    const load = loadChatHistory(state);

    expect(state.chatMessages).toEqual([cached]);
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "cursor-1", sessionKey: "main" }),
    );
    response.resolve({
      kind: "delta",
      messages: [
        {
          sessionKey: "main",
          message: replayed,
          messageId: "assistant-tool",
          messageSeq: 1,
        },
      ],
      deltaCursor: "cursor-2",
      sessionInfo: {
        key: "main",
        kind: "direct",
        sessionId: "session-cursor",
        updatedAt: 2,
      },
    });
    await load;

    expect(state.chatMessages).toEqual([replayed]);
    expect(readChatSessionSnapshot(cache, state, { sessionKey: state.sessionKey })).toMatchObject({
      deltaCursor: "cursor-2",
      messages: [replayed],
    });
  });

  it("recovers a missed terminal failure even when cursor catch-up has no new messages", async () => {
    const cached = message("user", "cached", "cached-user", 1);
    const handler = vi.fn(async (_params?: unknown) => ({
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo: {
        key: "main",
        kind: "direct",
        sessionId: "session-cursor",
        updatedAt: 2,
        status: "failed",
        hasActiveRun: false,
        lastRunId: "run-first",
        lastRunError:
          "Git clone could not reach GitHub. Check the Gateway network connection and retry.",
      },
    }));
    const state = createState(handler);
    const cache = seedCachedHistory(state, [cached], "cursor-1");

    await loadChatHistory(state);

    expect(state.chatMessages).toEqual([cached]);
    expect(state.chatRunError?.summary).toContain(
      "Check the Gateway network connection and retry.",
    );
    expect(
      readChatSessionSnapshot(cache, state, { sessionKey: state.sessionKey })?.deltaCursor,
    ).toBe("cursor-2");
  });

  it("restores active commentary and tools with an empty cached delta", async () => {
    const cached = message("user", "cached", "cached-user", 1);
    const handler = vi.fn(async (_params?: unknown) => ({
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo: {
        key: "main",
        kind: "direct",
        sessionId: "session-cursor",
        updatedAt: 2,
        hasActiveRun: true,
        activeRunIds: ["run-live"],
        status: "running",
      },
      inFlightRun: {
        runId: "run-live",
        text: "",
        startedAt: 900,
        events: [
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
        ],
      },
    }));
    const state = createState(handler);
    seedCachedHistory(state, [cached], "cursor-1");

    await loadHistoryWithBrowserTimers(state);

    expect(state.chatRunId).toBe("run-live");
    expect(state.chatStreamSegments).toContainEqual(
      expect.objectContaining({
        itemId: "preamble-restored",
        runId: "run-live",
        text: "Checking the workspace",
      }),
    );
    expect(state.chatToolMessages).toContainEqual(
      expect.objectContaining({ runId: "run-live", toolCallId: "call-restored" }),
    );
  });

  it("clears a rejected cursor before falling back to a full tail fetch", async () => {
    const cached = message("user", "cached", "cached-user", 1);
    const fresh = message("assistant", "fresh", "fresh-assistant", 2);
    const owner: { state?: ReturnType<typeof createState>; cache?: ChatMessageCache } = {};
    const handler = vi
      .fn()
      .mockImplementationOnce(async () => ({ kind: "reset" }))
      .mockImplementationOnce(async () => {
        if (!owner.state || !owner.cache) {
          throw new Error("missing seeded cursor owner");
        }
        expect(
          readChatSessionSnapshot(owner.cache, owner.state, {
            sessionKey: owner.state.sessionKey,
          })?.deltaCursor,
        ).toBeUndefined();
        return {
          messages: [cached, fresh],
          deltaCursor: "cursor-fresh",
          sessionId: "session-cursor",
        };
      });
    const state = createState(handler);
    const cache = seedCachedHistory(state, [cached], "cursor-stale");
    owner.state = state;
    owner.cache = cache;

    await loadChatHistory(state);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ cursor: "cursor-stale" }));
    expect(handler.mock.calls[1]?.[0]).not.toHaveProperty("cursor");
    expect(state.chatMessages).toEqual([cached, fresh]);
    expect(
      readChatSessionSnapshot(cache, state, { sessionKey: state.sessionKey })?.deltaCursor,
    ).toBe("cursor-fresh");
  });

  it("uses a full tail fetch for a cached record without a cursor", async () => {
    const cached = message("user", "cached", "cached-user", 1);
    const fresh = message("assistant", "fresh", "fresh-assistant", 2);
    const handler = vi.fn(async (_params?: unknown) => ({
      messages: [cached, fresh],
      deltaCursor: "cursor-1",
      sessionId: "session-cursor",
    }));
    const state = createState(handler);
    seedCachedHistory(state, [cached]);

    await loadChatHistory(state);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("cursor");
    expect(state.chatMessages).toEqual([cached, fresh]);
  });
});
