// Discord tests cover mentions plugin behavior.
import { beforeEach, describe, expect, it } from "vitest";
import { rememberDiscordDirectoryUser } from "./directory-cache.js";
import { clearDiscordDirectoryCacheForTest } from "./directory-cache.test-support.js";
import {
  discordTextHasBroadcastMention,
  formatMention,
  rewriteDiscordKnownMentions,
} from "./mentions.js";

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
    clearDiscordDirectoryCacheForTest();
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

  it("rewrites configured mention aliases before the cache", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "111111111",
      handles: ["vladislava"],
    });
    const rewritten = rewriteDiscordKnownMentions("ping @Vladislava and @BuildBot#1234", {
      accountId: "default",
      mentionAliases: {
        BuildBot: "222222222",
        Vladislava: "333333333",
      },
    });
    expect(rewritten).toBe("ping <@333333333> and <@222222222>");
  });

  it("supports configured aliases with a leading @ key", () => {
    const rewritten = rewriteDiscordKnownMentions("ping @OpsLead", {
      accountId: "default",
      mentionAliases: {
        "@opslead": "444444444",
      },
    });
    expect(rewritten).toBe("ping <@444444444>");
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

  it.each([
    {
      name: "balanced inline and fenced code",
      input: "inline `@alice` fence ```\n@alice\n``` text @alice",
      expected: "inline `@alice` fence ```\n@alice\n``` text <@123456789>",
    },
    {
      name: "closed multiline single-backtick code",
      input: "Example: `first\nsecond`\nPlease review @alice",
      expected: "Example: `first\nsecond`\nPlease review <@123456789>",
    },
    {
      name: "closed multiline double-backtick code with CRLF",
      input: "Example: ``first ` line\r\nsecond``\r\nPlease review @alice",
      expected: "Example: ``first ` line\r\nsecond``\r\nPlease review <@123456789>",
    },
    {
      name: "closed multiline code containing a longer backtick run",
      input: "Example: ``first ``` literal\nsecond``\nPlease review @alice",
      expected: "Example: ``first ``` literal\nsecond``\nPlease review <@123456789>",
    },
    {
      name: "unterminated single-backtick code",
      input: "outside @alice then `inside @alice",
      expected: "outside <@123456789> then `inside @alice",
    },
    {
      name: "unterminated double-backtick code",
      input: "outside @alice then ``inside @alice",
      expected: "outside <@123456789> then ``inside @alice",
    },
    {
      name: "escaped literal backticks",
      input: "literal \\` outside @alice",
      expected: "literal \\` outside <@123456789>",
    },
    {
      name: "backticks after an even number of backslashes",
      input: "literal \\\\` inside @alice",
      expected: "literal \\\\` inside @alice",
    },
    {
      name: "escaped backticks before real unterminated code",
      input: "literal \\` outside @alice then `inside @alice",
      expected: "literal \\` outside <@123456789> then `inside @alice",
    },
  ])("does not rewrite mentions inside $name", ({ input, expected }) => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    expect(rewriteDiscordKnownMentions(input, { accountId: "default" })).toBe(expected);
  });

  it("does not end longer code fences at triple-backtick literals inside the body", () => {
    rememberDiscordDirectoryUser({
      accountId: "default",
      userId: "123456789",
      handles: ["alice"],
    });
    const text = '````ts\nconst fence = "```";\n@alice\n```` text @alice';
    const rewritten = rewriteDiscordKnownMentions(text, {
      accountId: "default",
    });
    expect(rewritten).toBe('````ts\nconst fence = "```";\n@alice\n```` text <@123456789>');
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

describe("discordTextHasBroadcastMention", () => {
  it("detects @everyone and @here", () => {
    expect(discordTextHasBroadcastMention("heads up @everyone")).toBe(true);
    expect(discordTextHasBroadcastMention("@here please")).toBe(true);
  });

  it("ignores targeted mentions and lookalikes", () => {
    expect(discordTextHasBroadcastMention("ping <@123>")).toBe(false);
    expect(discordTextHasBroadcastMention("mail me at a@everyones")).toBe(false);
  });
});
