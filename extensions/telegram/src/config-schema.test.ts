import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "../config-api.js";

function expectTelegramConfigValid(config: unknown) {
  expect(TelegramConfigSchema.safeParse(config).success).toBe(true);
}

function expectTelegramConfigIssue(config: unknown, path: string) {
  const res = TelegramConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues[0]?.path.join(".")).toBe(path);
  }
}

describe("telegram custom commands schema", () => {
  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    expectTelegramConfigIssue(
      { dmPolicy: "open", allowFrom: ["123456789"], botToken: "fake" },
      "allowFrom",
    );
  });

  it('accepts dmPolicy="open" with allowFrom "*"', () => {
    const res = TelegramConfigSchema.safeParse({ dmPolicy: "open", allowFrom: ["*"] });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("open");
    }
  });

  it("defaults dm/group policy", () => {
    const res = TelegramConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dmPolicy).toBe("pairing");
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("accepts historyLimit overrides per account", () => {
    const res = TelegramConfigSchema.safeParse({
      historyLimit: 8,
      accounts: { ops: { historyLimit: 3 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(8);
      expect(res.data.accounts?.ops?.historyLimit).toBe(3);
    }
  });

  it("accepts pollingStallThresholdMs overrides per account", () => {
    const res = TelegramConfigSchema.safeParse({
      pollingStallThresholdMs: 120_000,
      accounts: { ops: { pollingStallThresholdMs: 180_000 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.pollingStallThresholdMs).toBe(120_000);
      expect(res.data.accounts?.ops?.pollingStallThresholdMs).toBe(180_000);
    }
  });

  it("accepts mediaGroupFlushMs overrides per account", () => {
    const res = TelegramConfigSchema.safeParse({
      mediaGroupFlushMs: 750,
      accounts: { ops: { mediaGroupFlushMs: 1500 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.mediaGroupFlushMs).toBe(750);
      expect(res.data.accounts?.ops?.mediaGroupFlushMs).toBe(1500);
    }
  });

  it("rejects mediaGroupFlushMs outside the supported flush bounds", () => {
    expectTelegramConfigIssue({ mediaGroupFlushMs: 9 }, "mediaGroupFlushMs");
    expectTelegramConfigIssue({ mediaGroupFlushMs: 60_001 }, "mediaGroupFlushMs");
  });

  it("accepts DM thread reply policy overrides", () => {
    const res = TelegramConfigSchema.safeParse({
      dm: { threadReplies: "off" },
      direct: {
        "123456789": {
          threadReplies: "inbound",
        },
      },
      accounts: {
        ops: {
          dm: { threadReplies: "always" },
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.dm?.threadReplies).toBe("off");
      expect(res.data.direct?.["123456789"]?.threadReplies).toBe("inbound");
      expect(res.data.accounts?.ops?.dm?.threadReplies).toBe("always");
    }
  });

  it("rejects unknown DM thread reply policy values", () => {
    expectTelegramConfigIssue({ dm: { threadReplies: "first" } }, "dm.threadReplies");
    expectTelegramConfigIssue(
      {
        direct: {
          "123456789": {
            threadReplies: "first",
          },
        },
      },
      "direct.123456789.threadReplies",
    );
  });

  it("rejects pollingStallThresholdMs outside the watchdog bounds", () => {
    expectTelegramConfigIssue({ pollingStallThresholdMs: 29_999 }, "pollingStallThresholdMs");
    expectTelegramConfigIssue({ pollingStallThresholdMs: 600_001 }, "pollingStallThresholdMs");
  });

  it("accepts textChunkLimit", () => {
    const res = TelegramConfigSchema.safeParse({
      enabled: true,
      textChunkLimit: 3333,
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.textChunkLimit).toBe(3333);
    }
  });

  it("normalizes custom commands", () => {
    const res = TelegramConfigSchema.safeParse({
      customCommands: [{ command: "/Backup", description: "  Git backup  " }],
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.customCommands).toEqual([{ command: "backup", description: "Git backup" }]);
  });

  it("normalizes hyphens in custom command names", () => {
    const res = TelegramConfigSchema.safeParse({
      customCommands: [{ command: "Bad-Name", description: "Override status" }],
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.customCommands).toEqual([
      { command: "bad_name", description: "Override status" },
    ]);
  });
});

describe("telegram topic agentId schema", () => {
  it("accepts topic ingest boolean", () => {
    expectTelegramConfigValid({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              ingest: true,
            },
          },
        },
      },
    });
  });

  it("accepts group ingest boolean", () => {
    expectTelegramConfigValid({
      groups: {
        "-1001234567890": {
          ingest: true,
        },
      },
    });
  });

  it("rejects non-boolean ingest", () => {
    expectTelegramConfigIssue(
      {
        groups: {
          "-1001234567890": {
            ingest: { enabled: true },
          },
        },
      },
      "groups.-1001234567890.ingest",
    );
  });

  it("accepts nested groupPolicy overrides", () => {
    expectTelegramConfigValid({
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          topics: {
            "42": {
              groupPolicy: "disabled",
            },
          },
        },
      },
    });
  });

  it("accepts valid agentId in forum group topic config", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              agentId: "main",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.groups?.["-1001234567890"]?.topics?.["42"]?.agentId).toBe("main");
  });

  it("accepts valid agentId in DM topic config", () => {
    const res = TelegramConfigSchema.safeParse({
      direct: {
        "123456789": {
          topics: {
            "99": {
              agentId: "support",
              systemPrompt: "You are support",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.direct?.["123456789"]?.topics?.["99"]?.agentId).toBe("support");
  });

  it("accepts DM threadReplies overrides", () => {
    const res = TelegramConfigSchema.safeParse({
      direct: {
        "123456789": {
          threadReplies: "inbound",
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.direct?.["123456789"]?.threadReplies).toBe("inbound");
  });

  it("accepts empty config without agentId", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              systemPrompt: "Be helpful",
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    expect(res.data.groups?.["-1001234567890"]?.topics?.["42"]).toEqual({
      systemPrompt: "Be helpful",
    });
  });

  it("accepts multiple topics with different agentIds", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "1": { agentId: "main" },
            "3": { agentId: "zu" },
            "5": { agentId: "q" },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      console.error(res.error.format());
      return;
    }
    const topics = res.data.groups?.["-1001234567890"]?.topics;
    expect(topics?.["1"]?.agentId).toBe("main");
    expect(topics?.["3"]?.agentId).toBe("zu");
    expect(topics?.["5"]?.agentId).toBe("q");
  });

  it("rejects unknown fields in topic config", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "-1001234567890": {
          topics: {
            "42": {
              agentId: "main",
              unknownField: "should fail",
            },
          },
        },
      },
    });

    expect(res.success).toBe(false);
  });
});

describe("telegram disableAudioPreflight schema", () => {
  it("accepts disableAudioPreflight for groups and topics", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "*": {
          requireMention: true,
          disableAudioPreflight: true,
          topics: {
            "123": {
              disableAudioPreflight: false,
            },
          },
        },
      },
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    const group = res.data.groups?.["*"];
    expect(group?.disableAudioPreflight).toBe(true);
    expect(group?.topics?.["123"]?.disableAudioPreflight).toBe(false);
  });

  it("rejects non-boolean disableAudioPreflight values", () => {
    const res = TelegramConfigSchema.safeParse({
      groups: {
        "*": {
          disableAudioPreflight: "yes",
        },
      },
    });

    expect(res.success).toBe(false);
  });
});

describe("telegram token schema", () => {
  it("accepts botToken without tokenFile", () => {
    const res = TelegramConfigSchema.safeParse({
      botToken: "123:ABC",
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.botToken).toBe("123:ABC");
    expect(res.data.tokenFile).toBeUndefined();
  });

  it("accepts tokenFile without botToken", () => {
    const res = TelegramConfigSchema.safeParse({
      tokenFile: "/run/agenix/telegram-token",
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.tokenFile).toBe("/run/agenix/telegram-token");
    expect(res.data.botToken).toBeUndefined();
  });

  it("accepts botToken and tokenFile together", () => {
    const res = TelegramConfigSchema.safeParse({
      botToken: "fallback:token",
      tokenFile: "/run/agenix/telegram-token",
    });

    expect(res.success).toBe(true);
    if (!res.success) {
      return;
    }

    expect(res.data.botToken).toBe("fallback:token");
    expect(res.data.tokenFile).toBe("/run/agenix/telegram-token");
  });
});

describe("telegram poll actions schema", () => {
  it("accepts editMessage and createForumTopic actions", () => {
    expectTelegramConfigValid({
      actions: {
        editMessage: true,
        createForumTopic: false,
      },
    });
  });

  it("accepts actions.poll", () => {
    expectTelegramConfigValid({ actions: { poll: false } });
  });

  it("accepts account actions.poll", () => {
    expectTelegramConfigValid({ accounts: { ops: { actions: { poll: false } } } });
  });
});

describe("telegram webhook schema", () => {
  it("accepts a positive webhookPort", () => {
    expectTelegramConfigValid({
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPort: 8787,
    });
  });

  it("accepts webhookPort set to 0 for ephemeral port binding", () => {
    expectTelegramConfigValid({
      webhookUrl: "https://example.com/telegram-webhook",
      webhookSecret: "secret",
      webhookPort: 0,
    });
  });

  it("rejects negative webhookPort", () => {
    expectTelegramConfigIssue(
      {
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: "secret",
        webhookPort: -1,
      },
      "webhookPort",
    );
  });

  it.each([
    {
      name: "webhookUrl when webhookSecret is configured",
      config: {
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: "secret",
      },
    },
    {
      name: "webhookUrl when webhookSecret is configured as SecretRef",
      config: {
        webhookUrl: "https://example.com/telegram-webhook",
        webhookSecret: {
          source: "env",
          provider: "default",
          id: "TELEGRAM_WEBHOOK_SECRET",
        },
      },
    },
    {
      name: "account webhookUrl when base webhookSecret is configured",
      config: {
        webhookSecret: "secret",
        accounts: {
          ops: {
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      },
    },
    {
      name: "account webhookUrl when account webhookSecret is configured as SecretRef",
      config: {
        accounts: {
          ops: {
            webhookUrl: "https://example.com/telegram-webhook",
            webhookSecret: {
              source: "env",
              provider: "default",
              id: "TELEGRAM_OPS_WEBHOOK_SECRET",
            },
          },
        },
      },
    },
  ] as const)("accepts $name", ({ config }) => {
    expectTelegramConfigValid(config);
  });

  it("rejects webhookUrl without webhookSecret", () => {
    expectTelegramConfigIssue(
      {
        webhookUrl: "https://example.com/telegram-webhook",
      },
      "webhookSecret",
    );
  });

  it("rejects account webhookUrl without webhookSecret", () => {
    expectTelegramConfigIssue(
      {
        accounts: {
          ops: {
            webhookUrl: "https://example.com/telegram-webhook",
          },
        },
      },
      "accounts.ops.webhookSecret",
    );
  });
});
