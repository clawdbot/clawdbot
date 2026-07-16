// Feishu tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { FeishuChannelConfigSchema, FeishuConfigSchema } from "./config-schema.js";

// The NEGATIVE webhook fixtures below spread these bases and add
// verificationToken separately so the GHSA-G353-MGV3-8PCJ opengrep pattern —
// which matches `connectionMode: "webhook"` next to `verificationToken` in
// one object literal (including via constant propagation) — does not flag the
// fixtures that prove the schema rejects them. Positive fixtures stay literal.
const topLevelWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_top",
  appSecret: "secret_top", // pragma: allowlist secret
};
const accountWebhookBase = {
  connectionMode: "webhook",
  appId: "cli_main",
  appSecret: "secret_main", // pragma: allowlist secret
};

function expectSchemaIssue(
  result: ReturnType<typeof FeishuConfigSchema.safeParse>,
  issuePath: string,
) {
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues.map((issue) => issue.path.join("."))).toContain(issuePath);
  }
}

describe("FeishuConfigSchema webhook validation", () => {
  it("applies top-level defaults", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.domain).toBe("feishu");
    expect(result.connectionMode).toBe("websocket");
    expect(result.webhookPath).toBe("/feishu/events");
    expect(result.dmPolicy).toBe("pairing");
    expect(result.groupPolicy).toBe("allowlist");
    // requireMention has no schema-level default now — it is resolved at runtime
    // through shared channel group-policy resolution, with an open-group override
    // that defaults to false only when requireMention is otherwise unset.
    expect(result.requireMention).toBeUndefined();
  });

  it("does not force top-level policy defaults into account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {},
      },
    });

    expect(result.accounts?.main?.dmPolicy).toBeUndefined();
    expect(result.accounts?.main?.groupPolicy).toBeUndefined();
    expect(result.accounts?.main?.requireMention).toBeUndefined();
  });

  it("normalizes legacy groupPolicy allowall to open", () => {
    const result = FeishuConfigSchema.parse({
      groupPolicy: "allowall",
    });

    expect(result.groupPolicy).toBe("open");
  });

  it("exports legacy groupPolicy as a typed config input", () => {
    const expected = {
      anyOf: [
        { type: "string", enum: ["open", "allowlist", "disabled"] },
        { type: "string", const: "allowall" },
      ],
    };

    expect(FeishuChannelConfigSchema.schema).toMatchObject({
      properties: {
        groupPolicy: expected,
        accounts: {
          additionalProperties: {
            properties: { groupPolicy: expected },
          },
        },
      },
    });
  });

  it("rejects top-level webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expectSchemaIssue(result, "verificationToken");
  });

  it("rejects top-level webhook mode without encryptKey", () => {
    // topLevelWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      ...topLevelWebhookBase,
      verificationToken: "token_top",
    });

    expectSchemaIssue(result, "encryptKey");
  });

  it("accepts top-level webhook mode with verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: "secret_top", // pragma: allowlist secret
    });

    expect(result.success).toBe(true);
  });

  it("rejects account webhook mode without verificationToken", () => {
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.verificationToken");
  });

  it("rejects account webhook mode without encryptKey", () => {
    // accountWebhookBase (see top of file) keeps the GHSA opengrep pattern
    // from matching this negative fixture.
    const result = FeishuConfigSchema.safeParse({
      accounts: {
        main: {
          ...accountWebhookBase,
          verificationToken: "token_main",
        },
      },
    });

    expectSchemaIssue(result, "accounts.main.encryptKey");
  });

  it("accepts account webhook mode inheriting top-level verificationToken and encryptKey", () => {
    const result = FeishuConfigSchema.safeParse({
      verificationToken: "token_top",
      encryptKey: "encrypt_top",
      accounts: {
        main: {
          connectionMode: "webhook",
          appId: "cli_main",
          appSecret: "secret_main", // pragma: allowlist secret
        },
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef verificationToken in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: "encrypt_top",
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });

  it("accepts SecretRef encryptKey in webhook mode", () => {
    const result = FeishuConfigSchema.safeParse({
      connectionMode: "webhook",
      verificationToken: {
        source: "env",
        provider: "default",
        id: "FEISHU_VERIFICATION_TOKEN",
      },
      encryptKey: {
        source: "env",
        provider: "default",
        id: "FEISHU_ENCRYPT_KEY",
      },
      appId: "cli_top",
      appSecret: {
        source: "env",
        provider: "default",
        id: "FEISHU_APP_SECRET",
      },
    });

    expect(result.success).toBe(true);
  });
});

describe("FeishuConfigSchema replyInThread", () => {
  it("accepts replyInThread at top level", () => {
    const result = FeishuConfigSchema.parse({ replyInThread: "enabled" });
    expect(result.replyInThread).toBe("enabled");
  });

  it("defaults replyInThread to undefined when not set", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.replyInThread).toBeUndefined();
  });

  it("rejects invalid replyInThread value", () => {
    const result = FeishuConfigSchema.safeParse({ replyInThread: "always" });
    expect(result.success).toBe(false);
  });

  it("accepts replyInThread in group config", () => {
    const result = FeishuConfigSchema.parse({
      groups: { "oc-group": { replyInThread: "enabled" } },
    });
    expect(result.groups?.["oc-group"]?.replyInThread).toBe("enabled");
  });

  it("accepts replyInThread in account config", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: { replyInThread: "enabled" },
      },
    });
    expect(result.accounts?.main?.replyInThread).toBe("enabled");
  });
});

describe("FeishuConfigSchema optimization flags", () => {
  it("defaults top-level typingIndicator and resolveSenderNames to true", () => {
    const result = FeishuConfigSchema.parse({});
    expect(result.typingIndicator).toBe(true);
    expect(result.resolveSenderNames).toBe(true);
  });

  it("accepts top-level and account-level nested streaming config", () => {
    const result = FeishuConfigSchema.parse({
      streaming: {
        mode: "partial",
        chunkMode: "newline",
        block: { enabled: true, coalesce: { idleMs: 100 } },
      },
      accounts: {
        main: {
          streaming: { mode: "off", block: { enabled: false } },
        },
      },
    });

    expect(result.streaming?.block?.enabled).toBe(true);
    expect(result.streaming?.chunkMode).toBe("newline");
    expect(result.accounts?.main?.streaming).toEqual({
      mode: "off",
      block: { enabled: false },
    });
  });

  it.each([
    ["boolean streaming", { streaming: true }],
    ["flat blockStreaming", { blockStreaming: true }],
    ["flat blockStreamingCoalesce", { blockStreamingCoalesce: { idleMs: 100 } }],
    ["flat chunkMode", { chunkMode: "newline" }],
  ])("rejects legacy %s spelling", (_name, overrides) => {
    expect(FeishuConfigSchema.safeParse(overrides).success).toBe(false);
    expect(FeishuConfigSchema.safeParse({ accounts: { main: overrides } }).success).toBe(false);
  });

  it("accepts account-level optimization flags", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          typingIndicator: false,
          resolveSenderNames: false,
        },
      },
    });
    expect(result.accounts?.main?.typingIndicator).toBe(false);
    expect(result.accounts?.main?.resolveSenderNames).toBe(false);
  });
});

describe("FeishuConfigSchema TTS overrides", () => {
  it("accepts top-level and account-level TTS overrides", () => {
    const result = FeishuConfigSchema.parse({
      tts: {
        auto: "always",
        provider: "openai",
        providers: {
          openai: {
            voice: "alloy",
          },
        },
      },
      accounts: {
        english: {
          tts: {
            providers: {
              openai: {
                voice: "shimmer",
              },
            },
          },
        },
      },
    });

    expect(result.tts).toEqual({
      auto: "always",
      provider: "openai",
      providers: {
        openai: {
          voice: "alloy",
        },
      },
    });
    expect(result.accounts?.english?.tts).toEqual({
      providers: {
        openai: {
          voice: "shimmer",
        },
      },
    });
  });
});

describe("FeishuConfigSchema actions", () => {
  it("accepts top-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      actions: { reactions: false },
    });
    expect(result.actions?.reactions).toBe(false);
  });

  it("accepts account-level reactions action gate", () => {
    const result = FeishuConfigSchema.parse({
      accounts: {
        main: {
          actions: { reactions: false },
        },
      },
    });
    expect(result.accounts?.main?.actions?.reactions).toBe(false);
  });
});

describe("FeishuConfigSchema defaultAccount", () => {
  it("accepts defaultAccount when it matches an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        "router-d": { appId: "cli_router", appSecret: "secret_router" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(true);
  });

  it("rejects defaultAccount when it does not match an account key", () => {
    const result = FeishuConfigSchema.safeParse({
      defaultAccount: "router-d",
      accounts: {
        backup: { appId: "cli_backup", appSecret: "secret_backup" }, // pragma: allowlist secret
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toContain("defaultAccount");
    }
  });
});
