// Tests before-deliver hook ordering and payload mutation behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createChannelPartialDeliveryError } from "../../channels/turn/delivery-result.js";
import { createDirectPendingFinalCustody } from "../../channels/turn/direct-delivery-custody.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
  prepareReplyPayloadForDispatcher,
} from "./reply-dispatcher.js";

async function makePendingFinalFixture() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-dispatcher-pending-final-"));
  const storePath = path.join(tmpDir, "sessions.json");
  const sessionKey = "agent:main:telegram:direct:123";
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      sessionId: "session-1",
      status: "running",
      updatedAt: Date.now(),
      pendingFinalDelivery: {
        kind: "replayable",
        text: "final answer",
        createdAt: Date.now(),
        intentId: "intent-1",
        deliveries: [{ id: "delivery-1", state: "prepared" }],
      },
    },
  );
  const payload = setReplyPayloadMetadata(
    { text: "final answer" },
    {
      pendingFinalDeliveryCompletion: {
        deliveryId: "delivery-1",
        intentId: "intent-1",
        sessionId: "session-1",
        sessionKey,
        storePath,
      },
    },
  );
  return { payload, sessionKey, storePath, tmpDir };
}

describe("beforeDeliver in reply dispatcher", () => {
  it.each([
    {
      name: "unconfirmed send",
      result: { visibleReplySent: true, ambiguous: true },
      state: "unknown",
      count: "failedAfterSend",
      fallback: true,
    },
    {
      name: "channel transform",
      result: { visibleReplySent: false, suppression: { reason: "channel_transform" } },
      state: "suppressed",
      count: "deliveredNotVisible",
      fallback: true,
    },
    {
      name: "confirmed send",
      result: { visibleReplySent: true },
      state: "delivered",
      count: "delivered",
      fallback: true,
    },
    {
      name: "ordinary invisible result",
      result: { visibleReplySent: false },
      state: "delivered",
      count: "deliveredNotVisible",
      fallback: false,
    },
  ] as const)(
    "records callback settlement for $name before reopening",
    async ({ result, state, count, fallback }) => {
      const fixture = await makePendingFinalFixture();
      const deliver = vi.fn(async () => result);
      try {
        if (fallback) {
          attachReplyDispatchUndeliveredFallback(fixture.payload, { text: "fallback" });
        }
        const dispatcher = createReplyDispatcher({ deliver });
        dispatcher.sendFinalReply(fixture.payload);
        dispatcher.markComplete();
        const receipt = await dispatcher.waitForIdle();
        closeOpenClawAgentDatabasesForTest();
        expect(
          (loadSessionEntry(fixture) as InternalSessionEntry)?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: "delivery-1", state }]);
        expect(receipt?.counts.final[count]).toBe(1);

        const replay = createReplyDispatcher({ deliver });
        replay.sendFinalReply(fixture.payload);
        replay.markComplete();
        await replay.waitForIdle();
        expect(deliver).toHaveBeenCalledOnce();
      } finally {
        closeOpenClawAgentDatabasesForTest();
        await fs.rm(fixture.tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("settles explicitly non-visible delivery in the dispatcher receipt", async () => {
    const dispatcher = createReplyDispatcher({
      deliver: async () => ({ visibleReplySent: false }),
    });

    dispatcher.sendFinalReply({ text: "suppressed" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(receipt).toEqual({
      counts: {
        tool: {
          delivered: 0,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
        block: {
          delivered: 0,
          deliveredNotVisible: 0,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
        final: {
          delivered: 0,
          deliveredNotVisible: 1,
          cancelled: 0,
          failedBeforeSend: 0,
          failedAfterSend: 0,
        },
      },
      anyVisibleDelivered: false,
    });
  });

  it("delivers the attached fallback when the primary payload is cancelled", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const outcome = captureReplyDispatchDeliveryOutcome(primary);
    const dispatcher = createReplyDispatcher({
      beforeDeliver: (payload) => (payload.mediaUrl ? null : payload),
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    expect(dispatcher.sendFinalReply(primary)).toBe(true);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    await expect(outcome.promise).resolves.toBe("delivered");
    expect(receipt?.counts.final.cancelled).toBe(0);
  });

  it("does not resurrect fallback text after a channel transform veto", async () => {
    const delivered: ReplyPayload[] = [];
    const skipped: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      transformReplyPayload: (payload) => (payload.mediaUrl ? null : payload),
      onSkip: (_payload, info) => skipped.push(info.reason),
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    expect(dispatcher.sendFinalReply(primary)).toBe(false);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(skipped).toEqual(["channel_transform"]);
  });

  it.each([
    { queueCustody: undefined, deferred: false },
    { queueCustody: "held", deferred: false },
    { queueCustody: "released", deferred: false },
    { queueCustody: undefined, deferred: true },
    { queueCustody: "held", deferred: true },
    { queueCustody: "released", deferred: true },
  ] as const)(
    "retries a proven pre-transport failure only without held queue custody ($queueCustody, deferred=$deferred)",
    async ({ queueCustody, deferred }) => {
      const delivered: string[] = [];
      const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
      attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          if (payload.mediaUrl) {
            const cause = Object.assign(new Error("connect failed"), {
              code: "ECONNREFUSED",
              syscall: "connect",
            });
            const error = Object.assign(new OutboundDeliveryError(cause.message, { cause }), {
              queueCustody,
            });
            if (deferred) {
              return { finalization: Promise.reject(error) };
            }
            throw error;
          }
          delivered.push(payload.text ?? "");
          return undefined;
        },
        propagateRetryableNoSendFailure: true,
      });

      dispatcher.sendFinalReply(primary);
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      expect(delivered).toEqual(queueCustody === "held" ? [] : ["caption"]);
      expect(receipt?.counts.final.failedBeforeSend).toBe(queueCustody === "held" ? 1 : 0);
      expect(receipt?.counts.final.failedAfterSend).toBe(0);
      expect(receipt?.anyVisibleDelivered).toBe(queueCustody !== "held");
    },
  );

  it("does not duplicate text after an ambiguous transport failure", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const capture = captureReplyDispatchDeliveryOutcome(primary);
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
        throw new Error("send outcome unknown");
      },
    });

    dispatcher.sendFinalReply(primary);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    expect(receipt?.counts.final.failedAfterSend).toBe(1);
    expect(receipt?.hasPendingDelivery).toBe(true);
    expect(capture.hasPendingDelivery()).toBe(true);
  });

  it("does not call a proven permanent rejection pending", async () => {
    const payload: ReplyPayload = { text: "rejected", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(payload, { text: "rejected" });
    const capture = captureReplyDispatchDeliveryOutcome(payload);
    const deliver = vi.fn(async () => {
      throw new PlatformMessageNotDispatchedError("rejected before dispatch", {
        cause: undefined,
        retryable: false,
      });
    });
    const dispatcher = createReplyDispatcher({ deliver });
    dispatcher.sendFinalReply(payload);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledOnce();
    expect(receipt?.hasPendingDelivery).toBeUndefined();
    expect(capture.hasPendingDelivery()).toBe(false);
  });

  it("cancels delivery before queueing when transformReplyPayload returns null", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      transformReplyPayload: (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    expect(dispatcher.sendFinalReply({ text: "blocked reply" })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "safe reply" })).toBe(true);
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(receipt?.counts.final.cancelled).toBe(0);
  });

  it("does not rerun dynamic prefix normalization after pre-side-effect preparation", async () => {
    const delivered: string[] = [];
    let model = "first";
    const dispatcher = createReplyDispatcher({
      responsePrefix: "[{model}]",
      responsePrefixContextProvider: () => ({ model }),
      transformReplyPayload: (payload) => payload,
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });
    const prepared = prepareReplyPayloadForDispatcher(dispatcher, "final", { text: "reply" });
    if (prepared.kind !== "deliver") {
      throw new Error("expected prepared reply delivery");
    }
    model = "second";

    dispatcher.sendFinalReply(prepared.payload);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["[first] reply"]);
  });

  it("cancels delivery when beforeDeliver returns null", async () => {
    const delivered: string[] = [];
    const cancelled: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onBeforeDeliverCancelled: (payload) => {
        cancelled.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("blocked")) {
          return null;
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.sendFinalReply({ text: "safe reply" });
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(cancelled).toEqual(["blocked reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(receipt?.counts.final.cancelled).toBe(1);
  });

  it("notifies cancellation when beforeDeliver throws before delivery", async () => {
    const delivered: string[] = [];
    const cancelled: Array<{
      assistantMessageIndex?: number;
      kind: string;
      text: string;
    }> = [];
    const errors: Array<{
      assistantMessageIndex?: number;
      kind: string;
      message: string;
    }> = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      onBeforeDeliverCancelled: (payload, info) => {
        cancelled.push({
          assistantMessageIndex: info.assistantMessageIndex,
          kind: info.kind,
          text: payload.text ?? "",
        });
      },
      onError: (err, info) => {
        errors.push({
          assistantMessageIndex: info.assistantMessageIndex,
          kind: info.kind,
          message: err instanceof Error ? err.message : String(err),
        });
      },
      beforeDeliver: async () => {
        throw new Error("pre-delivery failed");
      },
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "blocked block" }, { assistantMessageIndex: 9 }),
    );
    dispatcher.markComplete();
    const receipt = await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([{ assistantMessageIndex: 9, kind: "block", text: "blocked block" }]);
    expect(errors).toEqual([
      { assistantMessageIndex: 9, kind: "block", message: "pre-delivery failed" },
    ]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(receipt?.counts.block).toMatchObject({ cancelled: 0, failedBeforeSend: 1 });
  });

  it("allows modifying payload in beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: async (payload: ReplyPayload) => {
        if (payload.text?.includes("error")) {
          return { ...payload, text: "replaced" };
        }
        return payload;
      },
    });

    dispatcher.sendFinalReply({ text: "some error occurred" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["replaced"]);
  });

  it("preserves payload metadata through beforeDeliver rewrites", async () => {
    let deliveredMetadata: unknown;
    let deliveredAssistantMessageIndex: unknown;

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        deliveredMetadata = getReplyPayloadMetadata(payload);
        deliveredAssistantMessageIndex = info.assistantMessageIndex;
      },
      beforeDeliver: async () => ({ text: "rewritten" }),
    });

    dispatcher.sendBlockReply(
      setReplyPayloadMetadata({ text: "original" }, { assistantMessageIndex: 12 }),
    );
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(deliveredMetadata).toMatchObject({ assistantMessageIndex: 12 });
    expect(deliveredAssistantMessageIndex).toBe(12);
  });

  it("delivers normally without beforeDeliver", async () => {
    const delivered: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply({ text: "plain reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["plain reply"]);
  });

  it("records direct-delivery custody before waiting for the channel provider", async () => {
    const fixture = await makePendingFinalFixture();
    const enteredProvider = createDeferred();
    const releaseProvider = createDeferred();
    try {
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          enteredProvider.resolve();
          await releaseProvider.promise;
        },
      });

      dispatcher.sendFinalReply(fixture.payload);
      dispatcher.markComplete();
      await enteredProvider.promise;

      expect(
        (
          loadSessionEntry({
            sessionKey: fixture.sessionKey,
            storePath: fixture.storePath,
          }) as InternalSessionEntry
        )?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id: "delivery-1", state: "queued" }]);

      releaseProvider.resolve();
      await dispatcher.waitForIdle();
      expect(
        (
          loadSessionEntry({
            sessionKey: fixture.sessionKey,
            storePath: fixture.storePath,
          }) as InternalSessionEntry
        )?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id: "delivery-1", state: "delivered" }]);
    } finally {
      releaseProvider.resolve();
      await fs.rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it.each(
    [
      {
        label: "proven pre-send failure",
        error: () =>
          Object.assign(new Error("connect failed"), { code: "ECONNREFUSED", syscall: "connect" }),
        expected: "prepared",
        failedBeforeSend: true,
      },
      {
        label: "ambiguous provider failure",
        error: () => new Error("send outcome unknown"),
        expected: "unknown",
        failedBeforeSend: false,
      },
      {
        label: "queue-owned pre-send failure",
        error: () =>
          Object.assign(
            new OutboundDeliveryError("connect failed", {
              cause: Object.assign(new Error("connect failed"), {
                code: "ECONNREFUSED",
                syscall: "connect",
              }),
            }),
            { queueCustody: "held" },
          ),
        expected: "queued",
        failedBeforeSend: true,
      },
      {
        label: "queue-owned wrapped partial send",
        error: () =>
          createChannelPartialDeliveryError(
            Object.assign(
              new OutboundDeliveryError("remaining send failed", {
                cause: new Error("remaining send failed"),
                results: [{ channel: "matrix", messageId: "accepted-prefix" }],
              }),
              { queueCustody: "held" },
            ),
            { visibleReplySent: true, messageIds: ["accepted-prefix"] },
          ),
        expected: "queued",
        failedBeforeSend: false,
      },
    ].flatMap((entry) => [
      { ...entry, deferred: false },
      { ...entry, deferred: true },
    ]),
  )(
    "records $label before reporting the error (deferred=$deferred)",
    async ({ error, expected, failedBeforeSend, deferred }) => {
      const fixture = await makePendingFinalFixture();
      const failure = error();
      const onError = vi.fn();
      try {
        const deliver = vi.fn(async () => {
          if (deferred) {
            return { finalization: Promise.reject(failure) };
          }
          throw failure;
        });
        const dispatcher = createReplyDispatcher({ deliver, onError });
        const capture = captureReplyDispatchDeliveryOutcome(fixture.payload);
        const pending = expected !== "prepared";
        if (pending) {
          attachReplyDispatchUndeliveredFallback(fixture.payload, { text: "duplicate fallback" });
        }
        dispatcher.sendFinalReply(fixture.payload);
        dispatcher.markComplete();
        const receipt = await dispatcher.waitForIdle();
        await expect(capture.promise).resolves.toBe(
          !failedBeforeSend
            ? "failed-deliver"
            : pending
              ? "recovery-owned"
              : "failed-before-deliver",
        );
        expect(capture.hasPendingDelivery()).toBe(pending);
        expect(receipt?.hasPendingDelivery).toBe(pending ? true : undefined);
        expect(deliver).toHaveBeenCalledTimes(1);

        if (deferred) {
          expect(onError).not.toHaveBeenCalled();
        } else {
          expect(onError.mock.calls[0]?.[0]).toBe(failure);
        }
        expect(receipt?.counts.final).toMatchObject({
          failedBeforeSend: failedBeforeSend ? 1 : 0,
          failedAfterSend: failedBeforeSend ? 0 : 1,
        });

        expect(
          (
            loadSessionEntry({
              sessionKey: fixture.sessionKey,
              storePath: fixture.storePath,
            }) as InternalSessionEntry
          )?.pendingFinalDelivery?.deliveries,
        ).toEqual([{ id: "delivery-1", state: expected }]);
      } finally {
        await fs.rm(fixture.tmpDir, { recursive: true, force: true });
      }
    },
  );

  it("restores prepared custody when a pre-I/O admitted send proves no-send", async () => {
    const fixture = await makePendingFinalFixture();
    try {
      const dispatcher = createReplyDispatcher({
        deliver: async (payload) => {
          // Mirror the channel-turn direct path: custody escalates queued→unknown
          // immediately before wire I/O, then the provider proves no send happened.
          const custody = createDirectPendingFinalCustody(payload);
          await custody?.onPlatformSendDispatch();
          throw Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          });
        },
      });

      dispatcher.sendFinalReply(fixture.payload);
      dispatcher.markComplete();
      await dispatcher.waitForIdle();

      expect(
        (
          loadSessionEntry({
            sessionKey: fixture.sessionKey,
            storePath: fixture.storePath,
          }) as InternalSessionEntry
        )?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id: "delivery-1", state: "prepared" }]);
    } finally {
      await fs.rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it("suppresses a second direct call after the exact delivery is terminal", async () => {
    const fixture = await makePendingFinalFixture();
    const deliver = vi.fn(async () => {});
    try {
      const first = createReplyDispatcher({ deliver });
      first.sendFinalReply(fixture.payload);
      first.markComplete();
      await first.waitForIdle();

      const second = createReplyDispatcher({ deliver });
      second.sendFinalReply(fixture.payload);
      second.markComplete();
      const receipt = await second.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(receipt?.counts.final.cancelled).toBe(1);
    } finally {
      await fs.rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it("suppresses a direct call whose persisted owner was replaced", async () => {
    const fixture = await makePendingFinalFixture();
    const current = loadSessionEntry({
      sessionKey: fixture.sessionKey,
      storePath: fixture.storePath,
    }) as InternalSessionEntry;
    await replaceSessionEntry(
      { sessionKey: fixture.sessionKey, storePath: fixture.storePath },
      {
        ...current,
        pendingFinalDelivery: {
          ...current.pendingFinalDelivery!,
          intentId: "replacement-intent",
        },
      },
    );
    const deliver = vi.fn(async () => {});
    try {
      const dispatcher = createReplyDispatcher({ deliver });
      dispatcher.sendFinalReply(fixture.payload);
      dispatcher.markComplete();
      const receipt = await dispatcher.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      expect(receipt?.counts.final.cancelled).toBe(1);
    } finally {
      await fs.rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });

  it("records policy suppression before awaiting cancellation observers", async () => {
    const fixture = await makePendingFinalFixture();
    const observerStarted = createDeferred();
    const releaseObserver = createDeferred();
    try {
      const dispatcher = createReplyDispatcher({
        beforeDeliver: () => null,
        deliver: async () => {},
        onBeforeDeliverCancelled: async () => {
          observerStarted.resolve();
          await releaseObserver.promise;
        },
      });
      dispatcher.sendFinalReply(fixture.payload);
      dispatcher.markComplete();
      await observerStarted.promise;

      expect(
        (
          loadSessionEntry({
            sessionKey: fixture.sessionKey,
            storePath: fixture.storePath,
          }) as InternalSessionEntry
        )?.pendingFinalDelivery?.deliveries,
      ).toEqual([{ id: "delivery-1", state: "suppressed" }]);

      releaseObserver.resolve();
      await dispatcher.waitForIdle();
    } finally {
      releaseObserver.resolve();
      await fs.rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });
});
