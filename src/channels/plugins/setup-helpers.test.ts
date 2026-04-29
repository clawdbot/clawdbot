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
  const namedAccounts = Object.keys(accounts).filter(Boolean);
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

    expect(next.channels?.["demo-setup"]).toMatchObject({
      enabled: true,
      webhookPath: "/new",
      botToken: "tok",
    });
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

    expect(next.channels?.["demo-setup"]).toMatchObject({
      enabled: true,
      accounts: {
        work: { enabled: false, botToken: "new" },
      },
    });
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

    expect(next.channels?.["demo-setup"]).toMatchObject({
      accounts: {
        personal: { botToken: "personal-token" },
        "work-team": { enabled: true, botToken: "work-token" },
      },
    });
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

    expect(next.channels?.["demo-setup"]).toMatchObject({
      enabled: true,
      name: "Personal",
      botToken: "tok",
    });
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

    expect(next.channels?.["demo-setup"]).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        work: { botToken: "old" },
        "work-team": { enabled: true, name: "Work", botToken: "new" },
      },
    });
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

    expect(next.channels?.["demo-accounts"]).toMatchObject({
      accounts: {
        default: {
          enabled: true,
          name: "Phone",
          authDir: "/tmp/auth",
        },
      },
    });
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

    expect(next.channels?.matrix).toMatchObject({
      accounts: {
        default: {
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "token",
          allowBots: "mentions",
        },
      },
    });
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

    expect(next.channels?.matrix).toMatchObject({
      accounts: {
        main: {
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@bot:example.org",
          accessToken: "token",
        },
      },
    });
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

    expect(next.channels?.matrix).toMatchObject({
      defaultAccount: "ops",
      accounts: {
        Ops: {
          enabled: true,
          homeserver: "https://matrix.example.org",
          userId: "@ops:example.org",
          accessToken: "token",
        },
      },
    });
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

    expect(next.channels?.["demo-scoped"]).toMatchObject({
      accounts: {
        default: { name: "Personal" },
        "work-team": { name: "Work" },
      },
    });
    expect(next.channels?.["demo-scoped"]).not.toHaveProperty("name");
  });

  it("keeps the base shape for the default account when migration is disabled", () => {
    const next = prepareScopedSetupConfig({
      cfg: asConfig({ channels: { "demo-base": { enabled: true } } }),
      channelKey: "demo-base",
      accountId: DEFAULT_ACCOUNT_ID,
      name: "Libera",
    });

    expect(next.channels?.["demo-base"]).toMatchObject({
      enabled: true,
      name: "Libera",
    });
  });
});
