import { describe, expect, it } from "vitest";

import {
  buildSlackSlashCommandMatcher,
  isSlackRoomAllowedByPolicy,
  resolveSlackThreadTs,
} from "./monitor.js";

describe("slack groupPolicy gating", () => {
  it("allows when policy is open", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "open",
        channelAllowlistConfigured: false,
        channelAllowed: false,
      }),
    ).toBe(true);
  });

  it("blocks when policy is disabled", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "disabled",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("blocks allowlist when no channel allowlist configured", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: false,
        channelAllowed: true,
      }),
    ).toBe(false);
  });

  it("allows allowlist when channel is allowed", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: true,
      }),
    ).toBe(true);
  });

  it("blocks allowlist when channel is not allowed", () => {
    expect(
      isSlackRoomAllowedByPolicy({
        groupPolicy: "allowlist",
        channelAllowlistConfigured: true,
        channelAllowed: false,
      }),
    ).toBe(false);
  });
});

describe("resolveSlackThreadTs", () => {
  const threadTs = "1234567890.123456";
  const messageTs = "9999999999.999999";

  describe("replyToMode=off", () => {
    it("returns incomingThreadTs when in a thread", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "off",
          incomingThreadTs: threadTs,
          messageTs,
          hasReplied: false,
        }),
      ).toBe(threadTs);
    });

    it("returns incomingThreadTs even after replies (stays in thread)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "off",
          incomingThreadTs: threadTs,
          messageTs,
          hasReplied: true,
        }),
      ).toBe(threadTs);
    });

    it("returns undefined when not in a thread", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "off",
          incomingThreadTs: undefined,
          messageTs,
          hasReplied: false,
        }),
      ).toBeUndefined();
    });
  });

  describe("replyToMode=first", () => {
    it("returns incomingThreadTs when in a thread (always stays threaded)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "first",
          incomingThreadTs: threadTs,
          messageTs,
          hasReplied: false,
        }),
      ).toBe(threadTs);
    });

    it("returns messageTs for first reply when not in a thread", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "first",
          incomingThreadTs: undefined,
          messageTs,
          hasReplied: false,
        }),
      ).toBe(messageTs);
    });

    it("returns undefined for subsequent replies when not in a thread (goes to main channel)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "first",
          incomingThreadTs: undefined,
          messageTs,
          hasReplied: true,
        }),
      ).toBeUndefined();
    });
  });

  describe("replyToMode=all", () => {
    it("returns incomingThreadTs when in a thread", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "all",
          incomingThreadTs: threadTs,
          messageTs,
          hasReplied: false,
        }),
      ).toBe(threadTs);
    });

    it("returns messageTs when not in a thread (starts thread)", () => {
      expect(
        resolveSlackThreadTs({
          replyToMode: "all",
          incomingThreadTs: undefined,
          messageTs,
          hasReplied: true,
        }),
      ).toBe(messageTs);
    });
  });
});

describe("buildSlackSlashCommandMatcher", () => {
  it("matches with or without a leading slash", () => {
    const matcher = buildSlackSlashCommandMatcher("clawd");

    expect(matcher.test("clawd")).toBe(true);
    expect(matcher.test("/clawd")).toBe(true);
  });

  it("does not match similar names", () => {
    const matcher = buildSlackSlashCommandMatcher("clawd");

    expect(matcher.test("/clawd-bot")).toBe(false);
    expect(matcher.test("clawd-bot")).toBe(false);
  });
});
