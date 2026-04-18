import { describe, expect, it, vi } from "vitest";
import {
  collectOpenPolicyAllowFromWarnings,
  maybeRepairOpenPolicyAllowFrom,
} from "./open-policy-allowfrom.js";

vi.mock("../channel-capabilities.js", () => ({
  getDoctorChannelCapabilities: (channelName?: string) => ({
    dmAllowFromMode:
      channelName === "googlechat" || channelName === "matrix" ? "nestedOnly" : "topOrNested",
    groupModel: "sender",
    groupAllowFromFallbackToAllowFrom: true,
    warnOnEmptyGroupSenderAllowlist: true,
  }),
}));

describe("doctor open-policy allowFrom repair", () => {
  it('adds top-level wildcard when dmPolicy="open" has no allowFrom', () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        signal: {
          dmPolicy: "open",
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.signal?.allowFrom).toEqual(["*"]);
  });

  it("repairs nested-only googlechat dm allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        googlechat: {
          dm: {
            policy: "open",
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.googlechat.dm.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.googlechat?.dm?.allowFrom).toEqual(["*"]);
  });

  it("repairs nested-only matrix dm allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        matrix: {
          dm: {
            policy: "open",
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.matrix.dm.allowFrom: set to ["*"] (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.matrix?.allowFrom).toBeUndefined();
    expect(result.config.channels?.matrix?.dm?.allowFrom).toEqual(["*"]);
  });

  it("appends wildcard to discord nested dm allowFrom when top-level is absent", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          dm: {
            policy: "open",
            allowFrom: ["123"],
          },
        },
      },
    });

    expect(result.changes).toEqual([
      '- channels.discord.dmPolicy: set to "open" (migrated from channels.discord.dm.policy)',
      '- channels.discord.dm.allowFrom: added "*" (required by dmPolicy="open")',
    ]);
    expect(result.config.channels?.discord?.allowFrom).toBeUndefined();
    expect(result.config.channels?.discord?.dm?.allowFrom).toEqual(["123", "*"]);
  });

  it("appends wildcard to existing top-level allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        slack: {
          dmPolicy: "open",
          allowFrom: ["U123"],
        },
      },
    });

    expect(result.config.channels?.slack?.allowFrom).toEqual(["U123", "*"]);
  });

  it("skips top-level allowFrom that already includes a wildcard", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          dmPolicy: "open",
          allowFrom: ["*"],
        },
      },
    });

    expect(result.changes).toEqual([]);
    expect(result.config.channels?.discord?.allowFrom).toEqual(["*"]);
  });

  it("repairs per-account open dmPolicy without allowFrom", () => {
    const result = maybeRepairOpenPolicyAllowFrom({
      channels: {
        discord: {
          accounts: {
            work: {
              dmPolicy: "open",
            },
          },
        },
      },
    });

    expect(result.config.channels?.discord?.accounts?.work?.allowFrom).toEqual(["*"]);
  });

  it("formats open-policy wildcard warnings", () => {
    const warnings = collectOpenPolicyAllowFromWarnings({
      changes: ['- channels.signal.allowFrom: set to ["*"] (required by dmPolicy="open")'],
      doctorFixCommand: "openclaw doctor --fix",
    });

    expect(warnings).toEqual([
      expect.stringContaining('channels.signal.allowFrom: set to ["*"]'),
      expect.stringContaining('Run "openclaw doctor --fix"'),
    ]);
  });
});
