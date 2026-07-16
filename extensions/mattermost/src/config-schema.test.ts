// Mattermost tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { MattermostConfigSchema } from "./config-schema-core.js";

describe("MattermostConfigSchema", () => {
  it("accepts SecretRef botToken at top-level", () => {
    const result = MattermostConfigSchema.safeParse({
      botToken: { source: "env", provider: "default", id: "MATTERMOST_BOT_TOKEN" },
      baseUrl: "https://chat.example.com",
    });
    expect(result.success).toBe(true);
  });

  it("accepts SecretRef botToken on account", () => {
    const result = MattermostConfigSchema.safeParse({
      accounts: {
        main: {
          botToken: { source: "env", provider: "default", id: "MATTERMOST_BOT_TOKEN_MAIN" },
          baseUrl: "https://chat.example.com",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts replyToMode", () => {
    const result = MattermostConfigSchema.safeParse({
      replyToMode: "all",
    });
    expect(result.success).toBe(true);
  });

  it("accepts per-chat-type reply threading", () => {
    const result = MattermostConfigSchema.safeParse({
      replyToModeByChatType: {
        direct: "first",
        group: "all",
        channel: "off",
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects dmPolicy="open" without wildcard allowFrom', () => {
    const result = MattermostConfigSchema.safeParse({
      dmPolicy: "open",
    });
    expect(result.success).toBe(false);
  });

  it('accepts dmPolicy="open" with wildcard allowFrom', () => {
    const result = MattermostConfigSchema.safeParse({
      dmPolicy: "open",
      allowFrom: ["*"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts documented streaming modes and progress config", () => {
    const result = MattermostConfigSchema.safeParse({
      streaming: {
        mode: "progress",
        progress: {
          label: "Shelling",
          maxLines: 4,
          toolProgress: false,
          commandText: "status",
        },
        preview: { commandText: "raw" },
      },
      accounts: {
        quiet: {
          streaming: { mode: "off" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects retired scalar streaming and flat delivery keys", () => {
    // Scalar/boolean streaming and the flat delivery keys are doctor-migrated
    // legacy input; the runtime schema accepts the nested shape only.
    expect(MattermostConfigSchema.safeParse({ streaming: "partial" }).success).toBe(false);
    expect(MattermostConfigSchema.safeParse({ streaming: false }).success).toBe(false);
    expect(MattermostConfigSchema.safeParse({ blockStreaming: true }).success).toBe(false);
    expect(MattermostConfigSchema.safeParse({ chunkMode: "newline" }).success).toBe(false);
  });

  it("accepts groups with requireMention", () => {
    const result = MattermostConfigSchema.safeParse({
      groups: {
        "*": { requireMention: true },
        "channel-123": { requireMention: false },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts groups on account", () => {
    const result = MattermostConfigSchema.safeParse({
      accounts: {
        main: {
          baseUrl: "https://chat.example.com",
          groups: {
            "*": { requireMention: true },
          },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown properties inside groups entry", () => {
    const result = MattermostConfigSchema.safeParse({
      groups: {
        "*": { requireMention: true, unknownProp: "bad" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unsupported direct-message reply threading config", () => {
    const result = MattermostConfigSchema.safeParse({
      dm: {
        replyToMode: "all",
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown per-chat-type reply threading keys", () => {
    const result = MattermostConfigSchema.safeParse({
      replyToModeByChatType: {
        forum: "all",
      },
    });
    expect(result.success).toBe(false);
  });
});
