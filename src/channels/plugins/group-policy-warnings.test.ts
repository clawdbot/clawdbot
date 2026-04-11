import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  collectAllowlistProviderGroupPolicyWarnings,
  collectAllowlistProviderRestrictSendersWarnings,
  composeAccountWarningCollectors,
  composeWarningCollectors,
  createAllowlistProviderGroupPolicyWarningCollector,
  createConditionalWarningCollector,
  createAllowlistProviderOpenWarningCollector,
  createAllowlistProviderRestrictSendersWarningCollector,
  createAllowlistProviderRouteAllowlistWarningCollector,
  createOpenGroupPolicyRestrictSendersWarningCollector,
  createOpenProviderGroupPolicyWarningCollector,
  createOpenProviderConfiguredRouteWarningCollector,
  projectAccountConfigWarningCollector,
  projectAccountWarningCollector,
  projectConfigAccountIdWarningCollector,
  projectConfigWarningCollector,
  projectWarningCollector,
  collectOpenGroupPolicyConfiguredRouteWarnings,
  collectOpenProviderGroupPolicyWarnings,
  collectOpenGroupPolicyRestrictSendersWarnings,
  collectOpenGroupPolicyRouteAllowlistWarnings,
  buildOpenGroupPolicyConfigureRouteAllowlistWarning,
  buildOpenGroupPolicyNoRouteAllowlistWarning,
  buildOpenGroupPolicyRestrictSendersWarning,
  buildOpenGroupPolicyWarning,
} from "./group-policy-warnings.js";

describe("group policy warning builders", () => {
  it("composes warning collectors", () => {
    const collect = composeWarningCollectors<{ enabled: boolean }>(
      () => ["a"],
      ({ enabled }) => (enabled ? ["b"] : []),
    );

    expect(collect({ enabled: true })).toEqual(["a", "b"]);
    expect(collect({ enabled: false })).toEqual(["a"]);
  });

  it("projects warning collector inputs", () => {
    const collect = projectWarningCollector(
      ({ value }: { value: string }) => value,
      (value: string) => [value.toUpperCase()],
    );

    expect(collect({ value: "abc" })).toEqual(["ABC"]);
  });

  it("projects cfg-only warning collector inputs", () => {
    const collect = projectConfigWarningCollector<{ cfg: OpenClawConfig; accountId: string }>(
      ({ cfg }) => [cfg.channels ? "configured" : "none"],
    );

    expect(
      collect({
        cfg: { channels: { slack: {} } } as OpenClawConfig,
        accountId: "acct-1",
      }),
    ).toEqual(["configured"]);
  });

  it("projects cfg+accountId warning collector inputs", () => {
    const collect = projectConfigAccountIdWarningCollector<{
      cfg: OpenClawConfig;
      accountId?: string | null;
      account: { accountId: string };
    }>(({ accountId }) => [accountId ?? "default"]);

    expect(
      collect({
        cfg: {} as OpenClawConfig,
        accountId: "acct-1",
        account: { accountId: "ignored" },
      }),
    ).toEqual(["acct-1"]);
  });

  it("projects account-only warning collector inputs", () => {
    const collect = projectAccountWarningCollector<
      { accountId: string },
      { account: { accountId: string } }
    >((account) => [account.accountId]);

    expect(collect({ account: { accountId: "acct-1" } })).toEqual(["acct-1"]);
  });

  it("projects account+cfg warning collector inputs", () => {
    const collect = projectAccountConfigWarningCollector<
      { accountId: string },
      Record<string, unknown>,
      { account: { accountId: string }; cfg: OpenClawConfig }
    >(
      (cfg: OpenClawConfig) => cfg.channels ?? {},
      ({ account, cfg }) => [account.accountId, Object.keys(cfg).join(",") || "none"],
    );

    expect(
      collect({
        account: { accountId: "acct-1" },
        cfg: { channels: { slack: {} } } as OpenClawConfig,
      }),
    ).toEqual(["acct-1", "slack"]);
  });

  it("builds conditional warning collectors", () => {
    const collect = createConditionalWarningCollector<{ open: boolean; token?: string }>(
      ({ open }) => (open ? "open" : undefined),
      ({ token }) => (token ? undefined : ["missing token", "cannot send replies"]),
    );

    expect(collect({ open: true })).toEqual(["open", "missing token", "cannot send replies"]);
    expect(collect({ open: false, token: "x" })).toEqual([]);
  });

  it("composes account-scoped warning collectors", () => {
    const collect = composeAccountWarningCollectors<
      { enabled: boolean },
      { account: { enabled: boolean } }
    >(
      () => ["base"],
      (account) => (account.enabled ? "enabled" : undefined),
      () => ["extra-a", "extra-b"],
    );

    expect(collect({ account: { enabled: true } })).toEqual([
      "base",
      "enabled",
      "extra-a",
      "extra-b",
    ]);
    expect(collect({ account: { enabled: false } })).toEqual(["base", "extra-a", "extra-b"]);
  });

  it("builds base open-policy warning", () => {
    expect(
      buildOpenGroupPolicyWarning({
        surface: "Example groups",
        openBehavior: "allows any member to trigger (mention-gated)",
        remediation: 'Set channels.example.groupPolicy="allowlist"',
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.example.groupPolicy="allowlist".',
    );
  });

  it("builds restrict-senders warning", () => {
    expect(
      buildOpenGroupPolicyRestrictSendersWarning({
        surface: "Example groups",
        openScope: "any member in allowed groups",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" allows any member in allowed groups to trigger (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom to restrict senders.',
    );
  });

  it("builds no-route-allowlist warning", () => {
    expect(
      buildOpenGroupPolicyNoRouteAllowlistWarning({
        surface: "Example groups",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toBe(
      '- Example groups: groupPolicy="open" with no channels.example.groups allowlist; any group can add + ping (mention-gated). Set channels.example.groupPolicy="allowlist" + channels.example.groupAllowFrom or configure channels.example.groups.',
    );
  });

  it("builds configure-route-allowlist warning", () => {
    expect(
      buildOpenGroupPolicyConfigureRouteAllowlistWarning({
        surface: "Example channels",
        openScope: "any channel not explicitly denied",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.channels",
      }),
    ).toBe(
      '- Example channels: groupPolicy="open" allows any channel not explicitly denied to trigger (mention-gated). Set channels.example.groupPolicy="allowlist" and configure channels.example.channels.',
    );
  });

  it("collects restrict-senders warning only for open policy", () => {
    expect(
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupPolicy: "allowlist",
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toEqual([]);

    expect(
      collectOpenGroupPolicyRestrictSendersWarnings({
        groupPolicy: "open",
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toHaveLength(1);
  });

  it("resolves allowlist-provider runtime policy before collecting restrict-senders warnings", () => {
    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
          },
        },
        providerConfigPresent: false,
        configuredGroupPolicy: undefined,
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toEqual([]);

    expect(
      collectAllowlistProviderRestrictSendersWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
          },
        },
        providerConfigPresent: true,
        configuredGroupPolicy: "open",
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ]);
  });

  it("passes resolved allowlist-provider policy into the warning collector", () => {
    expect(
      collectAllowlistProviderGroupPolicyWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "open" },
          },
        },
        providerConfigPresent: false,
        configuredGroupPolicy: undefined,
        collect: (groupPolicy) => [groupPolicy],
      }),
    ).toEqual(["allowlist"]);

    expect(
      collectAllowlistProviderGroupPolicyWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "disabled" },
          },
        },
        providerConfigPresent: true,
        configuredGroupPolicy: "open",
        collect: (groupPolicy) => [groupPolicy],
      }),
    ).toEqual(["open"]);
  });

  it("passes resolved open-provider policy into the warning collector", () => {
    expect(
      collectOpenProviderGroupPolicyWarnings({
        cfg: {
          channels: {
            defaults: { groupPolicy: "allowlist" },
          },
        },
        providerConfigPresent: false,
        configuredGroupPolicy: undefined,
        collect: (groupPolicy) => [groupPolicy],
      }),
    ).toEqual(["allowlist"]);

    expect(
      collectOpenProviderGroupPolicyWarnings({
        cfg: {},
        providerConfigPresent: true,
        configuredGroupPolicy: undefined,
        collect: (groupPolicy) => [groupPolicy],
      }),
    ).toEqual(["open"]);

    expect(
      collectOpenProviderGroupPolicyWarnings({
        cfg: {},
        providerConfigPresent: true,
        configuredGroupPolicy: "disabled",
        collect: (groupPolicy) => [groupPolicy],
      }),
    ).toEqual(["disabled"]);
  });

  it("collects route allowlist warning variants", () => {
    const params = {
      groupPolicy: "open" as const,
      restrictSenders: {
        surface: "Example groups",
        openScope: "any member in allowed groups",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      },
      noRouteAllowlist: {
        surface: "Example groups",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      },
    };

    expect(
      collectOpenGroupPolicyRouteAllowlistWarnings({
        ...params,
        routeAllowlistConfigured: true,
      }),
    ).toEqual([buildOpenGroupPolicyRestrictSendersWarning(params.restrictSenders)]);

    expect(
      collectOpenGroupPolicyRouteAllowlistWarnings({
        ...params,
        routeAllowlistConfigured: false,
      }),
    ).toEqual([buildOpenGroupPolicyNoRouteAllowlistWarning(params.noRouteAllowlist)]);
  });

  it("collects configured-route warning variants", () => {
    const params = {
      groupPolicy: "open" as const,
      configureRouteAllowlist: {
        surface: "Example channels",
        openScope: "any channel not explicitly denied",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.channels",
      },
      missingRouteAllowlist: {
        surface: "Example channels",
        openBehavior: "with no route allowlist; any channel can trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
      },
    };

    expect(
      collectOpenGroupPolicyConfiguredRouteWarnings({
        ...params,
        routeAllowlistConfigured: true,
      }),
    ).toEqual([buildOpenGroupPolicyConfigureRouteAllowlistWarning(params.configureRouteAllowlist)]);

    expect(
      collectOpenGroupPolicyConfiguredRouteWarnings({
        ...params,
        routeAllowlistConfigured: false,
      }),
    ).toEqual([buildOpenGroupPolicyWarning(params.missingRouteAllowlist)]);
  });

  it("builds account-aware allowlist-provider restrict-senders collectors", () => {
    const collectWarnings = createAllowlistProviderRestrictSendersWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      surface: "Example groups",
      openScope: "any member",
      groupPolicyPath: "channels.example.groupPolicy",
      groupAllowFromPath: "channels.example.groupAllowFrom",
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open" },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ]);
  });

  it("builds config-aware allowlist-provider collectors", () => {
    const collectWarnings = createAllowlistProviderGroupPolicyWarningCollector<{
      cfg: {
        channels?: {
          defaults?: { groupPolicy?: "open" | "allowlist" | "disabled" };
          example?: Record<string, unknown>;
        };
      };
      channelLabel: string;
      configuredGroupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: ({ configuredGroupPolicy }) => configuredGroupPolicy,
      collect: ({ channelLabel, groupPolicy }) =>
        groupPolicy === "open" ? [`warn:${channelLabel}`] : [],
    });

    expect(
      collectWarnings({
        cfg: { channels: { example: {} } },
        channelLabel: "example",
        configuredGroupPolicy: "open",
      }),
    ).toEqual(["warn:example"]);
  });

  it("builds account-aware route-allowlist collectors", () => {
    const collectWarnings = createAllowlistProviderRouteAllowlistWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
      groups?: Record<string, unknown>;
    }>({
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.groups ?? {}).length > 0,
      restrictSenders: {
        surface: "Example groups",
        openScope: "any member in allowed groups",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      },
      noRouteAllowlist: {
        surface: "Example groups",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      },
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open", groups: {} },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyNoRouteAllowlistWarning({
        surface: "Example groups",
        routeAllowlistPath: "channels.example.groups",
        routeScope: "group",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
      }),
    ]);
  });

  it("builds account-aware configured-route collectors", () => {
    const collectWarnings = createOpenProviderConfiguredRouteWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
      channels?: Record<string, unknown>;
    }>({
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      resolveRouteAllowlistConfigured: (account) => Object.keys(account.channels ?? {}).length > 0,
      configureRouteAllowlist: {
        surface: "Example channels",
        openScope: "any channel not explicitly denied",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.channels",
      },
      missingRouteAllowlist: {
        surface: "Example channels",
        openBehavior: "with no route allowlist; any channel can trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
      },
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open", channels: { general: true } },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyConfigureRouteAllowlistWarning({
        surface: "Example channels",
        openScope: "any channel not explicitly denied",
        groupPolicyPath: "channels.example.groupPolicy",
        routeAllowlistPath: "channels.example.channels",
      }),
    ]);
  });

  it("builds config-aware open-provider collectors", () => {
    const collectWarnings = createOpenProviderGroupPolicyWarningCollector<{
      cfg: { channels?: { example?: Record<string, unknown> } };
      configuredGroupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: ({ configuredGroupPolicy }) => configuredGroupPolicy,
      collect: ({ groupPolicy }) => [groupPolicy],
    });

    expect(
      collectWarnings({
        cfg: { channels: { example: {} } },
        configuredGroupPolicy: "open",
      }),
    ).toEqual(["open"]);
  });

  it("builds account-aware simple open warning collectors", () => {
    const collectWarnings = createAllowlistProviderOpenWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      providerConfigPresent: (cfg) => cfg.channels?.example !== undefined,
      resolveGroupPolicy: (account) => account.groupPolicy,
      buildOpenWarning: {
        surface: "Example channels",
        openBehavior: "allows any channel to trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
      },
    });

    expect(
      collectWarnings({
        account: { groupPolicy: "open" },
        cfg: { channels: { example: {} } },
      }),
    ).toEqual([
      buildOpenGroupPolicyWarning({
        surface: "Example channels",
        openBehavior: "allows any channel to trigger (mention-gated)",
        remediation:
          'Set channels.example.groupPolicy="allowlist" and configure channels.example.channels',
      }),
    ]);
  });

  it("builds direct account-aware open-policy restrict-senders collectors", () => {
    const collectWarnings = createOpenGroupPolicyRestrictSendersWarningCollector<{
      groupPolicy?: "open" | "allowlist" | "disabled";
    }>({
      resolveGroupPolicy: (account) => account.groupPolicy,
      defaultGroupPolicy: "allowlist",
      surface: "Example groups",
      openScope: "any member",
      groupPolicyPath: "channels.example.groupPolicy",
      groupAllowFromPath: "channels.example.groupAllowFrom",
      mentionGated: false,
    });

    expect(collectWarnings({ groupPolicy: "allowlist" })).toEqual([]);
    expect(collectWarnings({ groupPolicy: "open" })).toEqual([
      buildOpenGroupPolicyRestrictSendersWarning({
        surface: "Example groups",
        openScope: "any member",
        groupPolicyPath: "channels.example.groupPolicy",
        groupAllowFromPath: "channels.example.groupAllowFrom",
        mentionGated: false,
      }),
    ]);
  });
});
