/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatPendingInputsPage } from "../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { captureChatOutboxAdmission } from "../../lib/chat/outbox-store.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import { makeChatHost } from "./chat-host.test-support.ts";
import { applyChatPendingInputs } from "./chat-pending-inputs.ts";
import { admitQueuedMessageForSession } from "./chat-queue.ts";
import { resumeStoredChatOutboxes } from "./chat-send-actions.ts";
import { listStoredChatOutboxes } from "./composer-persistence.ts";

const sessionKey = "agent:main:restart-input";
const sessionId = "restart-input-session";
const item: ChatQueueItem = {
  id: "browser-input",
  sendRunId: "accepted-input",
  sessionKey,
  text: "Continue after the update",
  createdAt: 100,
  sendAttempts: 1,
  sendState: "waiting-reconnect",
};
function pending(state: "queued" | "interrupted" | "cancelled"): ChatPendingInputsPage {
  return {
    total: 1,
    items: [
      {
        id: "durable-input",
        runId: item.sendRunId,
        acceptedAt: 100,
        state,
        message: { role: "user", content: item.text },
      },
    ],
  };
}

beforeEach(() => vi.stubGlobal("sessionStorage", createStorageMock()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("accepted input restart handoff", () => {
  it.each([
    { queueMode: undefined, status: "running", hasActiveRun: false, immediate: false },
    { queueMode: "followup", status: "running", hasActiveRun: false, immediate: false },
    { queueMode: "collect", status: "queued", hasActiveRun: false, immediate: false },
    { queueMode: "followup", status: "running", hasActiveRun: true, immediate: false },
    { queueMode: "steer", status: "running", hasActiveRun: true, immediate: true },
    { queueMode: "interrupt", status: "running", hasActiveRun: true, immediate: true },
  ] as const)(
    "preserves recovered-turn ordering for $queueMode ($status, active: $hasActiveRun)",
    async ({ queueMode, status, hasActiveRun, immediate }) => {
      let recoveryFinished = false;
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": () => ({
            sessionId,
            messages: [],
            pendingInputs: pending("interrupted"),
            inputReceipts: [{ runId: item.sendRunId, state: "pending" }],
            sessionInfo: {
              key: sessionKey,
              sessionId,
              status: recoveryFinished ? "done" : status,
              hasActiveRun: recoveryFinished ? false : hasActiveRun,
            },
          }),
          "chat.send": { runId: item.sendRunId, status: "started", messageSeq: 10 },
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
          ...item,
          sessionId,
          ...(queueMode ? { queueMode } : {}),
        }),
      ).toBe(true);
      await resumeStoredChatOutboxes(host);
      expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(
        immediate ? 1 : 0,
      );
      if (!immediate) {
        expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
      }
      recoveryFinished = true;
      await resumeStoredChatOutboxes(host);
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(sends).toHaveLength(1);
      expect(sends[0]?.[1]).toMatchObject({
        sessionKey,
        sessionId,
        idempotencyKey: item.sendRunId,
        message: item.text,
        ...(queueMode ? { queueMode } : {}),
      });
      expect(listStoredChatOutboxes(host)).toEqual([]);
    },
  );

  it("does not retire or resend an input from a replaced physical session", async () => {
    const replacementSessionId = "replacement-session";
    const host = makeChatHost({
      sessionKey,
      currentSessionId: replacementSessionId,
      requestHandlers: {
        "chat.history": {
          sessionId: replacementSessionId,
          messages: [
            {
              role: "user",
              content: "A different source",
              __openclaw: {
                id: "replacement-input",
                seq: 1,
                idempotencyKey: `${item.sendRunId}:user`,
              },
            },
          ],
          pendingInputs: { items: [], total: 0 },
          sessionInfo: {
            key: sessionKey,
            sessionId: replacementSessionId,
            status: "done",
            hasActiveRun: false,
          },
        },
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        ...item,
        sessionId,
      }),
    ).toBe(true);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sessionId).toBe(sessionId);
    await resumeStoredChatOutboxes(host);
    expect(listStoredChatOutboxes(host)[0]?.queue[0]).toMatchObject({
      sessionId,
      sendState: "unconfirmed",
    });
    expect(host.request.mock.calls.some(([method]) => method === "chat.send")).toBe(false);
  });
  it("finds interrupted custody behind a newer pending-input page", async () => {
    const older = pending("interrupted");
    const host = makeChatHost({
      sessionKey,
      currentSessionId: sessionId,
      requestHandlers: {
        "chat.history": (params: { pendingBefore?: number }) => ({
          sessionId,
          messages: [],
          pendingInputs:
            params.pendingBefore === 21
              ? older
              : {
                  total: 21,
                  items: Array.from({ length: 20 }, (_, index) => ({
                    id: `newer-${index}`,
                    runId: `newer-run-${index}`,
                    acceptedAt: 200 + index,
                    state: "queued",
                    message: { role: "user", content: `Newer input ${index}` },
                  })),
                  nextBefore: 21,
                },
          inputReceipts: [{ runId: item.sendRunId, state: "pending" }],
          sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
        }),
        "chat.send": { runId: item.sendRunId, status: "started" },
      },
    });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), {
        ...item,
        sessionId,
      }),
    ).toBe(true);
    await resumeStoredChatOutboxes(host);
    expect(host.request).toHaveBeenCalledWith(
      "chat.history",
      expect.objectContaining({ pendingBefore: 21 }),
    );
    expect(host.request.mock.calls.filter(([method]) => method === "chat.send")).toHaveLength(1);
  });
  it("retains browser custody until transcript consumption, then retires it", () => {
    const host = makeChatHost({ sessionKey, currentSessionId: sessionId, requestHandlers: {} });
    expect(
      admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), item),
    ).toBe(true);

    applyChatPendingInputs(host, pending("queued"));
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
    applyChatPendingInputs(host, pending("interrupted"));
    expect(listStoredChatOutboxes(host)[0]?.queue[0]?.sendRunId).toBe(item.sendRunId);
    applyChatPendingInputs(
      host,
      { items: [], total: 0 },
      {
        receipts: [{ runId: item.sendRunId!, state: "consumed", consumedByEventId: "aggregate" }],
      },
    );
    expect(listStoredChatOutboxes(host)).toEqual([]);
  });

  it.each(["interrupted", "queued", "cancelled", "unknown"] as const)(
    "only re-admits positively interrupted input after reconnect (%s)",
    async (disposition) => {
      const page = disposition === "unknown" ? { items: [], total: 0 } : pending(disposition);
      const host = makeChatHost({
        sessionKey,
        currentSessionId: sessionId,
        requestHandlers: {
          "chat.history": {
            sessionId,
            messages: [],
            pendingInputs: page,
            inputReceipts:
              disposition === "unknown" ? [] : [{ runId: item.sendRunId, state: "pending" }],
            sessionInfo: { key: sessionKey, sessionId, status: "done", hasActiveRun: false },
          },
          "chat.send": { runId: item.sendRunId, status: "started" },
        },
      });
      expect(
        admitQueuedMessageForSession(host, captureChatOutboxAdmission(host, sessionKey), item),
      ).toBe(true);
      await resumeStoredChatOutboxes(host);
      const sends = host.request.mock.calls.filter(([method]) => method === "chat.send");
      expect(sends).toHaveLength(disposition === "interrupted" ? 1 : 0);
      if (disposition === "interrupted") {
        expect(sends[0]?.[1]).toMatchObject({
          message: item.text,
          sessionKey,
          sessionId,
          idempotencyKey: item.sendRunId,
        });
      }
    },
  );
});
