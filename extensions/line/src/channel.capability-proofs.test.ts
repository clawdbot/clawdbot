// Line tests cover declared message adapter capability contracts.
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { linePlugin } from "./channel.js";
import { createLineDurablePushRecorder } from "./durable-send-plan.js";
import { createRuntime } from "./outbound-harness.test-support.js";
import { setLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";
import { resolveLinePushRetryKey } from "./send-retry.js";

function lineReceipt(messageId: string) {
  return createLineSendReceipt({ messageId, chatId: "c1", kind: "text" });
}

const CFG = { channels: { line: {} } } as OpenClawConfig;

describe("line message adapter capability contracts", () => {
  beforeEach(() => {
    vi.setSystemTime(1_800_000_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("proves every declared durable final capability", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "line",
      adapter: linePlugin.message!,
      proofs: {
        text: async () => {
          const result = await linePlugin.message?.send?.text?.({
            cfg: CFG,
            to: "line:user:U123",
            text: "hello",
            accountId: "primary",
          });
          expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:user:U123", "hello", {
            verbose: false,
            accountId: "primary",
            cfg: CFG,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["m-text"]);
        },
        media: async () => {
          const result = await linePlugin.message?.send?.media?.({
            cfg: CFG,
            to: "line:user:U123",
            text: "image",
            mediaUrl: "https://example.com/image.jpg",
            accountId: "primary",
          });
          expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:U123", "", {
            verbose: false,
            mediaUrl: "https://example.com/image.jpg",
            accountId: "primary",
            cfg: CFG,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["m-media"]);
        },
        payload: async () => {
          // A LINE-specific payload fans out into several platform sends, and each
          // one carries its own durable key so a replay resolves them push by push.
          const result = await linePlugin.message?.send?.payload?.({
            cfg: CFG,
            to: "line:user:U123",
            text: "pick one",
            payload: { text: "pick one", channelData: { line: { quickReplies: ["One", "Two"] } } },
            accountId: "primary",
            deliveryQueueId: "queue-payload",
            deliveryPartIndex: 0,
            deliveryPartCount: 1,
          });
          expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
            "line:user:U123",
            "pick one",
            ["One", "Two"],
            expect.objectContaining({
              durableSend: { deliveryQueueId: "queue-payload", partIndex: 0, pushIndex: 0 },
            }),
          );
          expect(result?.receipt.platformMessageIds).toEqual(["m-quick"]);
        },
        messageSendingHooks: () => {
          expect(linePlugin.message?.send?.text).toBeTypeOf("function");
        },
        reconcileUnknownSend: async () => {
          const now = Date.now();
          const retryKey = resolveLinePushRetryKey({
            deliveryQueueId: "queue-entry-1",
            partIndex: 0,
            pushIndex: 0,
          });
          const messages = [{ type: "text" as const, text: "hello" }];
          const recorder = createLineDurablePushRecorder({
            queueId: "queue-entry-1",
            partIndex: 0,
            partCount: 1,
            to: "line:user:U123",
            payload: { text: "hello" },
          });
          await recorder.recordPush({ retryKey, messages });

          const reconciliation = await linePlugin.message?.durableFinal?.reconcileUnknownSend?.({
            cfg: CFG,
            queueId: "queue-entry-1",
            channel: "line",
            to: "line:user:U123",
            accountId: "primary",
            enqueuedAt: now,
            platformSendStartedAt: now,
            retryCount: 1,
            payloads: [{ text: "hello" }],
          });
          // The replay re-enters the recorded part's fan-out under that part's
          // durable identity, which is what regenerates the key LINE 409s on.
          expect(mocks.pushMessageLine).toHaveBeenCalledWith(
            "line:user:U123",
            "hello",
            expect.objectContaining({
              durableSend: { deliveryQueueId: "queue-entry-1", partIndex: 0, pushIndex: 0 },
            }),
          );
          expect(reconciliation).toMatchObject({ status: "sent", messageId: "m-text" });
        },
        afterCommit: async () => {
          const otherDeliveries = mocks.blobs.size;
          const recorder = createLineDurablePushRecorder({
            queueId: "queue-commit",
            partIndex: 0,
            partCount: 1,
            to: "line:user:U123",
            payload: { text: "hello" },
          });
          await recorder.recordPush({
            retryKey: "8ac8b1bc-98a6-4f0e-9f2f-0a3f5d0a6e11",
            messages: [{ type: "text", text: "hello" }],
          });
          expect(mocks.blobs.size).toBe(otherDeliveries + 1);

          await linePlugin.message?.send?.lifecycle?.afterCommit?.({
            kind: "text",
            cfg: CFG,
            to: "line:user:U123",
            text: "hello",
            deliveryQueueId: "queue-commit",
            result: { messageId: "m-text", receipt: lineReceipt("m-text") },
          });

          // A committed delivery can never be replayed, so its recorded requests
          // go, and only its own: other deliveries stay replayable.
          expect(mocks.blobs.size).toBe(otherDeliveries);
        },
      },
    });

    for (const capability of [
      "text",
      "media",
      "payload",
      "messageSendingHooks",
      "reconcileUnknownSend",
      "afterCommit",
    ]) {
      expect(proofResults.find((result) => result.capability === capability)?.status).toBe(
        "verified",
      );
    }
  });

  it("declares receive ack policies for immediate LINE webhook acknowledgement", async () => {
    const proofResults = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "line",
      adapter: linePlugin.message!,
      proofs: {
        after_receive_record: () => {
          expect(linePlugin.message?.receive?.defaultAckPolicy).toBe("after_receive_record");
          expect(linePlugin.message?.receive?.supportedAckPolicies).toContain(
            "after_receive_record",
          );
        },
      },
    });

    expect(proofResults.find((result) => result.policy === "after_receive_record")?.status).toBe(
      "verified",
    );
    expect(proofResults.find((result) => result.policy === "after_agent_dispatch")?.status).toBe(
      "not_declared",
    );
  });
});
