// Config write resolution contract tests cover channel plugin config write normalization.
import { describe, expect, it } from "vitest";
import { resolveChannelConfigWrites } from "../../../plugin-sdk/channel-config-helpers.js";

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

describe("resolveChannelConfigWrites", () => {
  function expectResolvedChannelConfigWrites(params: {
    cfg: Record<string, unknown>;
    channelId: string;
    accountId?: string;
    expected: boolean;
  }) {
    expect(
      resolveChannelConfigWrites({
        cfg: params.cfg,
        channelId: params.channelId,
        ...(params.accountId ? { accountId: params.accountId } : {}),
      }),
    ).toBe(params.expected);
  }

  it.each([
    {
      name: "defaults to allow when unset",
      cfg: {},
      channelId: demoOriginChannelId,
      expected: true,
    },
    {
      name: "blocks when channel config disables writes",
      cfg: { channels: { [demoOriginChannelId]: { configWrites: false } } },
      channelId: demoOriginChannelId,
      expected: false,
    },
    {
      name: "account override wins over channel default",
      cfg: makeDemoConfigWritesCfg("work"),
      channelId: demoOriginChannelId,
      accountId: "work",
      expected: false,
    },
    {
      name: "matches account ids case-insensitively",
      cfg: makeDemoConfigWritesCfg("Work"),
      channelId: demoOriginChannelId,
      accountId: "work",
      expected: false,
    },
  ] as const)("$name", (testCase) => {
    expectResolvedChannelConfigWrites(testCase);
  });
});
