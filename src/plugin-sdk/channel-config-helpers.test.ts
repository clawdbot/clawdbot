import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  adaptScopedAccountAccessor,
  authorizeConfigWrite,
  createScopedAccountConfigAccessors,
  createScopedChannelConfigAdapter,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
  createHybridChannelConfigAdapter,
  createTopLevelChannelConfigAdapter,
  createTopLevelChannelConfigBase,
  createHybridChannelConfigBase,
  mapAllowFromEntries,
  resolveChannelConfigWrites,
  resolveOptionalConfigString,
} from "./channel-config-helpers.js";

const resolveDefaultAccountId = () => DEFAULT_ACCOUNT_ID;

function createConfigWritesCfg() {
  return {
    channels: {
      telegram: {
        configWrites: true,
        accounts: {
          Work: { configWrites: false },
        },
      },
    },
  };
}

function expectAdapterAllowFromAndDefaultTo(adapter: unknown) {
  const channelAdapter = adapter as {
    resolveAllowFrom?: (params: { cfg: object; accountId: string }) => unknown;
    resolveDefaultTo?: (params: { cfg: object; accountId: string }) => unknown;
    setAccountEnabled?: (params: { cfg: object; accountId: string; enabled: boolean }) => {
      channels?: {
        demo?: unknown;
      };
    };
  };

  expect(channelAdapter.resolveAllowFrom?.({ cfg: {}, accountId: "alt" })).toEqual(["alt"]);
  expect(channelAdapter.resolveDefaultTo?.({ cfg: {}, accountId: "alt" })).toBe("room:123");
  expect(
    channelAdapter.setAccountEnabled?.({
      cfg: {},
      accountId: "default",
      enabled: true,
    })?.channels?.demo,
  ).toEqual({ enabled: true });
}

describe("mapAllowFromEntries", () => {
  it.each([
    {
      name: "coerces allowFrom entries to strings",
      input: ["user", 42],
      expected: ["user", "42"],
    },
    {
      name: "returns empty list for missing input",
      input: undefined,
      expected: [],
    },
  ])("$name", ({ input, expected }) => {
    expect(mapAllowFromEntries(input)).toEqual(expected);
  });
});

describe("resolveOptionalConfigString", () => {
  it.each([
    {
      name: "trims and returns string values",
      input: "  room:123  ",
      expected: "room:123",
    },
    {
      name: "coerces numeric values",
      input: 123,
      expected: "123",
    },
    {
      name: "returns undefined for empty string values",
      input: "   ",
      expected: undefined,
    },
    {
      name: "returns undefined for missing values",
      input: undefined,
      expected: undefined,
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveOptionalConfigString(input)).toBe(expected);
  });
});

describe("config write helpers", () => {
  it("matches account ids case-insensitively", () => {
    expect(
      resolveChannelConfigWrites({
        cfg: createConfigWritesCfg(),
        channelId: "telegram",
        accountId: "work",
      }),
    ).toBe(false);
  });

  it("blocks account-scoped writes when the configured account key differs only by case", () => {
    expect(
      authorizeConfigWrite({
        cfg: createConfigWritesCfg(),
        target: {
          kind: "account",
          scope: { channelId: "telegram", accountId: "work" },
        },
      }),
    ).toEqual({
      allowed: false,
      reason: "target-disabled",
      blockedScope: {
        kind: "target",
        scope: { channelId: "telegram", accountId: "work" },
      },
    });
  });
});

describe("adaptScopedAccountAccessor", () => {
  it("binds positional callback args into the shared account context object", () => {
    const accessor = adaptScopedAccountAccessor(({ cfg, accountId }) => ({
      channel: cfg.channels?.demo,
      accountId: accountId ?? "default",
    }));

    expect(
      accessor(
        {
          channels: {
            demo: {
              enabled: true,
            },
          },
        },
        "alt",
      ),
    ).toEqual({
      channel: {
        enabled: true,
      },
      accountId: "alt",
    });
  });
});

describe("createScopedAccountConfigAccessors", () => {
  it("maps allowFrom and defaultTo from the resolved account", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: ({ accountId }) => ({
        allowFrom: accountId ? [accountId, 42] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(
      accessors.resolveAllowFrom?.({
        cfg: {},
        accountId: "owner",
      }),
    ).toEqual(["owner", "42"]);
    expect(
      accessors.formatAllowFrom?.({
        cfg: {},
        allowFrom: ["owner"],
      }),
    ).toEqual(["OWNER"]);
    expect(
      accessors.resolveDefaultTo?.({
        cfg: {},
        accountId: "owner",
      }),
    ).toBe("room:123");
  });

  it("omits resolveDefaultTo when no selector is provided", () => {
    const accessors = createScopedAccountConfigAccessors({
      resolveAccount: () => ({ allowFrom: ["owner"] }),
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
    });

    expect(accessors.resolveDefaultTo).toBeUndefined();
  });
});

describe("createScopedChannelConfigBase", () => {
  it("wires shared account config CRUD through the section helper", () => {
    const base = createScopedChannelConfigBase({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
    });

    expect(base.listAccountIds({})).toEqual(["default", "alt"]);
    expect(base.resolveAccount({}, "alt")).toEqual({ accountId: "alt" });
    expect(base.defaultAccountId!({})).toBe("default");
    expect(
      base.setAccountEnabled!({
        cfg: {},
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({ enabled: true });
    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
            },
          },
        },
        accountId: "default",
      }).channels,
    ).toBeUndefined();
  });

  it("can force default account config into accounts.default", () => {
    const base = createScopedChannelConfigBase({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: [],
      allowTopLevel: false,
    });

    expect(
      base.setAccountEnabled!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
            },
          },
        },
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      token: "secret",
      accounts: {
        default: { enabled: true },
      },
    });
    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
              accounts: {
                default: { enabled: true },
              },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      token: "secret",
      accounts: undefined,
    });
  });
});

describe("createScopedChannelConfigAdapter", () => {
  it("combines scoped CRUD and allowFrom accessors", () => {
    const adapter = createScopedChannelConfigAdapter({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        allowFrom: accountId ? [accountId] : ["fallback"],
        defaultTo: " room:123 ",
      }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(adapter.listAccountIds({})).toEqual(["default", "alt"]);
    expect(adapter.resolveAccount({}, "alt")).toEqual({
      accountId: "alt",
      allowFrom: ["alt"],
      defaultTo: " room:123 ",
    });
    expectAdapterAllowFromAndDefaultTo(adapter);
  });
});

describe("createScopedDmSecurityResolver", () => {
  it("builds account-aware DM policy payloads", () => {
    const resolveDmPolicy = createScopedDmSecurityResolver<{
      accountId?: string | null;
      dmPolicy?: string;
      allowFrom?: string[];
    }>({
      channelKey: "demo",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw) => raw.toLowerCase(),
    });

    expect(
      resolveDmPolicy({
        cfg: {
          channels: {
            demo: {
              accounts: {
                alt: {},
              },
            },
          },
        },
        accountId: "alt",
        account: {
          accountId: "alt",
          dmPolicy: "allowlist",
          allowFrom: ["Owner"],
        },
      }),
    ).toEqual({
      policy: "allowlist",
      allowFrom: ["Owner"],
      policyPath: "channels.demo.accounts.alt.dmPolicy",
      allowFromPath: "channels.demo.accounts.alt.",
      approveHint: formatPairingApproveHint("demo"),
      normalizeEntry: expect.any(Function),
    });
  });

  it("uses accounts.default paths when named accounts inherit shared defaults", () => {
    const resolveDmPolicy = createScopedDmSecurityResolver<{
      accountId?: string | null;
      dmPolicy?: string;
      allowFrom?: string[];
    }>({
      channelKey: "demo",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw) => raw.toLowerCase(),
      inheritSharedDefaultsFromDefaultAccount: true,
    });

    expect(
      resolveDmPolicy({
        cfg: {
          channels: {
            demo: {
              accounts: {
                default: {
                  dmPolicy: "allowlist",
                  allowFrom: ["Owner"],
                },
                alt: {},
              },
            },
          },
        },
        accountId: "alt",
        account: {
          accountId: "alt",
          dmPolicy: "allowlist",
          allowFrom: ["Owner"],
        },
      }),
    ).toEqual({
      policy: "allowlist",
      allowFrom: ["Owner"],
      policyPath: "channels.demo.accounts.default.dmPolicy",
      allowFromPath: "channels.demo.accounts.default.",
      approveHint: formatPairingApproveHint("demo"),
      normalizeEntry: expect.any(Function),
    });
  });

  it("ignores accounts.default paths unless the channel opts into shared default-account inheritance", () => {
    const resolveDmPolicy = createScopedDmSecurityResolver<{
      accountId?: string | null;
      dmPolicy?: string;
      allowFrom?: string[];
    }>({
      channelKey: "demo",
      resolvePolicy: (account) => account.dmPolicy,
      resolveAllowFrom: (account) => account.allowFrom,
      policyPathSuffix: "dmPolicy",
      normalizeEntry: (raw) => raw.toLowerCase(),
    });

    expect(
      resolveDmPolicy({
        cfg: {
          channels: {
            demo: {
              dmPolicy: "pairing",
              allowFrom: ["*"],
              accounts: {
                default: {
                  dmPolicy: "allowlist",
                  allowFrom: ["Owner"],
                },
                alt: {},
              },
            },
          },
        },
        accountId: "alt",
        account: {
          accountId: "alt",
          dmPolicy: "pairing",
          allowFrom: ["*"],
        },
      }),
    ).toEqual({
      policy: "pairing",
      allowFrom: ["*"],
      policyPath: "channels.demo.dmPolicy",
      allowFromPath: "channels.demo.",
      approveHint: formatPairingApproveHint("demo"),
      normalizeEntry: expect.any(Function),
    });
  });
});

describe("createTopLevelChannelConfigBase", () => {
  it("wires top-level enable/delete semantics", () => {
    const base = createTopLevelChannelConfigBase({
      sectionKey: "demo",
      resolveAccount: () => ({ accountId: "default" }),
    });

    expect(base.listAccountIds({})).toEqual(["default"]);
    expect(base.defaultAccountId!({})).toBe("default");
    expect(
      base.setAccountEnabled!({
        cfg: {},
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({ enabled: true });
    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              enabled: true,
            },
          },
        },
        accountId: "default",
      }).channels,
    ).toBeUndefined();
  });

  it("can clear only account-scoped fields while preserving channel settings", () => {
    const base = createTopLevelChannelConfigBase({
      sectionKey: "demo",
      resolveAccount: () => ({ accountId: "default" }),
      deleteMode: "clear-fields",
      clearBaseFields: ["token", "allowFrom"],
    });

    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
              allowFrom: ["owner"],
              markdown: { tables: false },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});

describe("createTopLevelChannelConfigAdapter", () => {
  it("combines top-level CRUD with separate accessor account resolution", () => {
    const adapter = createTopLevelChannelConfigAdapter<
      { accountId: string; enabled: boolean },
      { allowFrom: string[]; defaultTo: string }
    >({
      sectionKey: "demo",
      resolveAccount: () => ({ accountId: "default", enabled: true }),
      resolveAccessorAccount: () => ({ allowFrom: ["owner"], defaultTo: " chat:123 " }),
      deleteMode: "clear-fields",
      clearBaseFields: ["token"],
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry)),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expect(adapter.resolveAccount({})).toEqual({ accountId: "default", enabled: true });
    expect(adapter.resolveAllowFrom?.({ cfg: {} })).toEqual(["owner"]);
    expect(adapter.resolveDefaultTo?.({ cfg: {} })).toBe("chat:123");
    expect(
      adapter.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
              markdown: { tables: false },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});

describe("createHybridChannelConfigBase", () => {
  it("writes default account enable at the channel root and named accounts under accounts", () => {
    const base = createHybridChannelConfigBase({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
    });

    expect(
      base.setAccountEnabled!({
        cfg: {
          channels: {
            demo: {
              accounts: {
                alt: { enabled: false },
              },
            },
          },
        },
        accountId: "default",
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: false },
      },
      enabled: true,
    });
    expect(
      base.setAccountEnabled!({
        cfg: {},
        accountId: "alt",
        enabled: true,
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: true },
      },
    });
  });

  it("can preserve the section when deleting the default account", () => {
    const base = createHybridChannelConfigBase({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "default" }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token", "name"],
      preserveSectionOnDefaultDelete: true,
    });

    expect(
      base.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
              name: "bot",
              accounts: {
                alt: { enabled: true },
              },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      accounts: {
        alt: { enabled: true },
      },
    });
  });
});

describe("createHybridChannelConfigAdapter", () => {
  it("combines hybrid CRUD with allowFrom/defaultTo accessors", () => {
    const adapter = createHybridChannelConfigAdapter<
      { accountId: string; enabled: boolean },
      { allowFrom: string[]; defaultTo: string }
    >({
      sectionKey: "demo",
      listAccountIds: () => ["default", "alt"],
      resolveAccount: (_cfg, accountId) => ({
        accountId: accountId ?? "default",
        enabled: true,
      }),
      resolveAccessorAccount: ({ accountId }) => ({
        allowFrom: [accountId ?? "default"],
        defaultTo: " room:123 ",
      }),
      defaultAccountId: resolveDefaultAccountId,
      clearBaseFields: ["token"],
      preserveSectionOnDefaultDelete: true,
      resolveAllowFrom: (account) => account.allowFrom,
      formatAllowFrom: (allowFrom) => allowFrom.map((entry) => String(entry).toUpperCase()),
      resolveDefaultTo: (account) => account.defaultTo,
    });

    expectAdapterAllowFromAndDefaultTo(adapter);
    expect(
      adapter.deleteAccount!({
        cfg: {
          channels: {
            demo: {
              token: "secret",
              markdown: { tables: false },
            },
          },
        },
        accountId: "default",
      }).channels?.demo,
    ).toEqual({
      markdown: { tables: false },
    });
  });
});
