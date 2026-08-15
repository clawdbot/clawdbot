import { describe, expect, it } from "vitest";
import { mergeTelegramAccountConfig } from "./account-config.js";
import {
  resolveTelegramDirectToolPolicy,
  resolveTelegramScopedGroupConfig,
} from "./group-config-helpers.js";

describe("resolveTelegramDirectToolPolicy", () => {
  it("leaves tool access unchanged without a direct policy", () => {
    expect(resolveTelegramDirectToolPolicy({})).toBeUndefined();
  });

  it("prefers sender policy and matches the Telegram provider", () => {
    const directConfig = {
      tools: { deny: ["write"] },
      toolsBySender: {
        "channel:telegram:42": { deny: ["exec"] },
        "channel:discord:42": { deny: ["read"] },
        "*": { deny: ["process"] },
      },
    };

    expect(resolveTelegramDirectToolPolicy({ directConfig, senderId: "42" })).toEqual({
      deny: ["exec"],
    });
    expect(resolveTelegramDirectToolPolicy({ directConfig, senderId: "7" })).toEqual({
      deny: ["process"],
    });
  });

  it("lets an explicit empty sender policy mask direct tools", () => {
    expect(
      resolveTelegramDirectToolPolicy({
        directConfig: {
          tools: { deny: ["write"] },
          toolsBySender: { "id:42": {} },
        },
        senderId: "42",
      }),
    ).toEqual({});
  });
});

describe("Telegram direct config precedence", () => {
  it("uses whole-entry exact-over-wildcard replacement", () => {
    const account = {
      direct: {
        "*": { tools: { deny: ["write"] } },
        "42": {},
      },
    };

    const wildcard = resolveTelegramScopedGroupConfig(account, 7).groupConfig;
    const exact = resolveTelegramScopedGroupConfig(account, 42).groupConfig;

    expect(resolveTelegramDirectToolPolicy({ directConfig: wildcard })).toEqual({
      deny: ["write"],
    });
    expect(resolveTelegramDirectToolPolicy({ directConfig: exact })).toBeUndefined();
  });

  it("inherits root direct config only when the account omits direct", () => {
    const rootDirect = { "*": { tools: { deny: ["write"] } } };
    const base = {
      channels: {
        telegram: {
          direct: rootDirect,
          accounts: { inherited: {}, replaced: { direct: {} } },
        },
      },
    };

    expect(mergeTelegramAccountConfig(base, "inherited").direct).toBe(rootDirect);
    expect(mergeTelegramAccountConfig(base, "replaced").direct).toEqual({});
  });
});
