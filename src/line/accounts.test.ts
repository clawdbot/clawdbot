import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  resolveLineAccount,
  listLineAccountIds,
  resolveDefaultLineAccountId,
  normalizeAccountId,
  DEFAULT_ACCOUNT_ID,
} from "./accounts.js";
import type { MoltbotConfig } from "../config/config.js";

describe("LINE accounts", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    delete process.env.LINE_CHANNEL_SECRET;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("resolveLineAccount", () => {
    it("resolves account from config", () => {
      const cfg: MoltbotConfig = {
        channels: {
          line: {
            enabled: true,
            channelAccessToken: "test-token",
            channelSecret: "test-secret",
            name: "Test Bot",
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.accountId).toBe(DEFAULT_ACCOUNT_ID);
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("test-token");
      expect(account.channelSecret).toBe("test-secret");
      expect(account.name).toBe("Test Bot");
      expect(account.tokenSource).toBe("config");
    });

    it("resolves account from environment variables", () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "env-token";
      process.env.LINE_CHANNEL_SECRET = "env-secret";

      const cfg: MoltbotConfig = {
        channels: {
          line: {
            enabled: true,
          },
        },
      };

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("env-token");
      expect(account.channelSecret).toBe("env-secret");
      expect(account.tokenSource).toBe("env");
    });

    it("resolves named account", () => {
      const cfg: MoltbotConfig = {
        channels: {
          line: {
            enabled: true,
            accounts: {
              business: {
                enabled: true,
                channelAccessToken: "business-token",
                channelSecret: "business-secret",
                name: "Business Bot",
              },
            },
          },
        },
      };

      const account = resolveLineAccount({ cfg, accountId: "business" });

      expect(account.accountId).toBe("business");
      expect(account.enabled).toBe(true);
      expect(account.channelAccessToken).toBe("business-token");
      expect(account.channelSecret).toBe("business-secret");
      expect(account.name).toBe("Business Bot");
    });

    it("returns empty token when not configured", () => {
      const cfg: MoltbotConfig = {};

      const account = resolveLineAccount({ cfg });

      expect(account.channelAccessToken).toBe("");
      expect(account.channelSecret).toBe("");
      expect(account.tokenSource).toBe("none");
    });
  });

  describe("listLineAccountIds", () => {
    it("returns default account when configured at base level", () => {
      const cfg: MoltbotConfig = {
        channels: {
          line: {
            channelAccessToken: "test-token",
          },
        },
      };

      const ids = listLineAccountIds(cfg);

      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });

    it("returns named accounts", () => {
      const cfg: MoltbotConfig = {
        channels: {
          line: {
            accounts: {
              business: { enabled: true },
              personal: { enabled: true },
            },
          },
        },
      };

      const ids = listLineAccountIds(cfg);

      expect(ids).toContain("business");
      expect(ids).toContain("personal");
    });

    it("returns default from env", () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "env-token";
      const cfg: MoltbotConfig = {};

      const ids = listLineAccountIds(cfg);

      expect(ids).toContain(DEFAULT_ACCOUNT_ID);
    });
  });

  describe("resolveDefaultLineAccountId", () => {
    it("returns default when configured", () => {
      const cfg: MoltbotConfig = {
        channels: {
          line: {
            channelAccessToken: "test-token",
          },
        },
      };

      const id = resolveDefaultLineAccountId(cfg);

      expect(id).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("returns first named account when default not configured", () => {
      const cfg: MoltbotConfig = {
        channels: {
          line: {
            accounts: {
              business: { enabled: true },
            },
          },
        },
      };

      const id = resolveDefaultLineAccountId(cfg);

      expect(id).toBe("business");
    });
  });

  describe("normalizeAccountId", () => {
    it("normalizes undefined to default", () => {
      expect(normalizeAccountId(undefined)).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("normalizes 'default' to DEFAULT_ACCOUNT_ID", () => {
      expect(normalizeAccountId("default")).toBe(DEFAULT_ACCOUNT_ID);
    });

    it("preserves other account ids", () => {
      expect(normalizeAccountId("business")).toBe("business");
    });

    it("lowercases account ids", () => {
      expect(normalizeAccountId("Business")).toBe("business");
    });

    it("trims whitespace", () => {
      expect(normalizeAccountId("  business  ")).toBe("business");
    });
  });
});
