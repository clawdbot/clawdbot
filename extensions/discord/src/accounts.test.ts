// Discord tests cover accounts plugin behavior.
import type {
  DiscordAccountConfig,
  DiscordConfig,
  OpenClawConfig,
} from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDiscordActionGate,
  isDiscordAccountEnabledForRuntime,
  listDiscordAccountIds,
  listEnabledDiscordAccounts,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccount,
  resolveDiscordAccountDisabledReason,
  resolveDiscordMaxLinesPerMessage,
} from "./accounts.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

describe("Discord defaultAccount omission contract", () => {
  it.each([
    {
      name: "resolveDiscordAccount",
      assert: () => {
        const resolved = resolveDiscordAccount({
          cfg: {
            channels: {
              discord: {
                defaultAccount: "work",
                accounts: { work: { token: "token-work", name: "Work" } },
              },
            },
          },
        });

        expect(resolved.accountId).toBe("work");
        expect(resolved.name).toBe("Work");
        expect(resolved.token).toBe("token-work");
      },
    },
    {
      name: "createDiscordActionGate",
      assert: () => {
        const gate = createDiscordActionGate({
          cfg: {
            channels: {
              discord: {
                actions: { reactions: false },
                defaultAccount: "work",
                accounts: {
                  work: { token: "token-work", actions: { reactions: true } },
                },
              },
            },
          },
        });

        expect(gate("reactions")).toBe(true);
      },
    },
  ])("$name uses configured defaultAccount when accountId is omitted", ({ assert }) => {
    assert();
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = {
      channels: {
        discord: {
          token: "token-default",
          accounts: { work: { enabled: false, token: "token-work" } },
        },
      },
    } as OpenClawConfig;

    expect(listDiscordAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultDiscordAccountId(cfg)).toBe("default");
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual([
      "default",
    ]);
  });
});

describe("resolveDiscordAccount allowFrom precedence", () => {
  it.each<{
    name: string;
    discord: DiscordConfig;
    accountId: string;
    expected: string[];
  }>([
    {
      name: "prefers accounts.default.allowFrom over top-level for default account",
      discord: {
        allowFrom: ["top"],
        accounts: { default: { allowFrom: ["default"], token: "token-default" } },
      },
      accountId: "default",
      expected: ["default"],
    },
    {
      name: "falls back to top-level allowFrom for named account without override",
      discord: {
        allowFrom: ["top"],
        accounts: { work: { token: "token-work" } },
      },
      accountId: "work",
      expected: ["top"],
    },
  ])("$name", ({ discord, accountId, expected }) => {
    const resolved = resolveDiscordAccount({
      cfg: { channels: { discord } },
      accountId,
    });

    expect(resolved.config.allowFrom).toEqual(expected);
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            accounts: {
              default: { allowFrom: ["default"], token: "token-default" },
              work: { token: "token-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });
});

describe("resolveDiscordAccount botLoopProtection precedence", () => {
  it("merges account overrides over Discord channel defaults field-by-field", () => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            botLoopProtection: {
              maxEventsPerWindow: 4,
              windowSeconds: 60,
              cooldownSeconds: 30,
            },
            accounts: {
              work: { token: "token-work", botLoopProtection: { windowSeconds: 10 } },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.botLoopProtection).toEqual({
      maxEventsPerWindow: 4,
      windowSeconds: 10,
      cooldownSeconds: 30,
    });
  });
});

describe("resolveDiscordAccount agentComponents precedence", () => {
  it.each<{
    name: string;
    root: NonNullable<DiscordAccountConfig["agentComponents"]>;
    account: NonNullable<DiscordAccountConfig["agentComponents"]>;
    expected: NonNullable<DiscordAccountConfig["agentComponents"]>;
  }>([
    {
      name: "preserves a disabled channel default when an account only overrides ttlMs",
      root: { enabled: false },
      account: { ttlMs: 120_000 },
      expected: { enabled: false, ttlMs: 120_000 },
    },
    {
      name: "preserves channel ttlMs when an account only overrides enabled",
      root: { enabled: false, ttlMs: 180_000 },
      account: { enabled: true },
      expected: { enabled: true, ttlMs: 180_000 },
    },
  ])("$name", ({ root, account, expected }) => {
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            agentComponents: root,
            accounts: { work: { token: "token-work", agentComponents: account } },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.agentComponents).toEqual(expected);
  });
});

describe("resolveDiscordMaxLinesPerMessage", () => {
  it.each<{
    name: string;
    accounts: Record<string, DiscordAccountConfig>;
    discordConfig: Pick<DiscordConfig, "maxLinesPerMessage">;
    accountId: string;
    expected: number;
  }>([
    {
      name: "falls back to merged root discord maxLinesPerMessage when runtime config omits it",
      accounts: { default: { token: "token-default" } },
      discordConfig: {},
      accountId: "default",
      expected: 120,
    },
    {
      name: "prefers explicit runtime discord maxLinesPerMessage over merged config",
      accounts: { default: { token: "token-default", maxLinesPerMessage: 80 } },
      discordConfig: { maxLinesPerMessage: 55 },
      accountId: "default",
      expected: 55,
    },
    {
      name: "uses per-account discord maxLinesPerMessage over the root value when runtime config omits it",
      accounts: { work: { token: "token-work", maxLinesPerMessage: 80 } },
      discordConfig: {},
      accountId: "work",
      expected: 80,
    },
  ])("$name", ({ accounts, discordConfig, accountId, expected }) => {
    const resolved = resolveDiscordMaxLinesPerMessage({
      cfg: { channels: { discord: { maxLinesPerMessage: 120, accounts } } },
      discordConfig,
      accountId,
    });

    expect(resolved).toBe(expected);
  });
});

describe("Discord duplicate-token account filtering", () => {
  it.each<{
    name: string;
    accounts: Record<string, DiscordAccountConfig>;
    accountId: string;
    duplicateId: string;
    environmentToken?: string;
    expectedReason: string;
  }>([
    {
      name: "keeps the config-token account over default env fallback when tokens collide",
      accounts: { work: { token: "same-token" } },
      accountId: "work",
      duplicateId: "default",
      environmentToken: "same-token",
      expectedReason: 'duplicate bot token; using account "work"',
    },
    {
      name: "keeps the first enabled account when duplicate tokens have the same source",
      accounts: {
        first: { token: "same-token" },
        second: { token: "same-token" },
      },
      accountId: "first",
      duplicateId: "second",
      expectedReason: 'duplicate bot token; using account "first"',
    },
  ])("$name", ({ accounts, accountId, duplicateId, environmentToken, expectedReason }) => {
    if (environmentToken) {
      vi.stubEnv("DISCORD_BOT_TOKEN", environmentToken);
    }
    const cfg = { channels: { discord: { accounts } } };
    const enabledAccount = resolveDiscordAccount({ cfg, accountId });
    const duplicateAccount = resolveDiscordAccount({ cfg, accountId: duplicateId });

    expect(isDiscordAccountEnabledForRuntime(duplicateAccount, cfg)).toBe(false);
    expect(resolveDiscordAccountDisabledReason(duplicateAccount, cfg)).toBe(expectedReason);
    expect(isDiscordAccountEnabledForRuntime(enabledAccount, cfg)).toBe(true);
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual([
      accountId,
    ]);
  });

  it("does not let disabled duplicate-token accounts suppress enabled accounts", () => {
    const cfg = {
      channels: {
        discord: {
          accounts: {
            disabled: { enabled: false, token: "same-token" },
            active: { token: "same-token" },
          },
        },
      },
    };

    const activeAccount = resolveDiscordAccount({ cfg, accountId: "active" });

    expect(isDiscordAccountEnabledForRuntime(activeAccount, cfg)).toBe(true);
    expect(listEnabledDiscordAccounts(cfg).map((account) => account.accountId)).toEqual(["active"]);
  });
});

describe("resolveDiscordAccount runtime config selection", () => {
  it("resolves named account SecretRefs from the active runtime snapshot", () => {
    const sourceCfg = {
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: {
            work: {
              name: "Work",
              token: { source: "env", provider: "default", id: "DISCORD_WORK_TOKEN" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const runtimeCfg = {
      channels: {
        discord: {
          defaultAccount: "work",
          accounts: { work: { name: "Work", token: "Bot runtime-work-token" } },
        },
      },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(runtimeCfg, sourceCfg);

    const resolved = resolveDiscordAccount({ cfg: sourceCfg });

    expect(resolved.accountId).toBe("work");
    expect(resolved.token).toBe("runtime-work-token");
    expect(resolved.tokenSource).toBe("config");
    expect(resolved.tokenStatus).toBe("available");
  });

  it("preserves configured unavailable tokens without falling through to env", () => {
    vi.stubEnv("DISCORD_BOT_TOKEN", "env-token");
    const resolved = resolveDiscordAccount({
      cfg: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
          },
        },
      } as unknown as OpenClawConfig,
      accountId: "default",
    });

    expect(resolved.token).toBe("");
    expect(resolved.tokenSource).toBe("config");
    expect(resolved.tokenStatus).toBe("configured_unavailable");
  });
});
