/**
 * Tests channel policy helper exports and policy decisions.
 */
import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import type { GroupPolicy } from "../config/types.base.js";
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  coerceNativeSetting,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
  createRestrictSendersChannelSecurity,
  evaluateGroupRouteAccessForPolicy,
  evaluateSenderGroupAccessForPolicy,
  normalizeAllowFromList,
  resolveSenderScopedGroupPolicy,
} from "./channel-policy.js";

describe("retained group policy helpers", () => {
  it.each([
    {
      name: "preserves disabled policy",
      input: { groupPolicy: "disabled" as const, groupAllowFrom: ["a"] },
      expected: "disabled",
    },
    {
      name: "keeps allowlist policy when sender allowlist is present",
      input: { groupPolicy: "allowlist" as const, groupAllowFrom: ["a"] },
      expected: "allowlist",
    },
    {
      name: "maps allowlist to open when sender allowlist is empty",
      input: { groupPolicy: "allowlist" as const, groupAllowFrom: [] },
      expected: "open",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveSenderScopedGroupPolicy(input)).toBe(expected);
  });

  it.each([
    {
      name: "blocks disabled sender policy",
      input: {
        groupPolicy: "disabled" as const,
        groupAllowFrom: ["123"],
        senderId: "123",
        isSenderAllowed: (): boolean => true,
      },
      expected: {
        allowed: false,
        reason: "disabled",
        groupPolicy: "disabled",
        providerMissingFallbackApplied: false,
      },
    },
    {
      name: "blocks sender allowlist with an empty list",
      input: {
        groupPolicy: "allowlist" as const,
        groupAllowFrom: [],
        senderId: "123",
        isSenderAllowed: (): boolean => true,
      },
      expected: {
        allowed: false,
        reason: "empty_allowlist",
        groupPolicy: "allowlist",
        providerMissingFallbackApplied: false,
      },
    },
  ])("$name", ({ input, expected }) => {
    expect(evaluateSenderGroupAccessForPolicy(input)).toEqual(expected);
  });

  it.each([
    {
      name: "blocks disabled route policy",
      input: {
        groupPolicy: "disabled" as const,
        routeAllowlistConfigured: true,
        routeMatched: true,
        routeEnabled: true,
      },
      reason: "disabled",
    },
    {
      name: "blocks an empty route allowlist",
      input: {
        groupPolicy: "allowlist" as const,
        routeAllowlistConfigured: false,
        routeMatched: false,
      },
      reason: "empty_allowlist",
    },
    {
      name: "blocks an unmatched allowlisted route",
      input: {
        groupPolicy: "allowlist" as const,
        routeAllowlistConfigured: true,
        routeMatched: false,
      },
      reason: "route_not_allowlisted",
    },
    {
      name: "blocks a disabled matched route",
      input: {
        groupPolicy: "open" as const,
        routeAllowlistConfigured: true,
        routeMatched: true,
        routeEnabled: false,
      },
      reason: "route_disabled",
    },
  ])("$name", ({ input, reason }) => {
    expect(evaluateGroupRouteAccessForPolicy(input)).toMatchObject({ allowed: false, reason });
  });
});

describe("mutable allowlist table helpers", () => {
  it("collects standard account, DM, and nested group lists in stable order", () => {
    expect(
      collectStandardAllowlistLists(
        {
          prefix: "channels.demo",
          account: {
            allowFrom: ["user"],
            groupAllowFrom: ["group-user"],
            dm: { allowFrom: ["dm-user"] },
            rooms: { general: { users: ["room-user"] } },
          },
        },
        { includeDm: true, includeGroups: true, groupsKey: "rooms", groupField: "users" },
      ),
    ).toEqual([
      { pathLabel: "channels.demo.allowFrom", list: ["user"] },
      { pathLabel: "channels.demo.groupAllowFrom", list: ["group-user"] },
      { pathLabel: "channels.demo.dm.allowFrom", list: ["dm-user"] },
      { pathLabel: "channels.demo.rooms.general.users", list: ["room-user"] },
    ]);
  });

  it("builds a detector from prefixes and a stable-id pattern", () => {
    const detector = buildMutableAllowEntryDetector({
      prefixes: ["", "demo:", "user:"],
      stableIdPattern: /^U\d+$/,
    });
    expect(detector("demo:user:U123")).toBe(false);
    expect(detector("demo:alice")).toBe(true);
    expect(detector("*")).toBe(false);
    expect(detector("accessGroup:operators")).toBe(false);
  });
});

describe("createRestrictSendersChannelSecurity", () => {
  it("builds dm policy resolution and open-group warnings from one descriptor", () => {
    const dmRouting = {
      resolveDmScope: () => "per-peer" as const,
      resolveDmRoute: () => ({ kind: "core" as const }),
    };
    const security = createRestrictSendersChannelSecurity<{
      accountId: string;
      allowFrom?: string[];
      dmPolicy?: string;
      groupPolicy?: GroupPolicy;
    }>({
      channelKey: "line",
      resolveDmPolicy: (account) => account.dmPolicy,
      resolveDmAllowFrom: (account) => account.allowFrom,
      resolveGroupPolicy: (account) => account.groupPolicy,
      surface: "LINE groups",
      openScope: "any member in groups",
      groupPolicyPath: "channels.line.groupPolicy",
      groupAllowFromPath: "channels.line.groupAllowFrom",
      mentionGated: false,
      findingTitle: "LINE security warning",
      policyPathSuffix: "dmPolicy",
      classifyEntryAuthentication: () => "asserted",
      dmRouting,
    });

    expect(security.dmRouting).toBe(dmRouting);

    expect(
      security.resolveDmPolicy?.({
        cfg: { channels: {} } as never,
        accountId: "default",
        account: {
          accountId: "default",
          dmPolicy: "allowlist",
          allowFrom: ["line:user:abc"],
        },
      }),
    ).toEqual({
      policy: "allowlist",
      allowFrom: ["line:user:abc"],
      policyPath: "channels.line.dmPolicy",
      allowFromPath: "channels.line.",
      approveHint: formatPairingApproveHint("line"),
      normalizeEntry: undefined,
      classifyEntryAuthentication: expect.any(Function),
    });

    expect(
      security
        .resolveDmPolicy?.({
          cfg: {},
          accountId: "default",
          account: { accountId: "default" },
        })
        ?.classifyEntryAuthentication?.("line:user:abc"),
    ).toBe("asserted");

    expect(
      security.collectWarnings?.({
        cfg: { channels: { line: {} } } as never,
        accountId: "default",
        account: {
          accountId: "default",
          groupPolicy: "open",
        },
      }),
    ).toEqual([
      {
        checkId: "channels.line.groups.open",
        severity: "critical",
        title: "LINE security warning",
        detail:
          'LINE groups: groupPolicy="open" allows any member in groups to trigger. Set channels.line.groupPolicy="allowlist" + channels.line.groupAllowFrom to restrict senders.',
      },
    ]);
  });
});

describe("createDangerousNameMatchingMutableAllowlistWarningCollector", () => {
  const collectWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "irc",
    detector: (entry) => !entry.includes("@"),
    collectLists: (scope) => [
      {
        pathLabel: `${scope.prefix}.allowFrom`,
        list: scope.account.allowFrom,
      },
    ],
  });

  it("collects mutable entries while dangerous matching is disabled", () => {
    expect(
      collectWarnings({
        cfg: {
          channels: {
            irc: {
              allowFrom: ["charlie"],
            },
          },
        } as never,
      }),
    ).toEqual([
      "- Found 1 mutable allowlist entry across irc while name matching is disabled by default.",
      "- channels.irc.allowFrom: charlie",
      "- Option A (break-glass): enable channels.irc.dangerouslyAllowNameMatching=true to keep name/email/nick matching.",
      "- Option B (recommended): resolve names/emails/nicks to stable sender IDs and rewrite the allowlist entries.",
    ]);
  });

  it("skips scopes that explicitly allow dangerous name matching", () => {
    expect(
      collectWarnings({
        cfg: {
          channels: {
            irc: {
              dangerouslyAllowNameMatching: true,
              allowFrom: ["charlie"],
            },
          },
        } as never,
      }),
    ).toStrictEqual([]);
  });
});

describe("normalizeAllowFromList", () => {
  it("normalizes strings and numbers into trimmed entries", () => {
    expect(normalizeAllowFromList(["  abc ", 42, "", "   "])).toEqual(["abc", "42"]);
  });

  it("returns an empty list for non-arrays", () => {
    expect(normalizeAllowFromList(undefined)).toStrictEqual([]);
    expect(normalizeAllowFromList(null)).toStrictEqual([]);
  });
});

describe("coerceNativeSetting", () => {
  it("keeps boolean and auto values", () => {
    expect(coerceNativeSetting(true)).toBe(true);
    expect(coerceNativeSetting(false)).toBe(false);
    expect(coerceNativeSetting("auto")).toBe("auto");
  });

  it("drops unsupported values", () => {
    expect(coerceNativeSetting("true")).toBeUndefined();
    expect(coerceNativeSetting("on")).toBeUndefined();
    expect(coerceNativeSetting(1)).toBeUndefined();
  });
});
