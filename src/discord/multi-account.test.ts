import { describe, expect, it } from "vitest";
import { type MoltbotConfig } from "../config/config.js";
import { listDiscordAccountIds } from "./accounts.js";
import { resolveDiscordToken } from "./token.js";

describe("discord multi-account logic", () => {
  it("should list all configured accounts", () => {
    const config = {
      channels: {
        discord: {
          accounts: {
            bot_a: { token: "token_a", enabled: true },
            bot_b: { token: "token_b", enabled: true },
            bot_c: { token: "token_c", enabled: false },
          },
        },
      },
    } as unknown as MoltbotConfig;

    const ids = listDiscordAccountIds(config);
    expect(ids).toEqual(["bot_a", "bot_b", "bot_c"]);
  });

  it("should resolve specific account tokens", () => {
    const config = {
      channels: {
        discord: {
          accounts: {
            bot_a: { token: "token_a" },
            bot_b: { token: "token_b" },
          },
        },
      },
    } as unknown as MoltbotConfig;

    const tokenA = resolveDiscordToken(config, { accountId: "bot_a" });
    const tokenB = resolveDiscordToken(config, { accountId: "bot_b" });
    const tokenUnknown = resolveDiscordToken(config, { accountId: "bot_unknown" });

    expect(tokenA.token).toBe("token_a");
    expect(tokenB.token).toBe("token_b");
    expect(tokenUnknown.token).toBe("");
  });

  it("should fall back to default token if no account token specified", () => {
    const config = {
      channels: {
        discord: {
          token: "default_token",
          accounts: {
            bot_a: {},
          },
        },
      },
    } as unknown as MoltbotConfig;

    const tokenA = resolveDiscordToken(config, { accountId: "bot_a" });

    expect(tokenA.token).toBe("");
  });

  it("should include default account if top-level token is present", () => {
    const config = {
      channels: {
        discord: {
          token: "default_token",
          accounts: {
            bot_a: { token: "token_a" },
          },
        },
      },
    } as unknown as MoltbotConfig;

    const ids = listDiscordAccountIds(config);
    expect(ids).toContain("default");
    expect(ids).toContain("bot_a");
  });

  it("should resolve default account correctly", () => {
    const config = {
      channels: {
        discord: {
          token: "default_token",
        },
      },
    } as unknown as MoltbotConfig;

    const token = resolveDiscordToken(config, { accountId: "default" });
    expect(token.token).toBe("default_token");
  });
});
