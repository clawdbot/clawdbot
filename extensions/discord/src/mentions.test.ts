import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetDiscordDirectoryCacheForTest,
  rememberDiscordDirectoryUser,
} from "./directory-cache.js";
import { formatMention, rewriteDiscordKnownMentions } from "./mentions.js";

describe("formatMention", () => {
  it("formats user mentions from ids", () => {
    expect(formatMention({ userId: "123456789" })).toBe("<@123456789>");
  });

  it("formats role mentions from ids", () => {
    expect(formatMention({ roleId: "987654321" })).toBe("<@&987654321>");
  });

  it("formats channel mentions from ids", () => {
    expect(formatMention({ channelId: "777555333" })).toBe("<#777555333>");
  });

  it("throws when no mention id is provided", () => {
    expect(() => formatMention({})).toThrow(/exactly one/i);
  });

  it("throws when more than one mention id is provided", () => {
    expect(() => formatMention({ userId: "1", roleId: "2" })).toThrow(/exactly one/i);
  });
});

describe("rewriteDiscordKnownMentions", () => {
  beforeEach(() => {
    __resetDiscordDirectoryCacheForTest();
  });

  it("rewrites @name mentions when a cached user id exists", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["Alice", "@alice_user", "alice#1234"],
    });
    const rewritten = rewriteDiscordKnownMentions("ping @Alice and @alice_user", {
      accountId: "default",
    });
    expect(rewritten).toBe("ping <@123456789> and <@123456789>");
  });

  it("preserves unknown mentions and reserved mentions", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    const rewritten = rewriteDiscordKnownMentions("hello @unknown @everyone @here", {
      accountId: "default",
    });
    expect(rewritten).toBe("hello @unknown @everyone @here");
  });

  it("does not rewrite mentions inside markdown code spans", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    const rewritten = rewriteDiscordKnownMentions(
      "inline `@alice` fence ```\n@alice\n``` text @alice",
      {
        accountId: "default",
      },
    );
    expect(rewritten).toBe("inline `@alice` fence ```\n@alice\n``` text <@123456789>");
  });

  it("is account-scoped", () => {
    rememberDiscordDirectoryUser({
      accountId: "ops",
      userId: "999888777",
      handles: ["alice"],
    });
    const defaultRewrite = rewriteDiscordKnownMentions("@alice", { accountId: "default" });
    const opsRewrite = rewriteDiscordKnownMentions("@alice", { accountId: "ops" });
    expect(defaultRewrite).toBe("@alice");
    expect(opsRewrite).toBe("<@999888777>");
  });
});
