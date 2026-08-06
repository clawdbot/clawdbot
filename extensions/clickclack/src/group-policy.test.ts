import { describe, expect, it } from "vitest";
import { resolveClickClackGroupPolicy } from "./group-policy.js";

describe("resolveClickClackGroupPolicy", () => {
  it("returns requireMention: false when no policy is configured", () => {
    const result = resolveClickClackGroupPolicy({
      account: {},
      channelId: "chn_unknown",
    });
    expect(result.requireMention).toBe(false);
    expect(result.mentionPatterns).toEqual([]);
  });

  it("applies account-level requireMention", () => {
    const result = resolveClickClackGroupPolicy({
      account: { requireMention: true },
      channelId: "chn_some",
    });
    expect(result.requireMention).toBe(true);
  });

  it("groups['*'] overrides account default", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: false,
        groups: { "*": { requireMention: true } },
      },
      channelId: "chn_any",
    });
    expect(result.requireMention).toBe(true);
  });

  it("exact channel rule overrides groups['*']", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: false,
        groups: {
          "*": { requireMention: true },
          chn_exact: { requireMention: false },
        },
      },
      channelId: "chn_exact",
    });
    expect(result.requireMention).toBe(false);
  });

  it("picks mentionPatterns from exact channel rule", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        mentionPatterns: ["@bot"],
        groups: {
          chn_exact: { mentionPatterns: ["@mybot"] },
        },
      },
      channelId: "chn_exact",
    });
    expect(result.mentionPatterns).toEqual(["@mybot"]);
  });

  it("inherits unspecified fields from the account policy", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: true,
        mentionPatterns: ["@account"],
        groups: {
          chn_exact: { mentionPatterns: ["@channel"] },
        },
      },
      channelId: " chn_exact ",
    });
    expect(result).toEqual({ requireMention: true, mentionPatterns: ["@channel"] });
  });

  it("inherits unspecified exact fields from the wildcard policy", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        requireMention: false,
        mentionPatterns: ["@account"],
        groups: {
          "*": { requireMention: true, mentionPatterns: ["@wildcard"] },
          chn_exact: { mentionPatterns: ["@channel"] },
        },
      },
      channelId: "chn_exact",
    });
    expect(result).toEqual({ requireMention: true, mentionPatterns: ["@channel"] });
  });

  it("picks mentionPatterns from wildcard rule", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        mentionPatterns: ["@bot"],
        groups: {
          "*": { mentionPatterns: ["@wildbot"] },
        },
      },
      channelId: "chn_other",
    });
    expect(result.mentionPatterns).toEqual(["@wildbot"]);
  });

  it("falls back to account mentionPatterns when no group config", () => {
    const result = resolveClickClackGroupPolicy({
      account: { mentionPatterns: ["@fallback"] },
      channelId: "chn_other",
    });
    expect(result.mentionPatterns).toEqual(["@fallback"]);
  });

  it("unrelated channel does not inherit exact rule", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        groups: { chn_one: { requireMention: true } },
      },
      channelId: "chn_two",
    });
    expect(result.requireMention).toBe(false);
  });

  it("trims inbound channel ids before lookup", () => {
    const result = resolveClickClackGroupPolicy({
      account: {
        groups: { chn_exact: { requireMention: true } },
      },
      channelId: " chn_exact ",
    });
    expect(result.requireMention).toBe(true);
  });
});
