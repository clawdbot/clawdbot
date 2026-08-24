/**
 * Tests allowlist config edit helpers for flat, nested, and account-scoped records.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildDmGroupAccountAllowlistAdapter,
  buildLegacyDmAccountAllowlistAdapter,
  collectAllowlistOverridesFromRecord,
  collectNestedAllowlistOverridesFromRecord,
  createAccountScopedAllowlistNameResolver,
  createFlatAllowlistOverrideResolver,
  createNestedAllowlistOverrideResolver,
  readConfiguredAllowlistEntries,
} from "./allowlist-config-edit.js";

describe("readConfiguredAllowlistEntries", () => {
  it("coerces mixed entries to non-empty strings", () => {
    expect(readConfiguredAllowlistEntries(["owner", 42, ""])).toEqual(["owner", "42"]);
  });
});

describe("collectAllowlistOverridesFromRecord", () => {
  it.each([
    {
      name: "collects only non-empty overrides from a flat record",
      record: {
        room1: { users: ["a", "b"] },
        room2: { users: [] },
      },
      expected: [{ label: "room1", entries: ["a", "b"] }],
    },
  ])("$name", ({ record, expected }) => {
    expect(
      collectAllowlistOverridesFromRecord({
        record,
        label: (key) => key,
        resolveEntries: (value) => value.users,
      }),
    ).toEqual(expected);
  });
});

describe("collectNestedAllowlistOverridesFromRecord", () => {
  it.each([
    {
      name: "collects outer and nested overrides from a hierarchical record",
      record: {
        guild1: {
          users: ["owner"],
          channels: {
            chan1: { users: ["member"] },
          },
        },
      },
      expected: [
        { label: "guild guild1", entries: ["owner"] },
        { label: "guild guild1 / channel chan1", entries: ["member"] },
      ],
    },
  ])("$name", ({ record, expected }) => {
    expect(
      collectNestedAllowlistOverridesFromRecord({
        record,
        outerLabel: (key) => `guild ${key}`,
        resolveOuterEntries: (value) => value.users,
        resolveChildren: (value) => value.channels,
        innerLabel: (outerKey, innerKey) => `guild ${outerKey} / channel ${innerKey}`,
        resolveInnerEntries: (value) => value.users,
      }),
    ).toEqual(expected);
  });
});

describe("createFlatAllowlistOverrideResolver", () => {
  it.each([
    {
      name: "builds an account-scoped flat override resolver",
      account: { channels: { room1: { users: ["a"] } } },
      expected: [{ label: "room1", entries: ["a"] }],
    },
  ])("$name", ({ account, expected }) => {
    const resolveOverrides = createFlatAllowlistOverrideResolver({
      resolveRecord: (accountValue: { channels?: Record<string, { users: string[] }> }) =>
        accountValue.channels,
      label: (key) => key,
      resolveEntries: (value) => value.users,
    });

    expect(resolveOverrides(account)).toEqual(expected);
  });
});

describe("createNestedAllowlistOverrideResolver", () => {
  it.each([
    {
      name: "builds an account-scoped nested override resolver",
      account: {
        groups: {
          g1: { allowFrom: ["owner"], topics: { t1: { allowFrom: ["member"] } } },
        },
      },
      expected: [
        { label: "g1", entries: ["owner"] },
        { label: "g1 topic t1", entries: ["member"] },
      ],
    },
  ])("$name", ({ account, expected }) => {
    const resolveOverrides = createNestedAllowlistOverrideResolver({
      resolveRecord: (accountLocal: {
        groups?: Record<
          string,
          { allowFrom?: string[]; topics?: Record<string, { allowFrom?: string[] }> }
        >;
      }) => accountLocal.groups,
      outerLabel: (groupId) => groupId,
      resolveOuterEntries: (group) => group.allowFrom,
      resolveChildren: (group) => group.topics,
      innerLabel: (groupId, topicId) => `${groupId} topic ${topicId}`,
      resolveInnerEntries: (topic) => topic.allowFrom,
    });

    expect(resolveOverrides(account)).toEqual(expected);
  });
});

describe("createAccountScopedAllowlistNameResolver", () => {
  it.each([
    {
      name: "returns empty results when the resolved account has no token",
      token: "",
      expected: [],
    },
    {
      name: "delegates to the resolver when a token is present",
      token: " secret ",
      expected: [{ input: "a", resolved: true, name: "secret:a" }],
    },
  ])("$name", async ({ token, expected }) => {
    const resolveNames = createAccountScopedAllowlistNameResolver({
      resolveAccount: () => ({ token }),
      resolveToken: (account) => account.token,
      resolveNames: async ({ token: tokenLocal, entries }) =>
        entries.map((entry) => ({ input: entry, resolved: true, name: `${tokenLocal}:${entry}` })),
    });

    expect(await resolveNames({ cfg: {}, accountId: "alt", scope: "dm", entries: ["a"] })).toEqual(
      expected,
    );
  });
});

describe("buildDmGroupAccountAllowlistAdapter", () => {
  const adapter = buildDmGroupAccountAllowlistAdapter({
    channelId: "demo",
    resolveAccount: ({ accountId }) => ({
      accountId: accountId ?? "default",
      dmAllowFrom: ["dm-owner"],
      groupAllowFrom: ["group-owner"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "room-1", entries: ["member-1"] }],
    }),
    normalize: ({ values }) => values.map((entry) => String(entry).trim().toLowerCase()),
    resolveDmAllowFrom: (account) => account.dmAllowFrom,
    resolveGroupAllowFrom: (account) => account.groupAllowFrom,
    resolveDmPolicy: (account) => account.dmPolicy,
    resolveGroupPolicy: (account) => account.groupPolicy,
    resolveGroupOverrides: (account) => account.groupOverrides,
  });

  const scopeCases: Array<{ scope: "dm" | "group" | "all"; expected: boolean }> = [
    { scope: "dm", expected: true },
    { scope: "group", expected: true },
    { scope: "all", expected: true },
  ];

  it.each(scopeCases)("supports $scope scope", ({ scope, expected }) => {
    expect(adapter.supportsScope?.({ scope })).toBe(expected);
  });

  it("reads dm/group config from the resolved account", () => {
    expect(adapter.readConfig?.({ cfg: {}, accountId: "alt" })).toEqual({
      dmAllowFrom: ["dm-owner"],
      groupAllowFrom: ["group-owner"],
      dmPolicy: "allowlist",
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "room-1", entries: ["member-1"] }],
    });
  });

  it("writes group allowlist entries to groupAllowFrom", () => {
    expect(
      adapter.applyConfigEdit?.({
        cfg: {},
        parsedConfig: {},
        accountId: "alt",
        scope: "group",
        action: "add",
        entry: " Member-2 ",
      }),
    ).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.demo.accounts.alt.groupAllowFrom",
      writeTarget: {
        kind: "account",
        scope: { channelId: "demo", accountId: "alt" },
      },
    });
  });

  it("materializes inherited entries before adding a named-account override", async () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { demo: { allowFrom: ["dm-owner"], accounts: { alt: {} } } },
    };

    await adapter.applyConfigEdit?.({
      cfg: parsedConfig as OpenClawConfig,
      parsedConfig,
      accountId: "alt",
      scope: "dm",
      action: "add",
      entry: "dm-admin",
    });

    expect(parsedConfig).toMatchObject({
      channels: {
        demo: { accounts: { alt: { allowFrom: ["dm-owner", "dm-admin"] } } },
      },
    });
  });

  it("writes an empty named-account override when removing the last inherited entry", async () => {
    const parsedConfig: Record<string, unknown> = {
      channels: { demo: { allowFrom: ["dm-owner"], accounts: { alt: {} } } },
    };

    await adapter.applyConfigEdit?.({
      cfg: parsedConfig as OpenClawConfig,
      parsedConfig,
      accountId: "alt",
      scope: "dm",
      action: "remove",
      entry: "dm-owner",
    });

    expect(parsedConfig).toMatchObject({
      channels: { demo: { accounts: { alt: { allowFrom: [] } } } },
    });
  });

  it("writes an empty channel override when removing the last effective entry", async () => {
    const parsedConfig: Record<string, unknown> = {};

    await adapter.applyConfigEdit?.({
      cfg: {} as OpenClawConfig,
      parsedConfig,
      accountId: "default",
      scope: "dm",
      action: "remove",
      entry: "dm-owner",
    });

    expect(parsedConfig).toMatchObject({
      channels: { demo: { allowFrom: [] } },
    });
  });

  it("keeps an empty channel override after clearing a materialized list", async () => {
    const parsedConfig: Record<string, unknown> = {};
    const edit = (action: "add" | "remove", entry: string) =>
      adapter.applyConfigEdit?.({
        cfg: parsedConfig as OpenClawConfig,
        parsedConfig,
        accountId: "default",
        scope: "dm",
        action,
        entry,
      });

    await edit("add", "dm-admin");
    await edit("remove", "dm-owner");
    await edit("remove", "dm-admin");

    expect(parsedConfig).toMatchObject({
      channels: { demo: { allowFrom: [] } },
    });
  });
});

describe("buildLegacyDmAccountAllowlistAdapter", () => {
  const adapter = buildLegacyDmAccountAllowlistAdapter({
    channelId: "demo",
    resolveAccount: ({ accountId }) => ({
      accountId: accountId ?? "default",
      dmAllowFrom: ["owner"],
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "group-1", entries: ["member-1"] }],
    }),
    normalize: ({ values }) => values.map((entry) => String(entry).trim().toLowerCase()),
    resolveDmAllowFrom: (account) => account.dmAllowFrom,
    resolveGroupPolicy: (account) => account.groupPolicy,
    resolveGroupOverrides: (account) => account.groupOverrides,
  });

  const scopeCases: Array<{ scope: "dm" | "group" | "all"; expected: boolean }> = [
    { scope: "dm", expected: true },
    { scope: "group", expected: false },
    { scope: "all", expected: false },
  ];

  it.each(scopeCases)("supports $scope scope", ({ scope, expected }) => {
    expect(adapter.supportsScope?.({ scope })).toBe(expected);
  });

  it("reads legacy dm config from the resolved account", () => {
    expect(adapter.readConfig?.({ cfg: {}, accountId: "alt" })).toEqual({
      dmAllowFrom: ["owner"],
      groupPolicy: "allowlist",
      groupOverrides: [{ label: "group-1", entries: ["member-1"] }],
    });
  });

  it("writes dm allowlist entries and keeps legacy cleanup behavior", () => {
    expect(
      adapter.applyConfigEdit?.({
        cfg: {},
        parsedConfig: {
          channels: {
            demo: {
              accounts: {
                alt: {
                  dm: { allowFrom: ["owner"] },
                },
              },
            },
          },
        },
        accountId: "alt",
        scope: "dm",
        action: "add",
        entry: "admin",
      }),
    ).toEqual({
      kind: "ok",
      changed: true,
      pathLabel: "channels.demo.accounts.alt.allowFrom",
      writeTarget: {
        kind: "account",
        scope: { channelId: "demo", accountId: "alt" },
      },
    });
  });
});
