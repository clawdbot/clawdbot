import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGeneratedMediaMaxBytes } from "../plugin-sdk/media-generation-runtime.js";
import { resolveOutboundMediaMaxBytes } from "./configured-max-bytes.js";

const MB = 1024 * 1024;

describe("outbound routed account media limits", () => {
  it.each([
    { accountId: "roomy", accounts: { Roomy: { mediaMaxMb: 2 } }, expected: 2 },
    {
      accountId: "roomy",
      accounts: { Roomy: { mediaMaxMb: 2 }, roomy: { mediaMaxMb: 3 } },
      expected: 3,
    },
    { accountId: "absent", accounts: { Roomy: { mediaMaxMb: 2 } }, expected: 1 },
    { accountId: undefined, accounts: { Roomy: { mediaMaxMb: 2 } }, expected: 1 },
  ])(
    "uses the selected $accountId account cap with exact-key precedence",
    ({ accountId, accounts, expected }) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { mediaMaxMb: 4 } },
        channels: { "qa-channel": { mediaMaxMb: 1, accounts } },
      };
      expect(resolveOutboundMediaMaxBytes({ cfg, channel: "qa-channel", accountId })).toBe(
        expected * MB,
      );
    },
  );
});

function configWithMediaMaxMb(mediaMaxMb: number): OpenClawConfig {
  return { agents: { defaults: { mediaMaxMb } } } as OpenClawConfig;
}

describe("resolveGeneratedMediaMaxBytes", () => {
  it.each([
    { kind: "image" as const, expected: 6 * MB },
    { kind: "audio" as const, expected: 16 * MB },
    { kind: "video" as const, expected: 16 * MB },
  ])("uses the $kind default when mediaMaxMb is unset", ({ kind, expected }) => {
    expect(resolveGeneratedMediaMaxBytes(undefined, kind)).toBe(expected);
  });

  it.each([
    { label: "zero", value: 0 },
    { label: "negative", value: -1 },
    { label: "NaN", value: Number.NaN },
    { label: "positive infinity", value: Number.POSITIVE_INFINITY },
  ])("uses the per-kind default for $label mediaMaxMb", ({ value }) => {
    expect(resolveGeneratedMediaMaxBytes(configWithMediaMaxMb(value), "image")).toBe(6 * MB);
  });

  it("floors fractional configured megabytes to whole bytes", () => {
    const mediaMaxMb = 1.000_001;

    expect(resolveGeneratedMediaMaxBytes(configWithMediaMaxMb(mediaMaxMb), "audio")).toBe(
      Math.floor(mediaMaxMb * MB),
    );
  });
});
