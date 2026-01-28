/**
 * Webex accounts tests
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeWebexAccount,
  isWebexAccountConfigured,
  listWebexAccountIds,
  resolveDefaultWebexAccountId,
  resolveWebexAccount,
} from "./accounts.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import type { WebexConfig } from "./types.js";

describe("listWebexAccountIds", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.WEBEX_BOT_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return default when no webex config", () => {
    const cfg: MoltbotConfig = { channels: {} };
    const ids = listWebexAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("should return default when webex config is empty", () => {
    const cfg: MoltbotConfig = {
      channels: { webex: {} },
    };
    const ids = listWebexAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("should return default when single-account config with botToken", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          botToken: "test-token-" + "a".repeat(80),
        } as WebexConfig,
      },
    };
    const ids = listWebexAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("should return default when env token is set", () => {
    process.env.WEBEX_BOT_TOKEN = "env-token-" + "a".repeat(80);
    const cfg: MoltbotConfig = { channels: { webex: {} } };
    const ids = listWebexAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  it("should return account IDs from multi-account config", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          accounts: {
            support: { botToken: "token1" },
            internal: { botToken: "token2" },
          },
        } as WebexConfig,
      },
    };
    const ids = listWebexAccountIds(cfg);
    expect(ids).toEqual(["internal", "support"]); // sorted alphabetically
  });

  it("should include default when multi-account has base token", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          botToken: "base-token-" + "a".repeat(80),
          accounts: {
            other: { botToken: "other-token" },
          },
        } as WebexConfig,
      },
    };
    const ids = listWebexAccountIds(cfg);
    expect(ids).toContain("default");
    expect(ids).toContain("other");
  });
});

describe("resolveDefaultWebexAccountId", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WEBEX_BOT_TOKEN;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return default when no config", () => {
    const cfg: MoltbotConfig = { channels: {} };
    const id = resolveDefaultWebexAccountId(cfg);
    expect(id).toBe("default");
  });

  it("should return explicit defaultAccount when set", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          defaultAccount: "support",
          accounts: {
            support: { botToken: "token" },
            internal: { botToken: "token" },
          },
        } as WebexConfig,
      },
    };
    const id = resolveDefaultWebexAccountId(cfg);
    expect(id).toBe("support");
  });

  it("should trim defaultAccount whitespace", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          defaultAccount: "  support  ",
          accounts: { support: {} },
        } as WebexConfig,
      },
    };
    const id = resolveDefaultWebexAccountId(cfg);
    expect(id).toBe("support");
  });

  it("should prefer default ID when available", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          botToken: "token-" + "a".repeat(80),
          accounts: {
            other: { botToken: "token" },
          },
        } as WebexConfig,
      },
    };
    const id = resolveDefaultWebexAccountId(cfg);
    expect(id).toBe("default");
  });

  it("should return first account ID when no default", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          accounts: {
            zebra: { botToken: "token" },
            alpha: { botToken: "token" },
          },
        } as WebexConfig,
      },
    };
    const id = resolveDefaultWebexAccountId(cfg);
    expect(id).toBe("alpha"); // first alphabetically
  });
});

describe("resolveWebexAccount", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.WEBEX_BOT_TOKEN;
    delete process.env.WEBEX_BOT_ID;
    delete process.env.WEBEX_BOT_EMAIL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should resolve single-account config", () => {
    const longToken = "a".repeat(100);
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          enabled: true,
          botToken: longToken,
          webhookSecret: "secret123",
          webhookPath: "/webex",
        } as WebexConfig,
      },
    };
    const account = resolveWebexAccount({ cfg });
    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.botToken).toBe(longToken);
    expect(account.credentialSource).toBe("config");
    expect(account.config.webhookSecret).toBe("secret123");
  });

  it("should resolve env token for default account", () => {
    const envToken = "b".repeat(100);
    process.env.WEBEX_BOT_TOKEN = envToken;
    const cfg: MoltbotConfig = {
      channels: { webex: { enabled: true } as WebexConfig },
    };
    const account = resolveWebexAccount({ cfg });
    expect(account.botToken).toBe(envToken);
    expect(account.credentialSource).toBe("env");
  });

  it("should not use env token for non-default account", () => {
    process.env.WEBEX_BOT_TOKEN = "c".repeat(100);
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          accounts: {
            custom: { enabled: true },
          },
        } as WebexConfig,
      },
    };
    const account = resolveWebexAccount({ cfg, accountId: "custom" });
    expect(account.botToken).toBeUndefined();
    expect(account.credentialSource).toBe("none");
  });

  it("should merge base config with account-specific config", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          webhookSecret: "base-secret",
          groupPolicy: "allowlist",
          accounts: {
            support: {
              botToken: "d".repeat(100),
              webhookPath: "/webex/support",
            },
          },
        } as WebexConfig,
      },
    };
    const account = resolveWebexAccount({ cfg, accountId: "support" });
    expect(account.config.webhookSecret).toBe("base-secret"); // inherited
    expect(account.config.webhookPath).toBe("/webex/support"); // overridden
    expect(account.config.groupPolicy).toBe("allowlist"); // inherited
  });

  it("should return disabled account for unknown accountId", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          accounts: { known: { botToken: "e".repeat(100) } },
        } as WebexConfig,
      },
    };
    const account = resolveWebexAccount({ cfg, accountId: "unknown" });
    expect(account.enabled).toBe(false);
    expect(account.botToken).toBeUndefined();
  });

  it("should resolve botId from config", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          botToken: "f".repeat(100),
          botId: "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3QtaWQ",
        } as WebexConfig,
      },
    };
    const account = resolveWebexAccount({ cfg });
    expect(account.botId).toBe("Y2lzY29zcGFyazovL3VzL1BFT1BMRS9ib3QtaWQ");
  });

  it("should resolve botId from env for default account", () => {
    process.env.WEBEX_BOT_ID = "env-bot-id-123";
    process.env.WEBEX_BOT_TOKEN = "g".repeat(100);
    const cfg: MoltbotConfig = {
      channels: { webex: { enabled: true } as WebexConfig },
    };
    const account = resolveWebexAccount({ cfg });
    expect(account.botId).toBe("env-bot-id-123");
  });

  it("should resolve botEmail from env for default account", () => {
    process.env.WEBEX_BOT_EMAIL = "bot@webex.bot";
    process.env.WEBEX_BOT_TOKEN = "h".repeat(100);
    const cfg: MoltbotConfig = {
      channels: { webex: { enabled: true } as WebexConfig },
    };
    const account = resolveWebexAccount({ cfg });
    expect(account.botEmail).toBe("bot@webex.bot");
  });

  it("should merge dm config from base and account", () => {
    const cfg: MoltbotConfig = {
      channels: {
        webex: {
          dm: { policy: "allowlist", allowFrom: ["base@example.com"] },
          accounts: {
            support: {
              botToken: "i".repeat(100),
              dm: { allowFrom: ["support@example.com"] },
            },
          },
        } as WebexConfig,
      },
    };
    const account = resolveWebexAccount({ cfg, accountId: "support" });
    // Policy inherited, allowFrom overridden
    expect(account.config.dm?.policy).toBe("allowlist");
    expect(account.config.dm?.allowFrom).toEqual(["support@example.com"]);
  });
});

describe("isWebexAccountConfigured", () => {
  it("should return true when account has token and source", () => {
    const account = {
      accountId: "default",
      enabled: true,
      config: {},
      credentialSource: "config" as const,
      botToken: "valid-token",
    };
    expect(isWebexAccountConfigured(account)).toBe(true);
  });

  it("should return false when no token", () => {
    const account = {
      accountId: "default",
      enabled: true,
      config: {},
      credentialSource: "config" as const,
      botToken: undefined,
    };
    expect(isWebexAccountConfigured(account)).toBe(false);
  });

  it("should return false when source is none", () => {
    const account = {
      accountId: "default",
      enabled: true,
      config: {},
      credentialSource: "none" as const,
      botToken: undefined,
    };
    expect(isWebexAccountConfigured(account)).toBe(false);
  });
});

describe("describeWebexAccount", () => {
  it("should describe configured account", () => {
    const account = {
      accountId: "support",
      name: "Support Bot",
      enabled: true,
      config: {},
      credentialSource: "config" as const,
      botToken: "valid-token",
    };
    const desc = describeWebexAccount(account);
    expect(desc).toEqual({
      accountId: "support",
      name: "Support Bot",
      enabled: true,
      configured: true,
      credentialSource: "config",
    });
  });

  it("should describe unconfigured account", () => {
    const account = {
      accountId: "default",
      enabled: false,
      config: {},
      credentialSource: "none" as const,
      botToken: undefined,
    };
    const desc = describeWebexAccount(account);
    expect(desc).toEqual({
      accountId: "default",
      name: undefined,
      enabled: false,
      configured: false,
      credentialSource: "none",
    });
  });

  it("should describe env-configured account", () => {
    const account = {
      accountId: "default",
      enabled: true,
      config: {},
      credentialSource: "env" as const,
      botToken: "env-token",
    };
    const desc = describeWebexAccount(account);
    expect(desc.configured).toBe(true);
    expect(desc.credentialSource).toBe("env");
  });
});
