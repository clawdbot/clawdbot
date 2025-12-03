import { describe, expect, it, vi } from "vitest";

import type { WarelayConfig } from "../config/config.js";
import { autoReplyIfConfigured } from "./reply.js";

describe("autoReplyIfConfigured chunking", () => {
  it("sends a single Twilio message for multi-line text under limit", async () => {
    const body = [
      "Oh! Hi Peter! 🦞",
      "",
      "Sorry, I got a bit trigger-happy with the heartbeat response there. What's up?",
      "",
      "Everything working on your end?",
    ].join("\n");

    const config: WarelayConfig = {
      inbound: {
        reply: {
          mode: "text",
          text: body,
        },
      },
    };

    const create = vi.fn().mockResolvedValue({});
    const client = { messages: { create } } as unknown as Parameters<
      typeof autoReplyIfConfigured
    >[0];

    const message = {
      body: "ping",
      from: "+15551234567",
      to: "+15557654321",
      sid: "SM123",
    } as Parameters<typeof autoReplyIfConfigured>[1];

    await autoReplyIfConfigured(client, message, config);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        body,
        from: message.to,
        to: message.from,
      }),
    );
  });
});
