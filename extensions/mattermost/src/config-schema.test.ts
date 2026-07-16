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

  it("rejects unsupported per-chat-type reply threading config", () => {
    const result = MattermostConfigSchema.safeParse({
      replyToModeByChatType: {
        direct: "all",
      },
    });
    expect(result.success).toBe(false);
  });
});
