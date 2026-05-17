import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  createAccountListHelpers,
  describeAccountSnapshot,
  describeWebhookAccountSnapshot,
  listCombinedAccountIds,
  mergeAccountConfig,
  resolveListedDefaultAccountId,
  resolveMergedAccountConfig,
} from "./account-helpers.js";

const { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId } =
  createAccountListHelpers("testchannel");

function cfg(accounts?: Record<string, unknown> | null, defaultAccount?: string): OpenClawConfig {
  if (accounts === null) {
    return {
      channels: {
        testchannel: defaultAccount ? { defaultAccount } : {},
      },
    } as unknown as OpenClawConfig;
  }
  if (accounts === undefined && !defaultAccount) {
    return {} as unknown as OpenClawConfig;
  }
  return {
    channels: {
      testchannel: {
        ...(accounts === undefined ? {} : { accounts }),
        ...(defaultAccount ? { defaultAccount } : {}),
      },
    },
  } as unknown as OpenClawConfig;
}

function expectResolvedAccountIdsCase(params: {
  resolve: (cfg: OpenClawConfig) => string[];
  input: OpenClawConfig;
  expected: string[];
}) {
  expect(params.resolve(params.input)).toEqual(params.expected);
}

function expectResolvedDefaultAccountCase(input: OpenClawConfig, expected: string) {
  expect(resolveDefaultAccountId(input)).toBe(expected);
}

describe("createAccountListHelpers", () => {
  describe("listConfiguredAccountIds", () => {
    it.each([
      {
        name: "returns empty for missing config",
        input: {} as OpenClawConfig,
      },
      {
        name: "returns empty when no accounts key",
        input: cfg(null),
      },
      {
        name: "returns empty for empty accounts object",
        input: cfg({}),
      },
    ])("$name", ({ input }) => {
      expectResolvedAccountIdsCase({
        resolve: listConfiguredAccountIds,
        input,
        expected: [],
      });
    });

    it("filters out empty keys", () => {
      expect(listConfiguredAccountIds(cfg({ "": {}, a: {} }))).toEqual(["a"]);
    });

    it("returns account keys", () => {
      expect(listConfiguredAccountIds(cfg({ work: {}, personal: {} }))).toEqual([
        "work",
        "personal",
      ]);
    });
  });

  describe("with normalizeAccountId option", () => {
    const normalized = createAccountListHelpers("testchannel", { normalizeAccountId });

    it("normalizes and deduplicates configured account ids", () => {
      expect(
        normalized.listConfiguredAccountIds(
          cfg({
            "Router D": {},
            "router-d": {},
            "Personal A": {},
          }),
        ),
      ).toEqual(["router-d", "personal-a"]);
    });
  });

  describe("listAccountIds", () => {
    it.each([
      {
        name: 'returns ["default"] for empty config',
        input: {} as OpenClawConfig,
        expected: ["default"],
      },
      {
        name: 'returns ["default"] for empty accounts',
        input: cfg({}),
        expected: ["default"],
      },
      {
        name: "returns sorted ids",
        input: cfg({ z: {}, a: {}, m: {} }),
        expected: ["a", "m", "z"],
      },
    ])("$name", ({ input, expected }) => {
      expectResolvedAccountIdsCase({
        resolve: listAccountIds,
        input,
        expected,
      });
    });

    it("keeps an implicit default account when root credential keys coexist with named accounts", () => {
      const helpers = createAccountListHelpers("testchannel", {
        implicitDefaultAccount: { channelKeys: ["token"] },
      });

      expect(
        helpers.listAccountIds({
          channels: {
            testchannel: {
              token: "root-token",
              accounts: { work: {} },
            },
          },
        } as unknown as OpenClawConfig),
      ).toEqual(["default", "work"]);
    });

    it("keeps an implicit default account when root env credentials coexist with named accounts", () => {
      const previous = process.env.TESTCHANNEL_TOKEN;
      process.env.TESTCHANNEL_TOKEN = "env-token";
      try {
        const helpers = createAccountListHelpers("testchannel", {
          implicitDefaultAccount: { envVars: ["TESTCHANNEL_TOKEN"] },
        });

        expect(helpers.listAccountIds(cfg({ work: {} }))).toEqual(["default", "work"]);
      } finally {
        if (previous === undefined) {
          delete process.env.TESTCHANNEL_TOKEN;
        } else {
          process.env.TESTCHANNEL_TOKEN = previous;
        }
      }
    });
  });

  describe("resolveDefaultAccountId", () => {
    it.each([
      {
        name: "prefers configured defaultAccount when it matches a configured account id",
        input: cfg({ alpha: {}, beta: {} }, "beta"),
        expected: "beta",
      },
      {
        name: "normalizes configured defaultAccount before matching",
        input: cfg({ "router-d": {} }, "Router D"),
        expected: "router-d",
      },
      {
        name: "falls back when configured defaultAccount is missing",
        input: cfg({ beta: {}, alpha: {} }, "missing"),
        expected: "alpha",
      },
      {
        name: 'returns "default" when present',
        input: cfg({ default: {}, other: {} }),
        expected: "default",
      },
      {
        name: "returns first sorted id when no default",
        input: cfg({ beta: {}, alpha: {} }),
        expected: "alpha",
      },
      {
        name: 'returns "default" for empty config',
        input: {} as OpenClawConfig,
        expected: "default",
      },
    ])("$name", ({ input, expected }) => {
      expectResolvedDefaultAccountCase(input, expected);
    });

    it("can preserve configured defaults that are not present in accounts", () => {
      const preserveDefault = createAccountListHelpers("testchannel", {
        allowUnlistedDefaultAccount: true,
      });

      expect(preserveDefault.resolveDefaultAccountId(cfg({ default: {}, zeta: {} }, "ops"))).toBe(
        "ops",
      );
    });
  });
});

describe("listCombinedAccountIds", () => {
  it("combines configured, additional, and implicit ids once", () => {
    expect(
      listCombinedAccountIds({
        configuredAccountIds: ["work", "alerts"],
        additionalAccountIds: ["default", "alerts"],
        implicitAccountId: "ops",
      }),
    ).toEqual(["alerts", "default", "ops", "work"]);
  });

  it("uses the fallback id when no accounts are present", () => {
    expect(
      listCombinedAccountIds({
        configuredAccountIds: [],
        fallbackAccountIdWhenEmpty: "default",
      }),
    ).toEqual(["default"]);
  });
});

describe("resolveListedDefaultAccountId", () => {
  it.each([
    {
      name: "prefers the configured default when present in the listed ids",
      input: {
        accountIds: ["alerts", "work"],
        configuredDefaultAccountId: "work",
      },
      expected: "work",
    },
    {
      name: "matches configured defaults against normalized listed ids",
      input: {
        accountIds: ["Router D"],
        configuredDefaultAccountId: "router-d",
      },
      expected: "router-d",
    },
    {
      name: "prefers the default account id when listed",
      input: {
        accountIds: ["default", "work"],
      },
      expected: "default",
    },
    {
      name: "can preserve an unlisted configured default",
      input: {
        accountIds: ["default", "work"],
        configuredDefaultAccountId: "ops",
        allowUnlistedDefaultAccount: true,
      },
      expected: "ops",
    },
    {
      name: "supports an explicit fallback id for ambiguous multi-account setups",
      input: {
        accountIds: ["alerts", "work"],
        ambiguousFallbackAccountId: "default",
      },
      expected: "default",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveListedDefaultAccountId(input)).toBe(expected);
  });
});

describe("describeAccountSnapshot", () => {
  it("builds the standard snapshot shape with optional extras", () => {
    expect(
      describeAccountSnapshot({
        account: {
          accountId: "work",
          name: "Work",
          enabled: true,
        },
        configured: true,
        extra: {
          tokenSource: "config",
        },
      }),
    ).toEqual({
      accountId: "work",
      name: "Work",
      enabled: true,
      configured: true,
      tokenSource: "config",
    });
  });

  it("normalizes missing identity fields to the shared defaults", () => {
    expect(
      describeAccountSnapshot({
        account: {},
      }),
    ).toEqual({
      accountId: "default",
      name: undefined,
      enabled: true,
      configured: undefined,
    });
  });
});

describe("describeWebhookAccountSnapshot", () => {
  it("defaults mode to webhook while preserving caller extras", () => {
    expect(
      describeWebhookAccountSnapshot({
        account: {
          accountId: "work",
          name: "Work",
        },
        configured: true,
        extra: {
          tokenSource: "config",
        },
      }),
    ).toEqual({
      accountId: "work",
      name: "Work",
      enabled: true,
      configured: true,
      tokenSource: "config",
      mode: "webhook",
    });
  });

  it("allows callers to override the mode when the transport is not always webhook", () => {
    expect(
      describeWebhookAccountSnapshot({
        account: {
          accountId: "work",
        },
        mode: "polling",
      }),
    ).toEqual({
      accountId: "work",
      name: undefined,
      enabled: true,
      configured: undefined,
      mode: "polling",
    });
  });
});

describe("mergeAccountConfig", () => {
  type MergeAccountConfigShape = {
    enabled?: boolean;
    defaultAccount?: string;
    name?: string;
    accounts?: Record<string, { name: string }>;
    commands?: {
      native?: boolean;
      callbackPath?: string;
    };
  };

  type MergeAccountInput = Parameters<typeof mergeAccountConfig<MergeAccountConfigShape>>[0];

  it.each([
    {
      name: "drops accounts from the base config before merging",
      input: {
        channelConfig: {
          enabled: true,
          accounts: {
            work: { name: "Work" },
          },
        },
        accountConfig: {
          name: "Work",
        },
      },
      expected: {
        enabled: true,
        name: "Work",
      },
    },
    {
      name: "drops caller-specified keys from the base config before merging",
      input: {
        channelConfig: {
          enabled: true,
          defaultAccount: "work",
        },
        accountConfig: {
          name: "Work",
        },
        omitKeys: ["defaultAccount"],
      },
      expected: {
        enabled: true,
        name: "Work",
      },
    },
    {
      name: "deep-merges selected nested object keys",
      input: {
        channelConfig: {
          commands: {
            native: true,
          },
        },
        accountConfig: {
          commands: {
            callbackPath: "/work",
          },
        },
        nestedObjectKeys: ["commands"],
      },
      expected: {
        commands: {
          native: true,
          callbackPath: "/work",
        },
      },
    },
  ] satisfies Array<{
    name: string;
    input: MergeAccountInput;
    expected: MergeAccountConfigShape;
  }>)("$name", ({ input, expected }) => {
    expect(mergeAccountConfig<MergeAccountConfigShape>(input)).toEqual(expected);
  });
});

describe("resolveMergedAccountConfig", () => {
  type MergedChannelConfig = {
    enabled?: boolean;
    name?: string;
  };

  type ResolveMergedInput = Parameters<typeof resolveMergedAccountConfig<MergedChannelConfig>>[0];

  const resolveMergedCases: Array<{
    name: string;
    input: ResolveMergedInput;
    expected: MergedChannelConfig;
  }> = [
    {
      name: "merges the matching account config into channel config",
      input: {
        channelConfig: {
          enabled: true,
        },
        accounts: {
          work: {
            name: "Work",
          },
        },
        accountId: "work",
      },
      expected: {
        enabled: true,
        name: "Work",
      },
    },
    {
      name: "supports normalized account lookups",
      input: {
        channelConfig: {
          enabled: true,
        },
        accounts: {
          "Router D": {
            name: "Router",
          },
        },
        accountId: "router-d",
        normalizeAccountId,
      },
      expected: {
        enabled: true,
        name: "Router",
      },
    },
  ];

  it.each(resolveMergedCases)("$name", ({ input, expected }) => {
    expect(resolveMergedAccountConfig<MergedChannelConfig>(input)).toEqual(expected);
  });

  it("deep-merges selected nested object keys after resolving the account", () => {
    const merged = resolveMergedAccountConfig<{
      nickserv?: { service?: string; registerEmail?: string };
    }>({
      channelConfig: {
        nickserv: {
          service: "NickServ",
        },
      },
      accounts: {
        work: {
          nickserv: {
            registerEmail: "work@example.com",
          },
        },
      },
      accountId: "work",
      nestedObjectKeys: ["nickserv"],
    });

    expect(merged).toEqual({
      nickserv: {
        service: "NickServ",
        registerEmail: "work@example.com",
      },
    });
  });
});
