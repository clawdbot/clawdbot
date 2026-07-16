/** Tests inbound envelope formatting, timestamps, and sender labels. */
import { describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import {
  formatAgentEnvelope,
  formatEnvelopeTimestamp,
  formatInboundEnvelope,
  resolveEnvelopeFormatOptions,
} from "./envelope.js";

describe("formatAgentEnvelope", () => {
  it("includes channel, from, ip, host, and timestamp", () => {
    withEnv({ TZ: "UTC" }, () => {
      const ts = Date.UTC(2025, 0, 2, 3, 4, 5); // 2025-01-02T03:04:05Z
      const body = formatAgentEnvelope({
        channel: "WebChat",
        from: "user1",
        host: "mac-mini",
        ip: "10.0.0.5",
        timestamp: ts,
        envelope: { timezone: "utc" },
        body: "hello",
      });

      expect(body).toBe("[WebChat user1 mac-mini 10.0.0.5 Thu 2025-01-02T03:04:05Z] hello");
    });
  });

  it("formats timestamps in local timezone by default", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4);
    const expectedTimestamp = formatEnvelopeTimestamp(ts, { timezone: "local" });
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      body: "hello",
    });

    expect(body).toBe(`[WebChat ${expectedTimestamp}] hello`);
  });

  it("formats timestamps in UTC when configured", () => {
    withEnv({ TZ: "America/Los_Angeles" }, () => {
      const ts = Date.UTC(2025, 0, 2, 3, 4, 5); // 2025-01-02T03:04:05Z (19:04:05 PST)
      const body = formatAgentEnvelope({
        channel: "WebChat",
        timestamp: ts,
        envelope: { timezone: "utc" },
        body: "hello",
      });

      expect(body).toBe("[WebChat Thu 2025-01-02T03:04:05Z] hello");
    });
  });

  it("formats timestamps in user timezone when configured", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4, 5); // 2025-01-02T03:04:05Z (04:04:05 CET)
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      envelope: { timezone: "user", userTimezone: "Europe/Vienna" },
      body: "hello",
    });

    expect(body).toMatch(/\[WebChat Thu 2025-01-02 04:04:05 [^\]]+\] hello/);
  });

  it("omits timestamps when configured", () => {
    const ts = Date.UTC(2025, 0, 2, 3, 4);
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: ts,
      envelope: { includeTimestamp: false },
      body: "hello",
    });
    expect(body).toBe("[WebChat] hello");
  });

  it("handles missing optional fields", () => {
    const body = formatAgentEnvelope({ channel: "Telegram", body: "hi" });
    expect(body).toBe("[Telegram] hi");
  });

  it("formats the Unix epoch timestamp", () => {
    const body = formatAgentEnvelope({
      channel: "WebChat",
      timestamp: 0,
      envelope: { timezone: "utc" },
      body: "hello",
    });
    expect(body).toBe("[WebChat Thu 1970-01-01T00:00:00Z] hello");
  });
});

describe("formatInboundEnvelope", () => {
  it("prefixes sender for non-direct chats", () => {
    const body = formatInboundEnvelope({
      channel: "Discord",
      from: "Guild #general",
      body: "hi",
      chatType: "channel",
      senderLabel: "Alice",
    });
    expect(body).toBe("[Discord Guild #general] Alice: hi");
  });

  it("uses sender fields when senderLabel is missing", () => {
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: "Signal Group id:123",
      body: "ping",
      chatType: "group",
      sender: { name: "Bob", id: "42" },
    });
    expect(body).toBe("[Signal Signal Group id:123] Bob (42): ping");
  });

  it("prefixes direct messages with the header sender", () => {
    const body = formatInboundEnvelope({
      channel: "iMessage",
      from: "+1555",
      body: "hello",
      chatType: "direct",
      senderLabel: "Alice",
    });
    expect(body).toBe("[iMessage +1555] +1555: hello");
  });

  it("uses display text for direct body prefixes when from includes an id", () => {
    const body = formatInboundEnvelope({
      channel: "Telegram",
      from: "Alice id:123",
      body: "hello",
      chatType: "direct",
    });
    expect(body).toBe("[Telegram Alice id:123] Alice: hello");
  });

  it("uses a stable direct body prefix when id display text contains a colon", () => {
    const body = formatInboundEnvelope({
      channel: "Telegram",
      from: "Ops: Alice id:123",
      body: "/status",
      chatType: "direct",
    });
    expect(body).toBe("[Telegram Ops: Alice id:123] (sender): /status");
  });

  it("uses a stable direct body prefix when from is an opaque id label", () => {
    const body = formatInboundEnvelope({
      channel: "LINE",
      from: "user:U123",
      body: "hello",
      chatType: "direct",
    });
    expect(body).toBe("[LINE user:U123] (sender): hello");
  });

  it("includes elapsed time when previousTimestamp is provided", () => {
    const now = Date.now();
    const twoMinutesAgo = now - 2 * 60 * 1000;
    const body = formatInboundEnvelope({
      channel: "Telegram",
      from: "Alice",
      body: "follow-up message",
      timestamp: now,
      previousTimestamp: twoMinutesAgo,
      chatType: "direct",
      envelope: { includeTimestamp: false },
    });
    expect(body).toContain("Alice +2m");
    expect(body).toContain("follow-up message");
  });

  it("omits elapsed time when disabled", () => {
    const now = Date.now();
    const body = formatInboundEnvelope({
      channel: "Telegram",
      from: "Alice",
      body: "follow-up message",
      timestamp: now,
      previousTimestamp: now - 2 * 60 * 1000,
      chatType: "direct",
      envelope: { includeElapsed: false, includeTimestamp: false },
    });
    expect(body).toBe("[Telegram Alice] Alice: follow-up message");
  });

  it("prefixes DM body with (self) when fromMe is true", () => {
    const body = formatInboundEnvelope({
      channel: "WhatsApp",
      from: "+1555",
      body: "outbound msg",
      chatType: "direct",
      fromMe: true,
    });
    expect(body).toBe("[WhatsApp +1555] (self): outbound msg");
  });

  it("does not prefix group messages with (self) when fromMe is true", () => {
    const body = formatInboundEnvelope({
      channel: "WhatsApp",
      from: "Family Chat",
      body: "hello",
      chatType: "group",
      senderLabel: "Alice",
      fromMe: true,
    });
    expect(body).toBe("[WhatsApp Family Chat] Alice: hello");
  });

  it("resolves envelope options from config", () => {
    const options = resolveEnvelopeFormatOptions({
      agents: {
        defaults: {
          envelopeTimezone: "user",
          envelopeTimestamp: "off",
          envelopeElapsed: "off",
          userTimezone: "Europe/Vienna",
        },
      },
    });
    expect(options).toEqual({
      timezone: "user",
      includeTimestamp: false,
      includeElapsed: false,
      userTimezone: "Europe/Vienna",
    });
  });
});
