import { describe, expect, it } from "vitest";
import { formatPairingApproveHint } from "../channels/plugins/helpers.js";
import type { GroupPolicy } from "../config/types.base.js";
import {
  coerceNativeSetting,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
  createRestrictSendersChannelSecurity,
  normalizeAllowFromList,
} from "./channel-policy.js";

describe("createRestrictSendersChannelSecurity", () => {
  it("builds dm policy resolution and open-group warnings from one descriptor", () => {
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
      policyPathSuffix: "dmPolicy",
    });

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
    });

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
      '- LINE groups: groupPolicy="open" allows any member in groups to trigger. Set channels.line.groupPolicy="allowlist" + channels.line.groupAllowFrom to restrict senders.',
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
