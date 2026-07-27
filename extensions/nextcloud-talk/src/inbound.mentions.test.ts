import { describe, expect, it } from "vitest";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import {
  parseStructuredNextcloudTalkBody,
  resolveExplicitNextcloudTalkMention,
} from "./structured-body.js";

// ---------------------------------------------------------------------------
// parseStructuredNextcloudTalkBody
// ---------------------------------------------------------------------------

describe("parseStructuredNextcloudTalkBody", () => {
  it("returns plain text unchanged with empty mentionEntries and structured=false", () => {
    const result = parseStructuredNextcloudTalkBody("hello world");
    expect(result.text).toBe("hello world");
    expect(result.commandText).toBe("hello world");
    expect(result.structured).toBe(false);
    expect(result.mentionEntries).toEqual([]);
  });

  it("returns raw body unchanged when not JSON (leading whitespace preserved)", () => {
    const raw = "  not json  ";
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe(raw);
    expect(result.structured).toBe(false);
    expect(result.mentionEntries).toEqual([]);
  });

  it("strips bot mention placeholder and sets structured=true for a valid structured body", () => {
    const raw = JSON.stringify({
      message: "Hey {mention0}, how are you?",
      parameters: {
        mention0: { type: "user", id: "agent", name: "iClaw" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent"]));
    expect(result.text).toBe("Hey , how are you?");
    expect(result.commandText).toBe("Hey , how are you?");
    expect(result.structured).toBe(true);
    expect(result.mentionEntries).toHaveLength(1);
    expect(result.mentionEntries[0]).toMatchObject({
      key: "mention0",
      type: "user",
      id: "agent",
      name: "iClaw",
    });
  });

  it("substitutes non-bot user mention with display name when botIds not provided", () => {
    const raw = JSON.stringify({
      message: "Hey {mention0}",
      parameters: {
        mention0: { type: "user", id: "agent", name: "iClaw" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("Hey iClaw");
    expect(result.structured).toBe(true);
  });

  it("produces empty text for a mention-only structured body", () => {
    const raw = JSON.stringify({
      message: "{mention-user1}",
      parameters: {
        "mention-user1": { type: "user", id: "agent", name: "iClaw" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent"]));
    expect(result.text).toBe("");
    expect(result.structured).toBe(true);
  });

  it("strips bot mention before a command so command parsing can see it", () => {
    const raw = JSON.stringify({
      message: "{mention0} /reset",
      parameters: {
        mention0: { type: "user", id: "agent" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent"]));
    expect(result.text).toBe("/reset");
    expect(result.commandText).toBe("/reset");
    expect(result.structured).toBe(true);
  });

  it("does not promote rich-object display names into command text", () => {
    const raw = JSON.stringify({
      message: "{object0}",
      parameters: {
        object0: { type: "file", name: "/reset" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("/reset");
    expect(result.commandText).toBe("_");
  });

  it("preserves non-bot placeholder position before command-like text", () => {
    const raw = JSON.stringify({
      message: "{mention0} /reset",
      parameters: {
        mention0: { type: "user", id: "alice", name: "Alice" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent"]));
    expect(result.text).toBe("Alice /reset");
    expect(result.commandText).toBe("_ /reset");
  });

  it("treats parameter keys and display names as literal text", () => {
    const raw = JSON.stringify({
      message: "See {file[0]} and {user+1}",
      parameters: {
        "file[0]": { type: "file", name: "$& report" },
        "user+1": { type: "user", id: "alice", name: "$` Alice $'" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("See $& report and $` Alice $'");
    expect(result.commandText).toBe("See _ and _");
  });

  it("falls back to raw body text when JSON has no message field", () => {
    const raw = JSON.stringify({ parameters: {} });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe(raw.trim());
    expect(result.structured).toBe(true);
    expect(result.mentionEntries).toEqual([]);
  });

  it("falls back to raw body when JSON is malformed", () => {
    const raw = "{broken json";
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe(raw);
    expect(result.structured).toBe(false);
    expect(result.mentionEntries).toEqual([]);
  });

  it("handles missing parameters key gracefully", () => {
    const raw = JSON.stringify({ message: "hello" });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("hello");
    expect(result.structured).toBe(true);
    expect(result.mentionEntries).toEqual([]);
  });

  it("ignores parameters that are not referenced by the message", () => {
    const raw = JSON.stringify({
      message: "hello",
      parameters: {
        hidden: { type: "user", id: "agent", name: "OpenClaw" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent"]));
    expect(result.text).toBe("hello");
    expect(result.mentionEntries).toEqual([]);
  });

  it("extracts mention-id (hyphenated) field into mentionId", () => {
    const raw = JSON.stringify({
      message: "ping {m}",
      parameters: {
        m: { type: "user", "mention-id": "agent@cloud.example.com" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent@cloud.example.com"]));
    expect(result.mentionEntries[0]?.mentionId).toBe("agent@cloud.example.com");
    // bot mention stripped
    expect(result.text).toBe("ping");
  });

  it("multiple mention entries are all captured; nameless user entries produce empty string", () => {
    const raw = JSON.stringify({
      message: "{a} and {b}",
      parameters: {
        a: { type: "user", id: "alice" },
        b: { type: "user", id: "bob" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.mentionEntries).toHaveLength(2);
    expect(result.mentionEntries.map((e) => e.id)).toEqual(
      expect.arrayContaining(["alice", "bob"]),
    );
    // alice and bob have no display name — substituted with "" (name ?? "")
    expect(result.text).toBe("and");
  });

  it("preserves non-bot user mention display name while stripping the bot mention", () => {
    const raw = JSON.stringify({
      message: "{mention0} ask {mention1} about deploy",
      parameters: {
        mention0: { type: "user", id: "openclaw-bot", name: "OpenClaw" },
        mention1: { type: "user", id: "bob", name: "Bob" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["openclaw-bot"]));
    expect(result.text).toBe("ask Bob about deploy");
    expect(result.structured).toBe(true);
  });

  it("substitutes non-user rich objects with their display name instead of stripping", () => {
    // Talk webhooks use the same placeholder mechanism for calls, files, and
    // links. Their `name` is the text the user saw; dropping it would lose
    // content visible in the chat view.
    const raw = JSON.stringify({
      message: "look at {obj1} and {mention0}",
      parameters: {
        obj1: { type: "call", name: "Daily standup" },
        mention0: { type: "user", id: "agent" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw, new Set(["agent"]));
    expect(result.text).toBe("look at Daily standup and");
    expect(result.structured).toBe(true);
  });

  it("strips non-user rich object placeholder when it has no name", () => {
    const raw = JSON.stringify({
      message: "see {obj1}",
      parameters: {
        obj1: { type: "file" },
      },
    });
    const result = parseStructuredNextcloudTalkBody(raw);
    expect(result.text).toBe("see");
  });
});

// ---------------------------------------------------------------------------
// resolveExplicitNextcloudTalkMention
// ---------------------------------------------------------------------------

function makeAccount(
  overrides: Partial<ResolvedNextcloudTalkAccount> = {},
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  };
}

describe("resolveExplicitNextcloudTalkMention", () => {
  it("does not treat the local account id as a Nextcloud user id", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "default" }],
      account: makeAccount({ accountId: "default" }),
    });
    expect(result).toBe(false);
  });

  it("matches the canonical webhook bot actor id case-insensitively", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [
        {
          key: "m0",
          type: "user",
          id: "BOT-CD7930A4F9F485D9DC0606A8A42A9D705376CBCF",
        },
      ],
      account: makeAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          webhookPublicUrl: "https://bot.example.com/nextcloud-talk-webhook",
        },
      }),
    });
    expect(result).toBe(true);
  });

  it("derives the bot actor id from the default listener URL", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [
        {
          key: "m0",
          type: "user",
          id: "bot-69739f2d0a2371dd78066cea3704b66c08548aac",
        },
      ],
      account: makeAccount(),
    });
    expect(result).toBe(true);
  });

  it("returns false when type is not 'user'", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "guest", id: "agent" }],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });

  it("returns false when no mention entries match", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "alice" }],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });

  it("returns false when mentionEntries is empty", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });

  it("does not treat the room-lookup API user as the bot identity", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", mentionId: "bot@cloud.example.com" }],
      account: makeAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          apiUser: "bot@cloud.example.com",
        },
      }),
    });
    expect(result).toBe(false);
  });

  it("does not infer a user id from the API user's email local part", () => {
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", id: "bot" }],
      account: makeAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          apiUser: "bot@cloud.example.com",
        },
      }),
    });
    expect(result).toBe(false);
  });

  it("does not match via account display name (UI label is not a stable identifier)", () => {
    // account.name is a CLI/UI label — matching it would let any user with the
    // same display name satisfy requireMention in an allowlisted room.
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", name: "iClaw" }],
      account: makeAccount({ name: "iClaw" }),
    });
    expect(result).toBe(false);
  });

  it("does not match via mention display name even when it matches account id", () => {
    // entry.name is display text from the structured payload, not a stable
    // identity — a collision with the bot account id must not fire.
    const result = resolveExplicitNextcloudTalkMention({
      mentionEntries: [{ key: "m0", type: "user", name: "agent" }],
      account: makeAccount({ accountId: "agent" }),
    });
    expect(result).toBe(false);
  });
});
