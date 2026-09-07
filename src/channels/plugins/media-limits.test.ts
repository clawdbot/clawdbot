import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveChannelMediaMaxBytes } from "../../plugin-sdk/account-helpers.js";

type LimitCase = {
  label: string;
  channel?: number;
  agent?: number;
  expected?: number;
};

const MIB = 1_048_576;

describe("channel media byte-cap contract", () => {
  it.each<LimitCase>([
    { label: "no configured maximum" },
    { label: "channel overrides agent", channel: 1, agent: 2, expected: MIB },
    { label: "fractional channel", channel: 0.001, agent: 1, expected: 1048 },
    { label: "fractional agent", agent: 0.001, expected: 1048 },
    { label: "sub-byte channel overrides agent", channel: 0.5 / MIB, agent: 1, expected: 0 },
    { label: "sub-byte agent", agent: 0.5 / MIB, expected: 0 },
    { label: "zero channel falls back", channel: 0, agent: 4 / MIB, expected: 4 },
    { label: "negative channel falls back", channel: -1, agent: 4 / MIB, expected: 4 },
    { label: "NaN channel falls back", channel: Number.NaN, agent: 4 / MIB, expected: 4 },
    {
      label: "infinite channel falls back",
      channel: Number.POSITIVE_INFINITY,
      agent: 4 / MIB,
      expected: 4,
    },
    { label: "zero agent is absent", agent: 0 },
    { label: "negative agent is absent", agent: -1 },
    { label: "NaN agent is absent", agent: Number.NaN },
    { label: "infinite agent is absent", agent: Number.POSITIVE_INFINITY },
  ])("$label", ({ channel, agent, expected }) => {
    const cfg: OpenClawConfig = { agents: { defaults: { mediaMaxMb: agent } } };
    const maxBytes = resolveChannelMediaMaxBytes({
      cfg,
      resolveChannelLimitMb: () => channel,
    });
    expect(maxBytes).toBe(expected);
  });
});
