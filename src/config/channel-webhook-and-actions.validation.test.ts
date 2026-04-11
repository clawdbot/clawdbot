import { describe, expect, it } from "vitest";
import { TelegramConfigSchema } from "./zod-schema.providers-core.js";

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

describe("channel webhook and actions validation", () => {
  describe("Telegram poll actions", () => {
    it("accepts channels.telegram.actions.poll", () => {
      expectTelegramConfigValid({ actions: { poll: false } });
    });

    it("accepts channels.telegram.accounts.<id>.actions.poll", () => {
      expectTelegramConfigValid({ accounts: { ops: { actions: { poll: false } } } });
    });
  });

  describe("Telegram webhookPort", () => {
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
  });

  describe("Telegram webhook secret", () => {
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
});
