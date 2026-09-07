import { expectDefined } from "@openclaw/normalization-core";
// Setup helper tests cover channel setup helper outputs and lifecycle cleanup.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
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
  patchScopedAccountConfig,
  prepareScopedSetupConfig,
} from "./setup-helpers.js";
import type { ChannelSetupAdapter } from "./types.adapters.js";

function asConfig(value: unknown): OpenClawConfig {
  return value as OpenClawConfig;
}

const requireRecord = createRequireRecord("record", "expected-non-array-record");

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
  "homeserver",
  "userId",
  "accessToken",
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
const matrixSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  singleAccountKeysToMove: matrixSingleAccountKeysToMove,
  namedAccountPromotionKeys: matrixNamedAccountPromotionKeys,
  resolveSingleAccountPromotionTarget: resolveMatrixSingleAccountPromotionTarget,
} as ChannelSetupAdapter;
// Signal declares `account` as a key to move and the case-insensitive lookup
// (extensions/signal/src/setup-core.ts). A core test does not import the extension, so this
// surface carries those two declarations.
const signalSetupSurface = {
  applyAccountConfig: ({ cfg }) => cfg,
  accountEntryLookup: "case-insensitive",
  singleAccountKeysToMove: ["account"],
} as ChannelSetupAdapter;

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
  return namedAccounts.length === 1
    ? expectDefined(namedAccounts[0], "namedAccounts[0] test invariant")
    : DEFAULT_ACCOUNT_ID;
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

describe("patchScopedAccountConfig credential clearing", () => {
  it("clears only default-account credential fields before applying their replacement", () => {
    const next = patchScopedAccountConfig({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            enabled: false,
            token: "old-token",
            tokenFile: "/old/token",
            webhookPath: "/keep",
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: DEFAULT_ACCOUNT_ID,
      clearFields: ["token", "tokenFile"],
      patch: { token: "new-token" },
      ensureChannelEnabled: false,
    });

    expect(channelRecord(next, "demo-setup")).toEqual({
      enabled: false,
      token: "new-token",
      webhookPath: "/keep",
    });
  });

  it("clears only selected named-account credentials and preserves disabled siblings", () => {
    const next = patchScopedAccountConfig({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            enabled: false,
            token: "root-token",
            accounts: {
              work: { enabled: false, token: "old-token", tokenFile: "/old/token" },
              alerts: { enabled: false, token: "alerts-token" },
            },
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: "work",
      clearFields: ["token", "tokenFile"],
      patch: { token: "new-token" },
      ensureChannelEnabled: false,
      ensureAccountEnabled: false,
    });

    const channel = channelRecord(next, "demo-setup");
    expect(channel.enabled).toBe(false);
    expect(channel.token).toBe("root-token");
    expect(accountRecord(channel, "work")).toEqual({ enabled: false, token: "new-token" });
    expect(accountRecord(channel, "alerts")).toEqual({
      enabled: false,
      token: "alerts-token",
    });
  });

  it("allows setup to explicitly re-enable an existing disabled named account", () => {
    const next = patchScopedAccountConfig({
      cfg: asConfig({
        channels: {
          "demo-setup": {
            enabled: false,
            accounts: { work: { enabled: false, tokenFile: "/old/token" } },
          },
        },
      }),
      channelKey: "demo-setup",
      accountId: "work",
      patch: { token: "new-token" },
      accountPatch: { enabled: true, token: "new-token" },
      clearFields: ["tokenFile"],
      ensureChannelEnabled: true,
      ensureAccountEnabled: false,
    });

    const channel = channelRecord(next, "demo-setup");
    expect(channel.enabled).toBe(true);
    expect(accountRecord(channel, "work")).toEqual({ enabled: true, token: "new-token" });
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
  it.each([undefined, {}])(
    "seeds an empty default for ordinary single-account promotion: %j",
    (accounts) => {
      const cfg = asConfig({
        channels: { demo: { enabled: true, ...(accounts ? { accounts } : {}) } },
      });
      const next = moveSingleAccountChannelSectionToDefaultAccount({ cfg, channelKey: "demo" });
      expect(next.channels?.demo).toEqual({ enabled: true, accounts: { default: {} } });
      expect(cfg.channels?.demo).toEqual({ enabled: true, ...(accounts ? { accounts } : {}) });
    },
  );

  it.each([undefined, {}, { ada: { enabled: true } }])(
    "does not create an empty default for explicit preserve-root: %j",
    (accounts) => {
      const cfg = asConfig({
        channels: { demo: { enabled: true, ...(accounts ? { accounts } : {}) } },
      });
      expect(
        moveSingleAccountChannelSectionToDefaultAccount({
          cfg,
          channelKey: "demo",
          setupSurface: {
            configPromotion: "preserve-root",
            applyAccountConfig: ({ cfg: currentConfig }) => currentConfig,
          },
        }),
      ).toBe(cfg);
    },
  );

  it("does not add a default when an ordinary named account already exists and no keys move", () => {
    const cfg = asConfig({ channels: { demo: { enabled: true, accounts: { ada: {} } } } });
    expect(moveSingleAccountChannelSectionToDefaultAccount({ cfg, channelKey: "demo" })).toBe(cfg);
  });

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
      setupSurface: matrixSetupSurface,
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
      setupSurface: matrixSetupSurface,
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

  it("preserves explicit named-account values over promoted root defaults", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          zalouser: {
            dmPolicy: "disabled",
            accounts: {
              work: {
                dmPolicy: "allowlist",
              },
            },
          },
        },
      }),
      channelKey: "zalouser",
    });

    const channel = channelRecord(next, "zalouser");
    const work = accountRecord(channel, "work");
    expect(work.dmPolicy).toBe("allowlist");
    expect(next.channels?.zalouser?.dmPolicy).toBeUndefined();
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
      setupSurface: matrixSetupSurface,
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

  it("promotes root keys into the canonical id when a case-insensitive channel holds only an alias key", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          signal: { account: "+15555550100", accounts: { "Default.": { account: "" } } },
        },
      }),
      channelKey: "signal",
      setupSurface: signalSetupSurface,
    });

    // resolveAccountEntry takes the exact key, else the first case-folded key
    // (src/routing/account-lookup.ts:8-23), so Signal's resolver never selects "Default.".
    // Promoting into it would strand the number, and because that entry already carries an empty
    // `account`, the root value would be deleted without being copied
    // (moveSingleAccountKeysIntoAccount skips a present key and deletes the root key regardless).
    const channel = channelRecord(next, "signal");
    expect(accountRecord(channel, "default").account).toBe("+15555550100");
    expect(accountRecord(channel, "Default.")).toEqual({ account: "" });
    expect(channel.account).toBeUndefined();
  });

  it("case-folds a padded key the way the case-insensitive lookup does", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          signal: { account: "+15555550100", accounts: { " Default ": { name: "Primary" } } },
        },
      }),
      channelKey: "signal",
      setupSurface: signalSetupSurface,
    });

    // resolveAccountEntry compares keys through normalizeLowercaseStringOrEmpty, which trims
    // before it lowercases (src/routing/account-lookup.ts:18-22,
    // packages/normalization-core/src/string-coerce.ts:7-17,65-68), so Signal selects " Default "
    // for the id "default". A writer that only lowercased would miss that key and seed a canonical
    // twin holding the number, and the twin would win the reader's exact-key branch and hide the
    // authored name.
    const channel = channelRecord(next, "signal");
    expect(accountRecord(channel, " Default ")).toEqual({
      name: "Primary",
      account: "+15555550100",
    });
    expect(accountsRecord(channel).default).toBeUndefined();
    expect(channel.account).toBeUndefined();
  });

  it("keeps promoting into a key the normalized lookup selects when the channel declares nothing", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          telegram: { botToken: "root-tok", accounts: { "Work.Bot": { name: "Work" } } },
        },
      }),
      channelKey: "telegram",
      setupSurface: {
        applyAccountConfig: ({ cfg }) => cfg,
        singleAccountKeysToMove: ["botToken"],
      } as ChannelSetupAdapter,
    });

    // Telegram reads its map with resolveNormalizedAccountEntry
    // (extensions/telegram/src/account-config.ts:15, src/routing/account-lookup.ts:27-51), which
    // selects "Work.Bot" for the id "work-bot". A canonical "work-bot" twin would win that
    // lookup's exact-key branch and hide the authored name, so the token has to land in the
    // authored key.
    const channel = channelRecord(next, "telegram");
    expect(accountRecord(channel, "Work.Bot")).toEqual({ name: "Work", botToken: "root-tok" });
    expect(accountsRecord(channel)["work-bot"]).toBeUndefined();
    expect(channel.botToken).toBeUndefined();
  });

  it("prefers the exact key over an alias listed first when the channel declares nothing", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          telegram: {
            botToken: "root-tok",
            accounts: { Default: { name: "Alias" }, default: { name: "Canon" } },
          },
        },
      }),
      channelKey: "telegram",
      setupSurface: {
        applyAccountConfig: ({ cfg }) => cfg,
        singleAccountKeysToMove: ["botToken"],
      } as ChannelSetupAdapter,
    });

    // resolveNormalizedAccountEntry returns the exact key before its normalized scan
    // (src/routing/account-lookup.ts:35-37), so Telegram reads "default" for that id however
    // late it is listed. A token moved into "Default" would leave the entry every reader takes
    // without one.
    const channel = channelRecord(next, "telegram");
    expect(accountRecord(channel, "default")).toEqual({ name: "Canon", botToken: "root-tok" });
    expect(accountRecord(channel, "Default")).toEqual({ name: "Alias" });
    expect(channel.botToken).toBeUndefined();
  });

  it("targets the exact key when defaultAccount names a shadowed alias and the channel declares nothing", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          telegram: {
            botToken: "root-tok",
            defaultAccount: "default",
            accounts: { Default: { name: "Alias" }, default: { name: "Canon" } },
          },
        },
      }),
      channelKey: "telegram",
      setupSurface: {
        applyAccountConfig: ({ cfg }) => cfg,
        singleAccountKeysToMove: ["botToken"],
      } as ChannelSetupAdapter,
    });

    // The configured defaultAccount names the canonical id, and Telegram reads that id with
    // resolveNormalizedAccountEntry, which takes the exact "default" key before any scan
    // (src/routing/account-lookup.ts:35-37). Targeting the raw alias listed first would move the
    // token into "Default" and leave the entry every reader takes without one.
    const channel = channelRecord(next, "telegram");
    expect(accountRecord(channel, "default")).toEqual({ name: "Canon", botToken: "root-tok" });
    expect(accountRecord(channel, "Default")).toEqual({ name: "Alias" });
    expect(channel.botToken).toBeUndefined();
  });

  it("takes the exact key beside a dotted alias listed first when the channel declares nothing", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          matrix: {
            defaultAccount: "ops",
            homeserver: "https://matrix.example.org",
            userId: "@ops:example.org",
            accessToken: "token",
            accounts: { "Ops.": { enabled: true }, ops: { enabled: true } },
          },
        },
      }),
      channelKey: "matrix",
      setupSurface: matrixSetupSurface,
    });

    // Matrix's own target resolver names the first key normalizing to "ops", which is "Ops.",
    // and the promotion normalizes that back to "ops". resolveNormalizedAccountEntry takes the
    // exact "ops" key for that id, so the credentials land there and the alias stays as authored.
    const channel = channelRecord(next, "matrix");
    expect(accountRecord(channel, "ops")).toEqual({
      enabled: true,
      homeserver: "https://matrix.example.org",
      userId: "@ops:example.org",
      accessToken: "token",
    });
    expect(accountRecord(channel, "Ops.")).toEqual({ enabled: true });
    expect(channel.homeserver).toBeUndefined();
    expect(channel.userId).toBeUndefined();
    expect(channel.accessToken).toBeUndefined();
  });

  it("prefers the exact key over its case variant under the case-insensitive lookup", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          signal: {
            defaultAccount: "ops",
            account: "+15555550100",
            accounts: { Ops: { name: "Variant" }, ops: { name: "Exact" } },
          },
        },
      }),
      channelKey: "signal",
      setupSurface: signalSetupSurface,
    });

    // resolveAccountEntry returns the exact key before scanning for a case-folded one
    // (src/routing/account-lookup.ts:15-17), so the number lands on `ops` however late it is
    // listed.
    const channel = channelRecord(next, "signal");
    expect(accountRecord(channel, "ops")).toEqual({ name: "Exact", account: "+15555550100" });
    expect(accountRecord(channel, "Ops")).toEqual({ name: "Variant" });
    expect(channel.account).toBeUndefined();
  });

  it("takes the first case-folded key in map order under the case-insensitive lookup", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          signal: {
            defaultAccount: "ops",
            account: "+15555550100",
            accounts: { OPS: { name: "First" }, Ops: { name: "Second" } },
          },
        },
      }),
      channelKey: "signal",
      setupSurface: signalSetupSurface,
    });

    // resolveAccountEntry scans with find (src/routing/account-lookup.ts:19-21), so the first key
    // in map order wins and the promotion has to agree with it.
    const channel = channelRecord(next, "signal");
    expect(accountRecord(channel, "OPS")).toEqual({ name: "First", account: "+15555550100" });
    expect(accountRecord(channel, "Ops")).toEqual({ name: "Second" });
    expect(accountsRecord(channel).ops).toBeUndefined();
    expect(channel.account).toBeUndefined();
  });

  it("passes over an alias for the case variant the case-insensitive lookup selects", () => {
    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: asConfig({
        channels: {
          signal: {
            defaultAccount: "ops",
            account: "+15555550100",
            accounts: { "Ops.": { name: "Alias" }, OPS: { name: "Variant" } },
          },
        },
      }),
      channelKey: "signal",
      setupSurface: signalSetupSurface,
    });

    // The default-account branch names the first key normalizing to "ops", which is "Ops.", and
    // Signal's resolver selects "OPS" for that id, so the promotion lands there and keeps the
    // authored spelling instead of creating a canonical "ops" entry. The shape is a Signal one on
    // purpose. Matrix declares nothing, its reader selects "Ops." through
    // resolveNormalizedAccountEntry, and the default rule keeps promoting into "Ops." for it.
    const channel = channelRecord(next, "signal");
    expect(accountRecord(channel, "OPS")).toEqual({ name: "Variant", account: "+15555550100" });
    expect(accountRecord(channel, "Ops.")).toEqual({ name: "Alias" });
    expect(accountsRecord(channel).ops).toBeUndefined();
    expect(channel.account).toBeUndefined();
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
