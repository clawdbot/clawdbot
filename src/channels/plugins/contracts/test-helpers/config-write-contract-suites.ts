import { describe, expect, it } from "vitest";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../../utils/message-channel.js";
import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
  resolveExplicitConfigWriteTarget,
  resolveConfigWriteTargetFromPath,
} from "../../config-writes.js";

const demoOriginChannelId = "demo-origin";
const demoTargetChannelId = "demo-target";

function makeDemoConfigWritesCfg(accountIdKey: string) {
  return {
    channels: {
      [demoOriginChannelId]: {
        configWrites: true,
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
      },
      [demoTargetChannelId]: {
        configWrites: true,
        accounts: {
          [accountIdKey]: { configWrites: false },
        },
      },
    },
  };
}

function expectConfigWriteBlocked(params: {
  disabledAccountId: string;
  reason: "target-disabled" | "origin-disabled";
  blockedScope: "target" | "origin";
}) {
  expect(
    authorizeConfigWrite({
      cfg: makeDemoConfigWritesCfg(params.disabledAccountId),
      origin: { channelId: demoOriginChannelId, accountId: "default" },
      target: resolveExplicitConfigWriteTarget({
        channelId: params.blockedScope === "target" ? demoTargetChannelId : demoOriginChannelId,
        accountId: "work",
      }),
    }),
  ).toEqual({
    allowed: false,
    reason: params.reason,
    blockedScope: {
      kind: params.blockedScope,
      scope: {
        channelId: params.blockedScope === "target" ? demoTargetChannelId : demoOriginChannelId,
        accountId: params.blockedScope === "target" ? "work" : "default",
      },
    },
  });
}

function expectAuthorizedConfigWriteCase(
  input: Parameters<typeof authorizeConfigWrite>[0],
  expected: ReturnType<typeof authorizeConfigWrite>,
) {
  expect(authorizeConfigWrite(input)).toEqual(expected);
}

function expectResolvedConfigWriteTargetCase(pathSegments: readonly string[], expected: unknown) {
  expect(resolveConfigWriteTargetFromPath([...pathSegments])).toEqual(expected);
}

function expectExplicitConfigWriteTargetCase(
  input: Parameters<typeof resolveExplicitConfigWriteTarget>[0],
  expected: ReturnType<typeof resolveExplicitConfigWriteTarget>,
) {
  expect(resolveExplicitConfigWriteTarget(input)).toEqual(expected);
}

function expectFormattedDeniedMessage(
  result: Exclude<ReturnType<typeof authorizeConfigWrite>, { allowed: true }>,
) {
  expect(
    formatConfigWriteDeniedMessage({
      result,
    }),
  ).toContain(`channels.${demoTargetChannelId}.accounts.work.configWrites=true`);
}

export function describeChannelConfigWritePolicyContract() {
  describe("authorizeConfigWrite policy contract", () => {
    it.each([
      {
        name: "blocks when a target account disables writes",
        disabledAccountId: "work",
        reason: "target-disabled",
        blockedScope: "target",
      },
      {
        name: "blocks when the origin account disables writes",
        disabledAccountId: "default",
        reason: "origin-disabled",
        blockedScope: "origin",
      },
    ] as const)("$name", (testCase) => {
      expectConfigWriteBlocked(testCase);
    });

    it.each([
      {
        name: "allows bypass for internal operator.admin writes",
        input: {
          cfg: makeDemoConfigWritesCfg("work"),
          origin: { channelId: demoOriginChannelId, accountId: "default" },
          target: resolveExplicitConfigWriteTarget({
            channelId: demoTargetChannelId,
            accountId: "work",
          }),
          allowBypass: canBypassConfigWritePolicy({
            channel: INTERNAL_MESSAGE_CHANNEL,
            gatewayClientScopes: ["operator.admin"],
          }),
        },
        expected: { allowed: true },
      },
      {
        name: "treats non-channel config paths as global writes",
        input: {
          cfg: makeDemoConfigWritesCfg("work"),
          origin: { channelId: demoOriginChannelId, accountId: "default" },
          target: resolveConfigWriteTargetFromPath(["messages", "ackReaction"]),
        },
        expected: { allowed: true },
      },
    ] as const)("$name", ({ input, expected }) => {
      expectAuthorizedConfigWriteCase(input, expected);
    });
  });
}

export function describeChannelConfigWriteTargetContract() {
  describe("authorizeConfigWrite target contract", () => {
    it.each([
      {
        name: "rejects bare channel collection writes",
        pathSegments: ["channels", "demo-channel"],
        expected: { kind: "ambiguous", scopes: [{ channelId: "demo-channel" }] },
      },
      {
        name: "rejects account collection writes",
        pathSegments: ["channels", "demo-channel", "accounts"],
        expected: { kind: "ambiguous", scopes: [{ channelId: "demo-channel" }] },
      },
    ] as const)("$name", ({ pathSegments, expected }) => {
      expectResolvedConfigWriteTargetCase(pathSegments, expected);
    });

    it.each([
      {
        name: "resolves explicit channel target",
        input: { channelId: demoOriginChannelId },
        expected: {
          kind: "channel",
          scope: { channelId: demoOriginChannelId },
        },
      },
      {
        name: "resolves explicit account target",
        input: { channelId: demoTargetChannelId, accountId: "work" },
        expected: {
          kind: "account",
          scope: { channelId: demoTargetChannelId, accountId: "work" },
        },
      },
    ] as const)("$name", ({ input, expected }) => {
      expectExplicitConfigWriteTargetCase(input, expected);
    });

    it.each([
      {
        name: "formats denied messages consistently",
        result: {
          allowed: false,
          reason: "target-disabled",
          blockedScope: {
            kind: "target",
            scope: { channelId: demoTargetChannelId, accountId: "work" },
          },
        } as const,
      },
    ] as const)("$name", ({ result }) => {
      expectFormattedDeniedMessage(result);
    });
  });
}
