// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { extractText } from "../../lib/chat/message-extract.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { admitStoredChatComposerQueueItem } from "./composer-persistence.ts";
import {
  getChatSessionProjection,
  readChatSessionProjectionScope,
  reduceChatSessionProjection,
} from "./history-merge.ts";
import { applySessionMessagePayload } from "./session-message-apply.ts";
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
  afterEach(() => vi.unstubAllGlobals());

  it.each(["live", "history-delta"] as const)(
    "retains an attributed pending steer across a leaf advance before %s persistence",
    async (delivery) => {
      vi.stubGlobal("sessionStorage", createStorageMock());
      const sessionKey = "agent:main:participant-steer";
      const sendRunId = "bob-send";
      const aliceFinal = {
        ...message("assistant", "Alice finished the command.", "alice-final", 4),
        timestamp: 2000,
      };
      const handler = vi.fn(
        async (): Promise<unknown> => ({
          kind: "delta",
          messages: [
            {
              sessionKey,
              message: aliceFinal,
              messageId: "alice-final",
              messageSeq: 4,
              runId: "alice-run",
            },
          ],
          deltaCursor: "cursor-4",
          sessionInfo: {
            key: sessionKey,
            kind: "direct",
            sessionId: "session-cursor",
            activeLeafEntryId: "alice-final",
            updatedAt: 2000,
            hasActiveRun: false,
            status: "done",
            lastRunId: "alice-run",
          },
        }),
      );
      const state = createState(handler);
      state.sessionKey = sessionKey;
      state.chatDisplayedLeafEntryId = "alice-tool-result";
      seedCachedHistory(
        state,
        [
          {
            ...message("user", "Run the long command.", "alice-user", 1),
            __openclaw: {
              id: "alice-user",
              seq: 1,
              idempotencyKey: "alice-run:user",
              senderId: "alice-profile",
              senderName: "Alice Proof",
            },
          },
          message(
            "assistant",
            [{ type: "toolCall", id: "exec-call", name: "exec", arguments: {} }],
            "alice-tool-call",
            2,
          ),
          {
            role: "toolResult",
            toolCallId: "exec-call",
            content: "Command finished.",
            __openclaw: { id: "alice-tool-result", seq: 3 },
          },
        ],
        "cursor-3",
      );
      const queued: ChatQueueItem = {
        id: "bob-queued-send",
        text: "Reply exactly: BOB_STEER_ACK",
        createdAt: 1500,
        sendRunId,
        sendState: "sending",
        sendAttempts: 1,
        queueMode: "steer",
        sessionKey,
        sender: { id: "bob-profile", name: "Bob Proof" },
      };
      expect(
        admitStoredChatComposerQueueItem(
          state,
          captureChatOutboxAdmission(state, sessionKey, queued.agentId),
          queued,
        ),
      ).toBe(true);
      state.chatQueue = [queued];
      const renderedBobMessages = () =>
        buildChatItems({
          paneId: "participant-steer-cursor",
          sessionKey,
          runId: state.chatRunId,
          messages: state.chatMessages,
          queue: state.chatQueue,
          toolMessages: state.chatToolMessages ?? [],
          streamSegments: state.chatStreamSegments ?? [],
          stream: state.chatStream,
          streamStartedAt: state.chatStreamStartedAt,
          showToolCalls: true,
        }).flatMap((item) =>
          item.kind === "group" && item.role === "user"
            ? item.messages.filter(
                ({ message: candidate }) => extractText(candidate) === queued.text,
              )
            : [],
        );
      expect(renderedBobMessages()).toHaveLength(1);

      // Delivery retirement materializes the acknowledged turn before its durable row arrives.
      expect(await retireDeliveredQueuedUserTurn(state, sendRunId, { sessionKey })).toBe("retired");
      expect(state.chatQueue).toEqual([]);
      expect(renderedBobMessages()).toHaveLength(1);
      await loadChatHistory(state);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ cursor: "cursor-3" }));
      expect(state.chatDisplayedLeafEntryId).toBe("alice-final");
      expect(renderedBobMessages()).toHaveLength(1);

      const persistedBob = {
        role: "user",
        content: queued.text,
        timestamp: queued.createdAt,
        idempotencyKey: `${sendRunId}:user`,
        __openclaw: {
          id: "bob-user",
          seq: 5,
          idempotencyKey: `${sendRunId}:user`,
          senderId: "bob-profile",
          senderName: "Bob Proof",
          recordTimestampMs: 2500,
        },
      };
      const persistedPayload = {
        sessionKey,
        clientRunId: sendRunId,
        message: persistedBob,
        messageId: "bob-user",
        messageSeq: 5,
      };
      if (delivery === "live") {
        applySessionMessagePayload(state, persistedPayload, true, {
          kind: "live",
          activeRunId: state.chatRunId,
        });
      } else {
        handler.mockResolvedValueOnce({
          kind: "delta",
          messages: [persistedPayload],
          deltaCursor: "cursor-5",
          sessionInfo: {
            key: sessionKey,
            kind: "direct",
            sessionId: "session-cursor",
            activeLeafEntryId: "bob-user",
            updatedAt: 2500,
            hasActiveRun: true,
            status: "running",
            lastRunId: "alice-run",
          },
        });
        await loadChatHistory(state);
      }

      expect(renderedBobMessages()).toHaveLength(1);
      expect(
        state.chatMessages.filter((candidate) => extractText(candidate) === queued.text),
      ).toEqual([persistedBob]);
    },
  );

  it("retains live and terminal run ownership across an accepted delta leaf advance", async () => {
    const state = createState(() => ({
      kind: "delta",
      messages: [],
      deltaCursor: "cursor-2",
      sessionInfo: {
        key: "main",
        kind: "direct",
        sessionId: "session-cursor",
        activeLeafEntryId: "next-leaf",
        updatedAt: 2,
        hasActiveRun: true,
      },
    }));
    state.chatDisplayedLeafEntryId = "previous-leaf";
    seedCachedHistory(state, [], "cursor-1");
    reduceChatSessionProjection(state, {
      type: "runTerminal",
      runId: "completed-run",
      status: "completed",
    });
    const projection = reduceChatSessionProjection(state, {
      type: "runDelta",
      runId: "active-run",
      message: message("assistant", "Still working.", "live-message", 1),
    });

    await loadChatHistory(state);

    const current = getChatSessionProjection(state, readChatSessionProjectionScope(state));
    expect(current.scope.activeLeafEntryId).toBe("next-leaf");
    expect(current.runs).toBe(projection.runs);
  });

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

  it("retires a missed terminal failure after a newer successful cursor catch-up", async () => {
    const cached = message("user", "cached", "cached-user", 1);
    const handler = vi.fn(
      async (_params?: unknown): Promise<unknown> => ({
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
      }),
    );
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

    const reply = message("assistant", "Recovery completed.", "retry-answer", 2);
    handler.mockResolvedValueOnce({
      kind: "delta",
      messages: [{ message: reply, messageId: "retry-answer", messageSeq: 2, runId: "run-retry" }],
      deltaCursor: "cursor-3",
      sessionInfo: {
        key: "main",
        kind: "direct",
        sessionId: "session-cursor",
        updatedAt: 3,
        status: "done",
        hasActiveRun: false,
        lastRunId: "run-retry",
      },
    });
    await loadChatHistory(state);

    expect(handler).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: "cursor-2" }));
    expect(state.chatMessages.map(extractText)).toEqual(["cached", "Recovery completed."]);
    expect(state.chatRunError).toBeNull();
  });

  it.each([
    { kind: "delta", persistedRunId: undefined },
    { kind: "delta", persistedRunId: "run-live" },
    { kind: "delta", persistedRunId: "run-other" },
    { kind: "full", persistedRunId: "run-live" },
  ] as const)(
    "restores active commentary once from $kind history with persisted owner $persistedRunId",
    async ({ kind, persistedRunId }) => {
      const cached = message("user", "cached", "cached-user", 1);
      const commentary = {
        ...message("assistant", "Checking the workspace", "persisted-commentary", 2),
        __openclaw: { id: "persisted-commentary", seq: 2, runId: persistedRunId },
        openclawStreamFallback: {
          itemId: "preamble-restored",
          replacementText: "Checking the workspace",
          source: "segment",
        },
      };
      const cachedMessages = persistedRunId ? [cached, commentary] : [cached];
      const handler = vi.fn(async (_params?: unknown) => ({
        ...(kind === "delta"
          ? { kind: "delta", messages: [], deltaCursor: "cursor-2" }
          : { messages: cachedMessages }),
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
      if (kind === "delta") {
        seedCachedHistory(state, cachedMessages, "cursor-1");
      }

      await loadHistoryWithBrowserTimers(state);

      expect(state.chatRunId).toBe("run-live");
      if (persistedRunId === "run-live") {
        expect(state.chatStreamSegments).toEqual([]);
      } else {
        expect(state.chatStreamSegments).toContainEqual(
          expect.objectContaining({
            itemId: "preamble-restored",
            runId: "run-live",
            text: "Checking the workspace",
          }),
        );
      }
      expect(state.chatMessages).toEqual(cachedMessages);
      expect(state.chatToolMessages).toContainEqual(
        expect.objectContaining({ runId: "run-live", toolCallId: "call-restored" }),
      );
    },
  );

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
