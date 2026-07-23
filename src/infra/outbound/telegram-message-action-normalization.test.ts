import { describe, expect, it } from "vitest";
import { normalizeTelegramMessageActionRequest } from "./telegram-message-action-normalization.js";

const location = { latitude: 48.858844, longitude: 2.294351 };

function normalize(params: {
  channel?: string;
  action?: "send";
  args: Record<string, unknown>;
  origin?: "message-tool" | "direct";
}) {
  return normalizeTelegramMessageActionRequest({
    channel: params.channel ?? "telegram",
    action: params.action ?? "send",
    args: params.args,
    origin: params.origin ?? "message-tool",
  });
}

describe("Telegram message action normalization", () => {
  it.each([
    { name: "text", content: { message: "hello" } },
    { name: "image", content: { image: "https://example.test/photo.jpg" } },
    { name: "buffer", content: { buffer: "base64-data" } },
    { name: "attachment path", content: { attachments: [{ filePath: "/tmp/photo.png" }] } },
    {
      name: "attachment URL",
      content: { attachments: [{ mediaUrl: "https://example.test/photo.png" }] },
    },
  ])("removes incidental location from model-authored $name sends", ({ content }) => {
    expect(normalize({ args: { ...content, location } })).toEqual({
      action: "send",
      args: content,
    });
  });

  it.each([{ presentation: {} }, { interactive: {} }, { attachments: [{}] }, { mediaUrls: [] }])(
    "preserves location when the apparent content placeholder is empty",
    (placeholder) => {
      expect(normalize({ args: { ...placeholder, location } })).toEqual({
        action: "send",
        args: { ...placeholder, location },
      });
    },
  );

  it("preserves legacy location-only sends", () => {
    expect(normalize({ args: { location } })).toEqual({
      action: "send",
      args: { location },
    });
  });

  it("keeps direct mixed sends strict", () => {
    expect(normalize({ args: { message: "hello", location }, origin: "direct" })).toEqual({
      action: "send",
      args: { message: "hello", location },
    });
  });

  it("does not rewrite another channel", () => {
    expect(normalize({ channel: "slack", args: { message: "hello", location } })).toEqual({
      action: "send",
      args: { message: "hello", location },
    });
  });
});
