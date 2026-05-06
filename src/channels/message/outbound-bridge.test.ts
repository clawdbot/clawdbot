import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelMessageAdapterFromOutbound } from "./outbound-bridge.js";
import type { MessageReceipt } from "./types.js";

const cfg = {} as OpenClawConfig;

describe("createChannelMessageAdapterFromOutbound", () => {
  it("wraps outbound text sends with a message receipt", async () => {
    const sendText = vi.fn(async () => ({ channel: "demo", messageId: "msg-1" }));
    const adapter = createChannelMessageAdapterFromOutbound({
      id: "demo",
      outbound: {
        deliveryCapabilities: { durableFinal: { text: true, replyTo: true } },
        sendText,
      },
    });

    const result = await adapter.send?.text?.({
      cfg,
      to: "room-1",
      text: "hello",
      replyToId: "parent-1",
      threadId: "thread-1",
    });

    expect(adapter).toEqual(
      expect.objectContaining({
        id: "demo",
        durableFinal: { capabilities: { text: true, replyTo: true } },
      }),
    );
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "room-1",
        text: "hello",
        replyToId: "parent-1",
        threadId: "thread-1",
      }),
    );
    expect(result).toEqual({
      messageId: "msg-1",
      receipt: expect.objectContaining({
        primaryPlatformMessageId: "msg-1",
        platformMessageIds: ["msg-1"],
        threadId: "thread-1",
        replyToId: "parent-1",
        parts: [
          expect.objectContaining({
            platformMessageId: "msg-1",
            kind: "text",
            threadId: "thread-1",
            replyToId: "parent-1",
          }),
        ],
      }),
    });
  });

  it("preserves an outbound receipt instead of rebuilding it", async () => {
    const receipt: MessageReceipt = {
      primaryPlatformMessageId: "receipt-1",
      platformMessageIds: ["receipt-1", "receipt-2"],
      parts: [
        { platformMessageId: "receipt-1", kind: "media", index: 0 },
        { platformMessageId: "receipt-2", kind: "media", index: 1 },
      ],
      sentAt: 123,
    };
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        deliveryCapabilities: { durableFinal: { media: true } },
        sendMedia: vi.fn(async () => ({ channel: "demo", messageId: "legacy-id", receipt })),
      },
    });

    await expect(
      adapter.send?.media?.({
        cfg,
        to: "room-1",
        text: "caption",
        mediaUrl: "file:///tmp/a.png",
      }),
    ).resolves.toEqual({ messageId: "legacy-id", receipt });
  });

  it("wraps rich payload sends and infers the receipt part kind", async () => {
    const sendPayload = vi.fn(async () => ({ channel: "demo", messageId: "card-1" }));
    const adapter = createChannelMessageAdapterFromOutbound({
      capabilities: { payload: true, batch: true },
      outbound: { sendPayload },
    });

    const result = await adapter.send?.payload?.({
      cfg,
      to: "room-1",
      text: "",
      payload: {
        presentation: { blocks: [{ type: "text", text: "ready" }] },
      },
    });

    expect(adapter.durableFinal?.capabilities).toEqual({ payload: true, batch: true });
    expect(sendPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          presentation: { blocks: [{ type: "text", text: "ready" }] },
        },
      }),
    );
    expect(result?.receipt.parts[0]).toEqual(
      expect.objectContaining({ platformMessageId: "card-1", kind: "card" }),
    );
  });

  it("exposes only send methods backed by outbound handlers", () => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: vi.fn(async () => ({ messageId: "msg-1" })),
      },
    });

    expect(adapter.send?.text).toEqual(expect.any(Function));
    expect(adapter.send?.media).toBeUndefined();
    expect(adapter.send?.payload).toBeUndefined();
  });

  it("defaults outbound-derived adapters to plugin-owned receive acknowledgements", () => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {
        sendText: vi.fn(async () => ({ messageId: "msg-1" })),
      },
    });

    expect(adapter.receive).toEqual({
      defaultAckPolicy: "manual",
      supportedAckPolicies: ["manual"],
    });
  });

  it("preserves declared live and receive lifecycle metadata", () => {
    const adapter = createChannelMessageAdapterFromOutbound({
      outbound: {},
      live: {
        capabilities: {
          draftPreview: true,
          previewFinalization: true,
        },
      },
      receive: {
        defaultAckPolicy: "after_agent_dispatch",
        supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
      },
    });

    expect(adapter.live).toEqual({
      capabilities: {
        draftPreview: true,
        previewFinalization: true,
      },
    });
    expect(adapter.receive).toEqual({
      defaultAckPolicy: "after_agent_dispatch",
      supportedAckPolicies: ["after_receive_record", "after_agent_dispatch"],
    });
  });
});
