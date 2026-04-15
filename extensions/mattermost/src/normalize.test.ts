import { describe, expect, it } from "vitest";
import { looksLikeMattermostTargetId, normalizeMattermostMessagingTarget } from "./normalize.js";

describe("normalizeMattermostMessagingTarget", () => {
  it("returns undefined for empty input", () => {
    expect(normalizeMattermostMessagingTarget("")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("  ")).toBeUndefined();
  });

  it("normalizes channel: prefix", () => {
    expect(normalizeMattermostMessagingTarget("channel:abc123")).toBe("channel:abc123");
    expect(normalizeMattermostMessagingTarget("Channel:ABC")).toBe("channel:ABC");
  });

  it("normalizes group: prefix to channel:", () => {
    expect(normalizeMattermostMessagingTarget("group:abc123")).toBe("channel:abc123");
  });

  it("normalizes user: prefix", () => {
    expect(normalizeMattermostMessagingTarget("user:abc123")).toBe("user:abc123");
  });

  it("normalizes mattermost: prefix to user:", () => {
    expect(normalizeMattermostMessagingTarget("mattermost:abc123")).toBe("user:abc123");
  });

  it("keeps @username targets", () => {
    expect(normalizeMattermostMessagingTarget("@alice")).toBe("@alice");
    expect(normalizeMattermostMessagingTarget("@Alice")).toBe("@Alice");
  });

  it("returns undefined for #channel (triggers directory lookup)", () => {
    expect(normalizeMattermostMessagingTarget("#bookmarks")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("#off-topic")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("# ")).toBeUndefined();
  });

  it("returns undefined for bare names (triggers directory lookup)", () => {
    expect(normalizeMattermostMessagingTarget("bookmarks")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("off-topic")).toBeUndefined();
  });

  it("returns undefined for empty prefixed values", () => {
    expect(normalizeMattermostMessagingTarget("channel:")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("user:")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("@")).toBeUndefined();
    expect(normalizeMattermostMessagingTarget("#")).toBeUndefined();
  });
});

describe("looksLikeMattermostTargetId", () => {
  it("returns false for empty input", () => {
    expect(looksLikeMattermostTargetId("")).toBe(false);
    expect(looksLikeMattermostTargetId("  ")).toBe(false);
  });

  it("recognizes prefixed targets", () => {
    expect(looksLikeMattermostTargetId("channel:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("Channel:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("user:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("group:abc")).toBe(true);
    expect(looksLikeMattermostTargetId("mattermost:abc")).toBe(true);
  });

  it("recognizes @username", () => {
    expect(looksLikeMattermostTargetId("@alice")).toBe(true);
  });

  it("does NOT recognize #channel (should go to directory)", () => {
    expect(looksLikeMattermostTargetId("#bookmarks")).toBe(false);
    expect(looksLikeMattermostTargetId("#off-topic")).toBe(false);
  });

  it("recognizes 26-char alphanumeric Mattermost IDs", () => {
    expect(looksLikeMattermostTargetId("abcdefghijklmnopqrstuvwxyz")).toBe(true);
    expect(looksLikeMattermostTargetId("12345678901234567890123456")).toBe(true);
    expect(looksLikeMattermostTargetId("AbCdEf1234567890abcdef1234")).toBe(true); // pragma: allowlist secret
  });

  it("recognizes DM channel format (26__26)", () => {
    expect(
      looksLikeMattermostTargetId("abcdefghijklmnopqrstuvwxyz__12345678901234567890123456"), // pragma: allowlist secret
    ).toBe(true);
  });

  it("rejects short strings that are not Mattermost IDs", () => {
    expect(looksLikeMattermostTargetId("password")).toBe(false);
    expect(looksLikeMattermostTargetId("hi")).toBe(false);
    expect(looksLikeMattermostTargetId("bookmarks")).toBe(false);
    expect(looksLikeMattermostTargetId("off-topic")).toBe(false);
  });

  it("rejects strings longer than 26 chars that are not DM format", () => {
    expect(looksLikeMattermostTargetId("abcdefghijklmnopqrstuvwxyz1")).toBe(false); // pragma: allowlist secret
  });
});
