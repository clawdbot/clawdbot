import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFollowupDeliveryPayloads } from "./followup-delivery.js";

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: () => undefined,
}));

const baseConfig = {} as OpenClawConfig;

describe("resolveFollowupDeliveryPayloads", () => {
  it("drops heartbeat ack payloads without media", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK" }],
      }),
    ).toEqual([]);
  });

  it("keeps media payloads when stripping heartbeat ack text", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "HEARTBEAT_OK", mediaUrl: "/tmp/image.png" }],
      }),
    ).toEqual([{ text: "", mediaUrl: "/tmp/image.png" }]);
  });

  it("drops text payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        sentTexts: ["hello world!"],
      }),
    ).toEqual([]);
  });

  it("drops media payloads already sent via messaging tool", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ mediaUrl: "/tmp/img.png" }],
        sentMediaUrls: ["/tmp/img.png"],
      }),
    ).toEqual([{ mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("does not dedupe text sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("does not dedupe media sent via messaging tool to another target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "telegram",
        originatingTo: "telegram:123",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("dedupes final text only against message-tool text sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "discord-only text" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["slack text", "discord-only text"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            text: "discord-only text",
          },
        ],
      }),
    ).toEqual([{ text: "discord-only text" }]);
  });

  it("falls back to global text dedupe for legacy multi-target messaging telemetry", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toEqual([]);
  });

  it("dedupes final media only against message-tool media sent to the same route", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/slack-photo.jpg", "file:///tmp/discord-photo.jpg"],
        sentTargets: [
          {
            tool: "slack",
            provider: "slack",
            to: "channel:C1",
            mediaUrls: ["file:///tmp/slack-photo.jpg"],
          },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            mediaUrls: ["file:///tmp/discord-photo.jpg"],
          },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }]);
  });

  it("falls back to global media dedupe for legacy multi-target messaging telemetry", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentMediaUrls: ["file:///tmp/photo.jpg"],
        sentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toEqual([{ text: "photo", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("delivers distinct replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });

  it("dedupes duplicate replies when a messaging tool already sent to the same provider and target", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "slack",
        originatingTo: "channel:C1",
        sentTexts: ["hello world!"],
        sentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1", text: "hello world!" }],
      }),
    ).toEqual([]);
  });

  it("delivers distinct replies when originating channel resolves the provider", () => {
    expect(
      resolveFollowupDeliveryPayloads({
        cfg: baseConfig,
        payloads: [{ text: "hello world!" }],
        messageProvider: "heartbeat",
        originatingChannel: "telegram",
        originatingTo: "268300329",
        sentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
      }),
    ).toEqual([{ text: "hello world!" }]);
  });
});
