/* @vitest-environment jsdom */
import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ChatInputReceipts,
  ChatPendingInputsPage,
} from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createChatSubmissions } from "../../app/chat-submissions.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import * as outboxPayloadStore from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxAdmission,
  storageTargetForGateway,
} from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { getChatHistoryLoadState } from "./chat-history-state.ts";
import { loadChatHistory } from "./chat-history.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { createInitializationContext } from "./chat-pane.test-support.ts";
import {
  applyChatPendingInputs,
  getChatPendingInputs,
  loadChatPendingInputs,
} from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession, readChatQueueForScope } from "./chat-queue.ts";
import { retireDeliveredQueuedUserTurn } from "./chat-send-support.ts";
import { handlePageGatewayEvent } from "./chat-state-events.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { createPageState } from "./chat-state-page.ts";
import { buildChatItems } from "./chat-thread-build.ts";
import { resetChatThreadState } from "./chat-thread.ts";
import { listStoredChatOutboxes, loadChatComposerSnapshot } from "./composer-persistence.ts";
import {
  admitChatSubmission,
  reduceChatSessionProjection,
  getChatSessionProjection,
} from "./history-merge.ts";
import { installOutboxBrowserStorage } from "./outbox-browser.test-support.ts";
import { prepareOutboxPayload } from "./outbox-payloads.ts";
import {
  applyChatCacheSnapshot,
  cacheChatSessionSnapshot,
  type ChatMessageCache,
} from "./session-message-cache.ts";
import { buildInitialChatSubmission, buildLocalUserMessage } from "./user-message-content.ts";

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
    timestamp: 100,
    __openclaw: { id: "pending:input-1" },
  },
};
const page: ChatPendingInputsPage = { items: [input], total: 2, nextBefore: 2 };

async function retainDeliveredUserTurn(
  host: Parameters<typeof retireDeliveredQueuedUserTurn>[0],
  item: ChatQueueItem,
): Promise<Parameters<typeof retireDeliveredQueuedUserTurn>[2]> {
  const admission = captureChatOutboxAdmission(
    host,
    item.sessionKey ?? host.sessionKey,
    item.agentId,
  );
  expect(admitQueuedMessageForSession(host, admission, item)).toBe(true);
  const outbox = expectDefined(
    listStoredChatOutboxes(host).find((entry) =>
      entry.queue.some((queued) => queued.id === item.id),
    ),
    "admitted provisional source",
  );
  expect(await retireDeliveredQueuedUserTurn(host, item.sendRunId, outbox)).toBe("retired");
  return outbox;
}

function makeChatPageHost({
  requestHandlers,
  ...overrides
}: Partial<ChatPageHost> & { requestHandlers: Record<string, unknown> }) {
  const { client, hello, request, sessions } = makeChatHost({ requestHandlers });
  const context = { ...createInitializationContext(), sessions };
  const host = createPageState(
    context,
    { invalidate: vi.fn(), afterCommit: () => () => {} },
    { dispatchEvent: () => true, querySelector: () => null },
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
  vi.restoreAllMocks();
});

describe("server-owned pending input display", () => {
  it("keeps cached local submissions available after pane remount", async () => {
    const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
    const runId = "cached-delivery";
    const scope = await retainDeliveredUserTurn(host, {
      id: runId,
      sendRunId: runId,
      sessionKey,
      sessionId,
      text: "Pending persistence",
      createdAt: 1,
    });
    applyChatCacheSnapshot(host, {
      messages: host.chatMessages,
      sessionId,
      pagination: { hasMore: false },
    });
    const remounted = makeChatHost({ sessionKey, currentSessionId: sessionId });
    remounted.client = host.client;
    remounted.chatSubmissions = host.chatSubmissions;

    expect(await retireDeliveredQueuedUserTurn(remounted, runId, scope)).toBe("retired");
    expect(remounted.chatMessages).toEqual(host.chatMessages);
    expect(remounted.chatMessages).toHaveLength(1);
  });

  it.each(["pending", "consumed", "canonical", "canonical-first"])(
    "keeps a %s delivered source retired when its terminal is replayed",
    async (receipt) => {
      const host = makeChatHost({ sessionKey, currentSessionId: sessionId });
      const runId = "consumed-delivery";
      const canonical = {
        role: "user",
        content: "Authoritative input",
        __openclaw: { id: "canonical-input", seq: 1, idempotencyKey: `${runId}:user` },
      };
      if (receipt === "canonical-first") {
        reduceChatSessionProjection(host, { type: "snapshotLoaded", messages: [canonical] });
      }
      const scope = await retainDeliveredUserTurn(host, {
        id: runId,
        sendRunId: runId,
        sessionKey,
        sessionId,
        text: "Collected input",
        createdAt: 1,
      });
      if (receipt === "pending" || receipt === "consumed") {
        const inputReceipt: ChatInputReceipts[number] =
          receipt === "pending"
            ? { runId, state: receipt }
            : { runId, state: receipt, consumedByEventId: "aggregate" };
        applyChatPendingInputs(host, { items: [], total: 0 }, { receipts: [inputReceipt] });
      } else {
        if (receipt === "canonical") {
          reduceChatSessionProjection(host, { type: "snapshotLoaded", messages: [canonical] });
        }
        expect(host.chatMessages).toEqual([canonical]);
        reduceChatSessionProjection(host, { type: "snapshotLoaded", messages: [] });
      }
      expect(host.chatMessages).toEqual([]);
      expect(await retireDeliveredQueuedUserTurn(host, runId, scope)).toBe("retired");
      expect(host.chatMessages).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );

  it("does not share receipt queries between panes with different provisional sources", async () => {
    const response = createDeferred<unknown>();
    const first = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatHistoryPagination: { hasMore: false },
      requestHandlers: { "chat.history": () => response.promise },
    });
    const second = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      client: first.client,
      chatHistoryPagination: { hasMore: false },
    });
    for (const [host, runId] of [
      [first, "source-a"],
      [second, "source-b"],
    ] as const) {
      await retainDeliveredUserTurn(host, {
        id: runId,
        sendRunId: runId,
        sessionKey,
        createdAt: 1,
        text: runId,
      });
    }
    const loading = [loadChatHistory(first), loadChatHistory(second)];
    const calls = first.request.mock.calls.filter(([method]) => method === "chat.history");
    response.resolve({ sessionId, messages: [], pendingInputs: { items: [], total: 0 } });
    await Promise.all(loading);
    expect(calls).toHaveLength(2);
    expect(calls.map(([, params]) => params)).toEqual([
      expect.objectContaining({ inputRunIds: ["source-a"] }),
      expect.objectContaining({ inputRunIds: ["source-b"] }),
    ]);
  });

  it("bounds receipt lookup without forgetting provisional sources beyond the first batch", async () => {
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      chatHistoryPagination: { hasMore: false },
      requestHandlers: {
        "chat.history": (params: { inputRunIds?: string[] }) => ({
          sessionId,
          messages: [],
          pendingInputs: { items: [], total: 0 },
          inputReceipts: params.inputRunIds?.map((runId) => ({
            runId,
            state: "consumed",
            consumedByEventId: "aggregate",
          })),
        }),
      },
    });
    for (let index = 0; index < 51; index++) {
      const runId = `source-${String(index).padStart(2, "0")}`;
      await retainDeliveredUserTurn(host, {
        id: runId,
        sendRunId: runId,
        sessionKey,
        createdAt: index,
        text: runId,
      });
    }
    await loadChatHistory(host);
    expect(host.chatMessages).toHaveLength(1);
    expect(host.request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({
        inputRunIds: Array.from(
          { length: 50 },
          (_, index) => `source-${String(index).padStart(2, "0")}`,
        ),
      }),
    );
    await loadChatHistory(host);
    expect(host.chatMessages).toEqual([]);
    expect(host.request).toHaveBeenLastCalledWith(
      "chat.history",
      expect.objectContaining({ inputRunIds: ["source-50"] }),
    );
  });

  it.each(["page", "delta"])(
    "retires consumed sources from %s history after missing custody and terminal events",
    async (delivery) => {
      const aggregate = {
        role: "user",
        content: "Collected source inputs",
        __openclaw: { id: "aggregate", seq: 1, idempotencyKey: "followup-collect:session:batch" },
      };
      const cache: ChatMessageCache = new Map();
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        chatRunId: "aggregate-run",
        chatStream: "Still working",
        chatMessages: [aggregate],
        chatHistoryPagination: { hasMore: false, completeSnapshot: true },
        chatMessagesBySession: cache,
        requestHandlers: {
          "chat.history": {
            ...(delivery === "delta" ? { kind: "delta", deltaCursor: "next" } : { sessionId }),
            messages: delivery === "delta" ? [] : [aggregate],
            pendingInputs: { items: [], total: 0 },
            inputReceipts: [
              { runId: "consumed-source", state: "consumed", consumedByEventId: "aggregate" },
            ],
            sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, status: "running" },
          },
        },
      });
      cacheChatSessionSnapshot(
        cache,
        host,
        { sessionKey },
        {
          messages: [aggregate],
          sessionId,
          pagination: host.chatHistoryPagination,
          ...(delivery === "delta" ? { deltaCursor: "previous" } : {}),
        },
      );
      for (const sendRunId of ["consumed-source", "unrelated-source"]) {
        await retainDeliveredUserTurn(host, {
          id: sendRunId,
          sendRunId,
          sessionKey,
          createdAt: 1,
          text: "Same source text",
          sender: { id: "author", name: "Author" },
          replyToId: "reply",
        });
      }
      const unrelated = host.chatMessages.at(-1);
      await loadChatHistory(host);
      expect(getChatHistoryLoadState(host).phase).toBe("committed");
      expect(host.chatMessages).toEqual([aggregate, unrelated]);
      expect(host.request).toHaveBeenCalledWith(
        "chat.history",
        expect.objectContaining({
          inputRunIds: ["consumed-source", "unrelated-source"],
        }),
      );
      expect(getChatPendingInputs(host)?.page.items).toEqual([]);
      expect(host.chatRunId).toBe("aggregate-run");
      expect(host.chatStream).toBe("Still working");
    },
  );

  it.each(
    ["direct", "page", "delta"].flatMap((delivery) =>
      [{ delivery, source: "delivered", custody: "interrupted" }].concat(
        ["queued", "interrupted", "cancelled", "consumed"].map((custody) => ({
          delivery,
          source: "initial",
          custody,
        })),
      ),
    ),
  )(
    "retires an attributed $source source on $delivery $custody custody without disturbing active work",
    async ({ delivery, source, custody }) => {
      const canonical = {
        role: "user",
        content: "An earlier canonical input",
        __openclaw: { id: "canonical-user", seq: 1, runId: "canonical-run" },
      };
      const acceptedPage =
        custody === "consumed"
          ? { items: [], total: 0 }
          : {
              ...page,
              items: [
                {
                  ...input,
                  state:
                    custody === "queued"
                      ? ("queued" as const)
                      : custody === "cancelled"
                        ? ("cancelled" as const)
                        : ("interrupted" as const),
                  message: {
                    role: "user",
                    content: "Keep my accepted input",
                    timestamp: 90,
                    __openclaw: {
                      id: `pending:${input.id}`,
                      senderName: "Authoritative Author",
                      media: [{ url: "media://inbound/initial.png", contentType: "image/png" }],
                    },
                  },
                },
              ],
            };
      const receipts =
        custody === "consumed"
          ? [
              {
                runId: expectDefined(input.runId, "accepted input run"),
                state: "consumed" as const,
                consumedByEventId: "aggregate",
              },
            ]
          : undefined;
      const history = source === "initial" ? [] : [canonical];
      const chatSubmissions = createChatSubmissions();
      const tool = { role: "assistant", toolCallId: "active-tool", runId: "active-run" };
      const cache: ChatMessageCache = new Map();
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        chatRunId: "active-run",
        chatStream: "Still working",
        chatToolMessages: [tool],
        chatMessages: history,
        chatSubmissions,
        chatHistoryPagination: { hasMore: false, completeSnapshot: true },
        chatMessagesBySession: cache,
        requestHandlers: {
          "chat.history": {
            ...(delivery === "delta" ? { kind: "delta", deltaCursor: "next" } : { sessionId }),
            messages: delivery === "delta" ? [] : history,
            pendingInputs: acceptedPage,
            inputReceipts: receipts,
            sessionInfo: { key: sessionKey, sessionId, hasActiveRun: true, status: "running" },
          },
        },
      });
      cacheChatSessionSnapshot(
        cache,
        host,
        { sessionKey },
        {
          messages: history,
          sessionId,
          pagination: { hasMore: false, completeSnapshot: true },
          ...(delivery === "delta" ? { deltaCursor: "previous" } : {}),
        },
      );
      for (const sendRunId of [input.runId, "other-source"]) {
        const item = {
          id: `local-${sendRunId}`,
          sendRunId,
          sessionKey,
          createdAt: 100,
          text: "Keep my accepted input",
          sender: { id: "author", name: "Author" },
          replyToId: "reply-target",
        };
        if (source === "initial" && sendRunId === input.runId) {
          chatSubmissions.retain(
            buildInitialChatSubmission(
              sessionKey,
              {
                ...item,
                attachments: [
                  {
                    id: "initial-image",
                    mimeType: "image/png",
                    dataUrl: "data:image/png;base64,iVBORw0KGgo=",
                  },
                ],
              },
              host.client!,
              sendRunId,
            ),
          );
          admitChatSubmission(host);
        } else {
          await retainDeliveredUserTurn(host, item);
        }
      }
      const unrelated = host.chatMessages.at(-1);
      if (delivery === "direct") {
        applyChatPendingInputs(host, acceptedPage, { receipts });
      } else {
        await loadChatHistory(host);
        expect(host.lastError).toBeNull();
        expect(getChatHistoryLoadState(host).phase).toBe("committed");
      }
      expect(host.chatMessages).toEqual([...history, unrelated]);
      expect(getChatSessionProjection(host).messages).toEqual([...history, unrelated]);
      expect(host.chatRunId).toBe("active-run");
      expect(host.chatStream).toBe("Still working");
      expect(host.chatToolMessages).toEqual([tool]);
      const displayed = getChatPendingInputs(host)?.page;
      expect(displayed).toEqual(acceptedPage);
      if (custody !== "consumed") {
        const displayedMessage = displayed!.items[0]!.message;
        expect(readSessionMessageIdentity(displayedMessage)).toMatchObject({
          id: `pending:${input.id}`,
          sequence: null,
          sendId: null,
        });
      }
      // Empty later snapshots and a fresh pane must not turn retained image bytes back into input.
      reduceChatSessionProjection(
        host,
        { type: "snapshotLoaded", messages: history },
        { runActive: true },
      );
      expect(admitChatSubmission(host)).toBe(false);
      const remounted = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        client: host.client,
        chatSubmissions,
      });
      expect(admitChatSubmission(remounted)).toBe(false);
      expect(remounted.chatMessages).toEqual([]);
      // Retirement does not hide distinct or uncorrelated server-owned inputs.
      const otherInputs = ["other-accepted-source", undefined].map((runId) => ({
        id: `other-${runId ?? "uncorrelated"}`,
        acceptedAt: input.acceptedAt,
        state: input.state,
        runId,
        message: {
          role: "user",
          content: "Keep my accepted input",
          __openclaw: { media: [{ url: "media://inbound/another.png" }] },
        },
      }));
      applyChatPendingInputs(host, {
        ...acceptedPage,
        items: [...acceptedPage.items, ...otherInputs],
        total: acceptedPage.total + otherInputs.length,
      });
      expect(getChatPendingInputs(host)?.page.items.slice(-2)).toEqual(otherInputs);
      expect(getChatPendingInputs(host)?.page.items.slice(0, -2)).toEqual(displayed?.items);
      applyChatPendingInputs(host, { items: [], total: 0 });
      expect(host.chatMessages).toEqual([...history, unrelated]);
      if (custody !== "consumed") {
        const promoted = {
          role: "user",
          content: "authoritative projection",
          __openclaw: {
            id: input.id,
            seq: 4,
            idempotencyKey: `${input.runId}:user`,
            runId: "execution-run",
            senderName: "Authoritative Author",
          },
        };
        reduceChatSessionProjection(host, { type: "messagePersisted", message: promoted });
        expect(host.chatMessages).toHaveLength(history.length + 2);
        expect(host.chatMessages).toContain(promoted);
        expect(host.chatMessages.filter((message) => message !== promoted)).toEqual([
          ...history,
          unrelated,
        ]);
        expect(admitChatSubmission(host)).toBe(false);
      }
    },
  );

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

  it.each(["text", "blob"])(
    "retires browser retry custody while keeping accepted %s input separate from history",
    async (kind) => {
      if (kind === "blob") {
        installOutboxBrowserStorage();
      }
      const history = [
        { role: "assistant", content: "Still working", __openclaw: { id: "reply-1", seq: 1 } },
      ];
      const imageBase64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0cAAAAASUVORK5CYII=";
      const imageBytes = Buffer.from(imageBase64, "base64");
      const attachment = {
        id: "custody-image",
        mimeType: "image/png",
        fileName: "custody.png",
        sizeBytes: imageBytes.length,
        dataUrl: `data:image/png;base64,${imageBase64}`,
      };
      let queued: ChatQueueItem = {
        id: "outbox-1",
        text: "Keep my accepted input",
        createdAt: 100,
        sessionKey,
        sendRunId: input.runId,
        sendState: "waiting-reconnect",
        ...(kind === "blob" ? { attachments: [attachment] } : {}),
      };
      const message =
        kind === "blob"
          ? expectDefined(
              buildLocalUserMessage({
                text: queued.text,
                attachments: [attachment],
                createdAt: input.acceptedAt,
                runId: input.runId,
              }),
              "complete accepted attachment message",
            )
          : input.message;
      const acceptedPage: ChatPendingInputsPage = { ...page, items: [{ ...input, message }] };
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": { messages: history, sessionId, pendingInputs: acceptedPage },
        },
      });
      const cleanup = vi.spyOn(outboxPayloadStore, "removeOutboxPayloads");
      if (kind === "blob") {
        const prepared = await prepareOutboxPayload(host, queued);
        if (prepared.status !== "ready") {
          throw new Error(`Could not prepare custody attachment: ${prepared.reason}`);
        }
        queued = { ...queued, ...prepared.update };
        expect(queued.attachmentPayload).toBeDefined();
      }
      const reference = queued.attachmentPayload;
      const payloadOwner = reference
        ? {
            tabId: reference.tabId,
            gatewayOwner: storageTargetForGateway(host.settings.gatewayUrl).gatewayOwner,
            recoveryScope: reference.recoveryScope,
            queueId: queued.id,
          }
        : undefined;
      if (reference && payloadOwner) {
        sessionStorage.setItem("openclaw.control.outboxTab.v1", reference.tabId);
        const stored = await outboxPayloadStore.readOutboxPayload(payloadOwner, reference);
        if (stored.status !== "ready") {
          throw new Error(`Expected stored custody bytes: ${stored.reason}`);
        }
        expect(stored.value).toHaveLength(1);
        expect(Buffer.from(await stored.value[0]!.blob.arrayBuffer())).toEqual(imageBytes);
      }
      expect(
        admitQueuedMessageForSession(
          host,
          captureChatOutboxAdmission(host, sessionKey, queued.agentId),
          queued,
        ),
      ).toBe(true);
      expect(
        loadChatComposerSnapshot(host, sessionKey)?.queue[0]?.attachments?.[0]?.dataUrl,
      ).toBeUndefined();
      await loadChatHistory(host);
      expect(readChatQueueForScope(host, sessionKey)).toEqual([]);
      expect(listStoredChatOutboxes(host)).toEqual([]);
      expect(host.chatMessages).toEqual(history);
      expect(getChatPendingInputs(host)?.page).toEqual(acceptedPage);
      if (reference && payloadOwner) {
        await vi.waitFor(async () => {
          expect(await outboxPayloadStore.readOutboxPayload(payloadOwner, reference)).toEqual({
            status: "failed",
            reason: "missing",
          });
        });
        expect(cleanup).toHaveBeenCalledTimes(1);
        expect(cleanup).toHaveBeenCalledWith([reference]);
      } else {
        expect(cleanup).not.toHaveBeenCalled();
      }
      const items = buildChatItems({
        paneId: "pending-pane",
        sessionKey,
        messages: host.chatMessages,
        pendingInputs: acceptedPage.items,
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
          kind: "group",
          role: "user",
          messages: [expect.objectContaining({ message })],
        }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          kind: "notice",
          text: expect.stringContaining("will not run automatically"),
        }),
      );
      expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
    },
  );

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

  it("places accepted input at its acceptance time instead of after newer history", () => {
    const earlier = { role: "assistant", content: "Earlier reply", timestamp: 50 };
    const later = { role: "assistant", content: "Later reply", timestamp: 150 };
    const items = buildChatItems({
      paneId: "chronological-pending-pane",
      sessionKey,
      messages: [earlier, later],
      pendingInputs: page.items,
      queue: [],
      toolMessages: [],
      streamSegments: [],
      stream: null,
      streamStartedAt: null,
      showToolCalls: true,
    });

    expect(items).toMatchObject([
      { kind: "group", role: "assistant", messages: [{ message: earlier }] },
      {
        kind: "group",
        role: "user",
        messages: [{ message: { content: "Keep my accepted input" } }],
      },
      { kind: "notice", timestamp: input.acceptedAt },
      { kind: "group", role: "assistant", messages: [{ message: later }] },
    ]);
  });

  it.each(["user", "assistant"])(
    "preserves a canonical %s sharing the pending run correlation",
    (role) => {
      const canonical = {
        role,
        content: "Earlier result",
        __openclaw: { id: "another-entry", runId: input.runId },
      };
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        chatMessages: [canonical],
      });
      applyChatPendingInputs(host, page);
      expect(host.chatMessages).toEqual([canonical]);
      const items = buildChatItems({
        paneId: "correlated-pane",
        sessionKey,
        messages: host.chatMessages,
        pendingInputs: page.items,
        queue: [],
        toolMessages: [],
        streamSegments: [],
        stream: null,
        streamStartedAt: null,
        showToolCalls: true,
      });
      const displayed = items.flatMap((item) =>
        item.kind === "group" ? item.messages.map((entry) => entry.message) : [],
      );
      expect(displayed).toContain(canonical);
      expect(displayed.filter((message) => message === input.message)).toHaveLength(1);
    },
  );
});
