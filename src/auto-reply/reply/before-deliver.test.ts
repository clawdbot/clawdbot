// Tests before-deliver hook ordering and payload mutation behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createDirectPendingFinalCustody } from "../../channels/turn/direct-delivery-custody.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  appendReplyDispatcherBeforeDeliverCancelled,
  attachReplyDispatchUndeliveredFallback,
  captureReplyDispatchDeliveryOutcome,
  createReplyDispatcher,
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
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    await expect(outcome.promise).resolves.toBe("delivered");
    expect(dispatcher.getCancelledCounts?.().final).toBe(0);
  });

  it("delivers the fallback when primary normalization is cancelled", async () => {
    const delivered: ReplyPayload[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      transformReplyPayload: (payload) => (payload.mediaUrl ? null : payload),
      deliver: async (payload) => {
        delivered.push(payload);
      },
    });

    expect(dispatcher.sendFinalReply(primary)).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([{ text: "caption" }]);
  });

  it("delivers the attached fallback after a proven pre-transport failure", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        if (payload.mediaUrl) {
          throw Object.assign(new Error("connect failed"), {
            code: "ECONNREFUSED",
            syscall: "connect",
          });
        }
        delivered.push(payload.text ?? "");
      },
    });

    dispatcher.sendFinalReply(primary);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    expect(dispatcher.getFailedCounts().final).toBe(0);
  });

  it("does not duplicate text after an ambiguous transport failure", async () => {
    const delivered: string[] = [];
    const primary: ReplyPayload = { text: "caption", mediaUrl: "/tmp/voice.ogg" };
    attachReplyDispatchUndeliveredFallback(primary, { text: "caption" });
    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
        throw new Error("send outcome unknown");
      },
    });

    dispatcher.sendFinalReply(primary);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["caption"]);
    expect(dispatcher.getFailedCounts().final).toBe(1);
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
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
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
    await dispatcher.waitForIdle();

    expect(delivered).toEqual(["safe reply"]);
    expect(cancelled).toEqual(["blocked reply"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 2 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
  });

  it("notifies appended cancellation observers when beforeDeliver returns null", async () => {
    const delivered: string[] = [];
    const cancelled: string[] = [];
    const errors: string[] = [];

    const dispatcher = createReplyDispatcher({
      deliver: async (payload) => {
        delivered.push(payload.text ?? "");
      },
      beforeDeliver: () => null,
      onBeforeDeliverCancelled: (payload) => {
        cancelled.push(`constructed:${payload.text ?? ""}`);
      },
      onError: (err) => {
        errors.push(err instanceof Error ? err.message : String(err));
      },
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, (payload) => {
      cancelled.push(`appended-a:${payload.text ?? ""}`);
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, () => {
      throw new Error("observer failed");
    });
    appendReplyDispatcherBeforeDeliverCancelled(dispatcher, (payload) => {
      cancelled.push(`appended-b:${payload.text ?? ""}`);
    });

    dispatcher.sendFinalReply({ text: "blocked reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([
      "constructed:blocked reply",
      "appended-a:blocked reply",
      "appended-b:blocked reply",
    ]);
    expect(errors).toEqual(["observer failed"]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 1 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
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
    await dispatcher.waitForIdle();

    expect(delivered).toEqual([]);
    expect(cancelled).toEqual([{ assistantMessageIndex: 9, kind: "block", text: "blocked block" }]);
    expect(errors).toEqual([
      { assistantMessageIndex: 9, kind: "block", message: "pre-delivery failed" },
    ]);
    expect(dispatcher.getQueuedCounts()).toEqual({ tool: 0, block: 1, final: 0 });
    expect(dispatcher.getCancelledCounts?.()).toEqual({ tool: 0, block: 0, final: 0 });
    expect(dispatcher.getFailedCounts?.()).toEqual({ tool: 0, block: 1, final: 0 });
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

  it.each([
    {
      label: "proven pre-send failure",
      error: () =>
        Object.assign(new Error("connect failed"), { code: "ECONNREFUSED", syscall: "connect" }),
      expected: "prepared",
    },
    {
      label: "ambiguous provider failure",
      error: () => new Error("send outcome unknown"),
      expected: "unknown",
    },
  ] as const)("records $label before reporting the error", async ({ error, expected }) => {
    const fixture = await makePendingFinalFixture();
    try {
      const dispatcher = createReplyDispatcher({
        deliver: async () => {
          throw error();
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
      ).toEqual([{ id: "delivery-1", state: expected }]);
    } finally {
      await fs.rm(fixture.tmpDir, { recursive: true, force: true });
    }
  });

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
      await second.waitForIdle();

      expect(deliver).toHaveBeenCalledOnce();
      expect(second.getCancelledCounts?.().final).toBe(1);
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
      await dispatcher.waitForIdle();

      expect(deliver).not.toHaveBeenCalled();
      expect(dispatcher.getCancelledCounts?.().final).toBe(1);
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
