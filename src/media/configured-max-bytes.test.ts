import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGeneratedMediaMaxBytes } from "../plugin-sdk/media-generation-runtime.js";

const MB = 1024 * 1024;

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
