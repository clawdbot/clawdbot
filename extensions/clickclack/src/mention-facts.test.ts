import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveClickClackMentionFacts } from "./mention-facts.js";

describe("resolveClickClackMentionFacts", () => {
  it("direct message: canDetectMention: false, wasMentioned: false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: true,
      body: "hello",
      mentionPatterns: ["@bot"],
    });
    expect(result.canDetectMention).toBe(false);
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBeUndefined();
  });

  it("group message with no body: canDetectMention true, wasMentioned false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "",
      mentionPatterns: [],
    });
    expect(result.canDetectMention).toBe(true);
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });

  it("group message without patterns: wasMentioned false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hello everyone",
      mentionPatterns: [],
    });
    expect(result.canDetectMention).toBe(true);
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });

  it("matches configured pattern", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hey @bot help me",
      mentionPatterns: ["@bot"],
    });
    expect(result.wasMentioned).toBe(true);
    expect(result.hasAnyMention).toBe(true);
  });

  it("matches the ClickClack bot handle emitted by the composer", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hey @blackbird check this",
      mentionPatterns: [],
      botHandle: "blackbird",
    });
    expect(result.wasMentioned).toBe(true);
    expect(result.hasAnyMention).toBe(true);
  });

  it("matches the configured bot handle case-insensitively", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "@BlackBird hello",
      mentionPatterns: [],
      botHandle: "@blackbird",
    });
    expect(result.wasMentioned).toBe(true);
    expect(result.hasAnyMention).toBe(true);
  });

  it("tracks another user's handle separately from the bot handle", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "/status @alice",
      mentionPatterns: [],
      botHandle: "blackbird",
    });
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(true);
  });

  it("does not treat email addresses as ClickClack mentions", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "email alice@example.com",
      mentionPatterns: [],
      botHandle: "example",
    });
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });

  it("plain display name does not count unless configured as a pattern", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "Blackbird can you help?",
      mentionPatterns: [],
      botHandle: "blackbird",
    });
    expect(result.wasMentioned).toBe(false);
  });

  it("rejects unsafe configured regexes without evaluating them", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: `${"a".repeat(20_000)}!`,
      mentionPatterns: ["(a+)+$"],
    });
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });

  it("matches shared routed-agent mention patterns", () => {
    const cfg = {
      agents: {
        entries: {
          "service-bot": {
            groupChat: {
              mentionPatterns: ["@service"],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "hey @service please help",
      mentionPatterns: [],
      cfg,
      agentId: "service-bot",
      channelId: "chn_123",
    });
    expect(result.wasMentioned).toBe(true);
    expect(result.hasAnyMention).toBe(true);
  });

  it("non-matching pattern returns wasMentioned false", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "just a message",
      mentionPatterns: ["@bot", "@assistant"],
    });
    expect(result.wasMentioned).toBe(false);
  });

  it("multiple patterns: matches one pattern", () => {
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: "@firstbot please",
      mentionPatterns: ["@firstbot", "@secondbot"],
    });
    expect(result.wasMentioned).toBe(true);
  });
  it("rejects unsafe patterns from shared config without evaluating them", () => {
    const cfg = {
      messages: {
        groupChat: {
          mentionPatterns: ["(a+)+$"],
        },
      },
    } as unknown as OpenClawConfig;
    const result = resolveClickClackMentionFacts({
      isDirect: false,
      body: `${"a".repeat(20_000)}!`,
      mentionPatterns: [],
      cfg,
      channelId: "chn_123",
    });
    expect(result.wasMentioned).toBe(false);
    expect(result.hasAnyMention).toBe(false);
  });
});
