import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  applySetupAccountConfigPatch,
  createEnvPatchedAccountSetupAdapter,
  createPatchedAccountSetupAdapter,
  moveSingleAccountChannelSectionToDefaultAccount,
  prepareScopedSetupConfig,
} from "./setup-helpers.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

function requireRecord(value: unknown): Record<string, unknown> {
  expect(value).toBeTruthy();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

function channelRecord(cfg: OpenClawConfig, channelKey: string): Record<string, unknown> {
  return requireRecord(cfg.channels?.[channelKey]);
}

function accountsRecord(channel: Record<string, unknown>): Record<string, unknown> {
  return requireRecord(channel.accounts);
}

function accountRecord(
  channel: Record<string, unknown>,
  accountId: string,
): Record<string, unknown> {
  return requireRecord(accountsRecord(channel)[accountId]);
}

const matrixSingleAccountKeysToMove = [
  "allowBots",
  "deviceId",
  "deviceName",
  "encryption",
] as const;
const matrixNamedAccountPromotionKeys = [
  "accessToken",
  "deviceId",
  "deviceName",
  "encryption",
  "homeserver",
  "userId",
] as const;
const telegramSingleAccountKeysToMove = ["streaming"] as const;

function collectNamedAccountIds(accounts: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const accountId of Object.keys(accounts)) {
    if (accountId) {
      ids.push(accountId);
    }
  }
  return ids;
}

function resolveMatrixSingleAccountPromotionTarget(params: {
  channel: { defaultAccount?: string; accounts?: Record<string, unknown> };
}): string {
  const accounts = params.channel.accounts ?? {};
  const normalizedDefaultAccount = params.channel.defaultAccount?.trim()
    ? normalizeAccountId(params.channel.defaultAccount)
    : undefined;
  if (normalizedDefaultAccount) {
    return (
      Object.keys(accounts).find(
        (accountId) => normalizeAccountId(accountId) === normalizedDefaultAccount,
      ) ?? DEFAULT_ACCOUNT_ID
    );
  }
  const namedAccounts = collectNamedAccountIds(accounts);
  return namedAccounts.length === 1 ? namedAccounts[0] : DEFAULT_ACCOUNT_ID;
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "matrix",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
          setup: {
            singleAccountKeysToMove: matrixSingleAccountKeysToMove,
            namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
            resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
          },
        },
      },
      {
        pluginId: "telegram",
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
          setup: {
            singleAccountKeysToMove: telegramSingleAccountKeysToMove,
          },
        },
      },
    ]),
  );
});

afterAll(() => {
  resetPluginRuntimeStateForTest();
});

describe("applySetupAccountConfigPatch", () => {
  it("patches top-level config for default account and enables channel", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            webhookPath: "/old",
            enabled: false,
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: DEFAULT_ACCOUNT_ID,
      patch: { webhookPath: "/new", botToken: "tok" },
    });

    const channel = channelRecord(next, "demo-setup");
    expect(channel.enabled).toBe(true);
    expect(channel.webhookPath).toBe("/new");
    expect(channel.botToken).toBe("tok");
  });

  it("patches named account config and preserves existing account enabled flag", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            enabled: false,
            accounts: {
              work: { botToken: "old", enabled: false },
            },
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: "work",
      patch: { botToken: "new" },
    });

    const channel = channelRecord(next, "demo-setup");
    const work = accountRecord(channel, "work");
    expect(channel.enabled).toBe(true);
    expect(work.enabled).toBe(false);
    expect(work.botToken).toBe("new");
  });

  it("normalizes account id and preserves other accounts", () => {
    const next = applySetupAccountConfigPatch({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            accounts: {
              personal: { botToken: "personal-token" },
            },
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: "Work Team",
      patch: { botToken: "work-token" },
    });

    const channel = channelRecord(next, "demo-setup");
    const personal = accountRecord(channel, "personal");
    const workTeam = accountRecord(channel, "work-team");
    expect(personal.botToken).toBe("personal-token");
    expect(workTeam.enabled).toBe(true);
    expect(workTeam.botToken).toBe("work-token");
  });
});

describe("createPatchedAccountSetupAdapter", () => {
  it("stores default-account patch at channel root", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-setup",
      buildPatch: (input) => ({ botToken: input.token }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({ channels: { "demo-setup": { enabled: false } } }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Personal", token: "tok" },
    });

    const channel = channelRecord(next, "demo-setup");
    expect(channel.enabled).toBe(true);
    expect(channel.name).toBe("Personal");
    expect(channel.botToken).toBe("tok");
  });

  it("migrates base name into the default account before patching a named account", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-setup",
      buildPatch: (input) => ({ botToken: input.token }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            name: "Personal",
            accounts: {
              work: { botToken: "old" },
            },
          },
        },
      }),
      accountId: "Work Team",
      input: { name: "Work", token: "new" },
    });

    const channel = channelRecord(next, "demo-setup");
    const defaultAccount = accountRecord(channel, "default");
    const work = accountRecord(channel, "work");
    const workTeam = accountRecord(channel, "work-team");
    expect(defaultAccount.name).toBe("Personal");
    expect(work.botToken).toBe("old");
    expect(workTeam.enabled).toBe(true);
    expect(workTeam.name).toBe("Work");
    expect(workTeam.botToken).toBe("new");
    expect(next.channels?.["demo-setup"]).not.toHaveProperty("name");
  });

  it("can store the default account in accounts.default", () => {
    const adapter = createPatchedAccountSetupAdapter({
      channelKey: "demo-accounts",
      alwaysUseAccounts: true,
      buildPatch: (input) => ({ authDir: input.authDir }),
    });

    const next = adapter.applyAccountConfig({
      cfg: asConfig({ channels: { "demo-accounts": {} } }),
      accountId: DEFAULT_ACCOUNT_ID,
      input: { name: "Phone", authDir: "/tmp/auth" },
    });

    const channel = channelRecord(next, "demo-accounts");
    const defaultAccount = accountRecord(channel, "default");
    expect(defaultAccount.enabled).toBe(true);
    expect(defaultAccount.name).toBe("Phone");
    expect(defaultAccount.authDir).toBe("/tmp/auth");
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("enabled");
    expect(next.channels?.["demo-accounts"]).not.toHaveProperty("authDir");
  });
});

describe("moveSingleAccountChannelSectionToDefaultAccount", () => {
  it("moves Matrix allowBots into the promoted default account", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "token",
            allowBots: "mentions",
          },
        },
      }),
      channelKey: "matrix",
    });

    const channel = channelRecord(next, "matrix");
    const defaultAccount = accountRecord(channel, "default");
    expect(defaultAccount.homeserver).toBe("https://matrix.example.org");
    expect(defaultAccount.userId).toBe("@bot:example.org");
    expect(defaultAccount.accessToken).toBe("token");
    expect(defaultAccount.allowBots).toBe("mentions");
    expect(next.channels?.matrix?.allowBots).toBeUndefined();
  });

  it("promotes legacy Matrix keys into the sole named account when defaultAccount is unset", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            homeserver: "https://matrix.example.org",
            userId: "@bot:example.org",
            accessToken: "token",
            accounts: {
              main: {
                enabled: true,
              },
            },
          },
        },
      }),
      channelKey: "matrix",
    });

    const channel = channelRecord(next, "matrix");
    const main = accountRecord(channel, "main");
    expect(main.enabled).toBe(true);
    expect(main.homeserver).toBe("https://matrix.example.org");
    expect(main.userId).toBe("@bot:example.org");
    expect(main.accessToken).toBe("token");
    expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
  });

  it("promotes legacy Matrix keys into an existing non-canonical default account key", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            defaultAccount: "ops",
            homeserver: "https://matrix.example.org",
            userId: "@ops:example.org",
            accessToken: "token",
            accounts: {
              Ops: {
                enabled: true,
              },
            },
          },
        },
      }),
      channelKey: "matrix",
    });

    const channel = channelRecord(next, "matrix");
    const ops = accountRecord(channel, "Ops");
    expect(channel.defaultAccount).toBe("ops");
    expect(ops.enabled).toBe(true);
    expect(ops.homeserver).toBe("https://matrix.example.org");
    expect(ops.userId).toBe("@ops:example.org");
    expect(ops.accessToken).toBe("token");
    expect(next.channels?.matrix?.accounts?.ops).toBeUndefined();
    expect(next.channels?.matrix?.accounts?.default).toBeUndefined();
    expect(next.channels?.matrix?.homeserver).toBeUndefined();
    expect(next.channels?.matrix?.userId).toBeUndefined();
    expect(next.channels?.matrix?.accessToken).toBeUndefined();
  });
});

describe("createEnvPatchedAccountSetupAdapter", () => {
  it("rejects env mode for named accounts and requires credentials otherwise", () => {
    const adapter = createEnvPatchedAccountSetupAdapter({
      channelKey: "demo-env",
      defaultAccountOnlyEnvError: "env only on default",
      missingCredentialError: "token required",
      hasCredentials: (input) => Boolean(input.token || input.tokenFile),
      buildPatch: (input) => ({ token: input.token }),
    });

    expect(
      adapter.validateInput?.({
        cfg: asConfig({}),
        accountId: "work",
        input: { useEnv: true },
      }),
    ).toBe("env only on default");

    expect(
      adapter.validateInput?.({
        cfg: asConfig({}),
        accountId: DEFAULT_ACCOUNT_ID,
        input: {},
      }),
    ).toBe("token required");

    expect(
      adapter.validateInput?.({
        cfg: asConfig({}),
        accountId: DEFAULT_ACCOUNT_ID,
        input: { token: "tok" },
      }),
    ).toBeNull();
  });
});

describe("prepareScopedSetupConfig", () => {
  it("stores the name and migrates it for named accounts when requested", () => {
    const next = prepareScopedSetupConfig({
      cfg: asConfig({
        channels: {
          "demo-scoped": {
            name: "Personal",
          },
        },
      }),
      channelKey: "demo-scoped",
      accountId: "Work Team",
      name: "Work",
      migrateBaseName: true,
    });

    const channel = channelRecord(next, "demo-scoped");
    const defaultAccount = accountRecord(channel, "default");
    const workTeam = accountRecord(channel, "work-team");
    expect(defaultAccount.name).toBe("Personal");
    expect(workTeam.name).toBe("Work");
    expect(next.channels?.["demo-scoped"]).not.toHaveProperty("name");
  });

  it("keeps the base shape for the default account when migration is disabled", () => {
    const next = prepareScopedSetupConfig({
      cfg: asConfig({ channels: { "demo-base": { enabled: true } } }),
      channelKey: "demo-base",
      accountId: DEFAULT_ACCOUNT_ID,
      name: "Libera",
    });

    const channel = channelRecord(next, "demo-base");
    expect(channel.enabled).toBe(true);
    expect(channel.name).toBe("Libera");
  });
});
