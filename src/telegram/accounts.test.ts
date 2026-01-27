import { describe, expect, it } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { resolveTelegramAccount } from "./accounts.js";

describe("resolveTelegramAccount", () => {
  it("falls back to the first configured account when accountId is omitted", () => {
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      const cfg: MoltbotConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("work");
      expect(account.token).toBe("tok-work");
      expect(account.tokenSource).toBe("config");
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("uses TELEGRAM_BOT_TOKEN when default account config is missing", () => {
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "tok-env";
    try {
      const cfg: MoltbotConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-env");
      expect(account.tokenSource).toBe("env");
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("prefers default config token over TELEGRAM_BOT_TOKEN", () => {
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "tok-env";
    try {
      const cfg: MoltbotConfig = {
        channels: {
          telegram: { botToken: "tok-config" },
        },
      };

      const account = resolveTelegramAccount({ cfg });
      expect(account.accountId).toBe("default");
      expect(account.token).toBe("tok-config");
      expect(account.tokenSource).toBe("config");
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });

  it("does not fall back when accountId is explicitly provided", () => {
    const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = "";
    try {
      const cfg: MoltbotConfig = {
        channels: {
          telegram: { accounts: { work: { botToken: "tok-work" } } },
        },
      };

      const account = resolveTelegramAccount({ cfg, accountId: "default" });
      expect(account.accountId).toBe("default");
      expect(account.tokenSource).toBe("none");
      expect(account.token).toBe("");
    } finally {
      if (prevTelegramToken === undefined) {
        delete process.env.TELEGRAM_BOT_TOKEN;
      } else {
        process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
      }
    }
  });
});
