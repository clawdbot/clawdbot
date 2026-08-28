// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
import { describe, expect, it } from "vitest";
import { formatContinuationBannerValue } from "./status.command-report-data.ts";

describe("formatContinuationBannerValue (status /status continuation banner, RFC §6.3)", () => {
  const baseEnabled = {
    enabled: true as const,
    maxChainLength: 10,
    maxDelegatesPerTurn: 5,
    pendingDelegatesRecent: 0,
    postCompactionStagedRecent: 0,
  };

  it("returns undefined when continuation is disabled — overview row is omitted", () => {
    expect(
      formatContinuationBannerValue({
        ...baseEnabled,
        enabled: false,
      }),
    ).toBeUndefined();
  });

  it("config-only fallback when enabled and all runtime counters are zero (quiet session)", () => {
    expect(formatContinuationBannerValue(baseEnabled)).toBe(
      "enabled · chain max 10 · fan-out max 5",
    );
  });

  it("surfaces pending delegates when non-zero — plural", () => {
    expect(
      formatContinuationBannerValue({
        ...baseEnabled,
        pendingDelegatesRecent: 2,
      }),
    ).toBe("enabled · chain max 10 · 2 delegates pending (recent sessions) · fan-out max 5");
  });

  it("surfaces single pending delegate with singular noun", () => {
    expect(
      formatContinuationBannerValue({
        ...baseEnabled,
        pendingDelegatesRecent: 1,
      }),
    ).toBe("enabled · chain max 10 · 1 delegate pending (recent sessions) · fan-out max 5");
  });

  it("surfaces post-compaction staged count when non-zero", () => {
    expect(
      formatContinuationBannerValue({
        ...baseEnabled,
        postCompactionStagedRecent: 1,
      }),
    ).toBe("enabled · chain max 10 · 1 post-compaction (recent sessions) · fan-out max 5");
  });

  it("surfaces both pending and post-compaction staged when both non-zero (active session shape)", () => {
    expect(
      formatContinuationBannerValue({
        ...baseEnabled,
        pendingDelegatesRecent: 2,
        postCompactionStagedRecent: 1,
      }),
    ).toBe(
      "enabled · chain max 10 · 2 delegates pending (recent sessions) · 1 post-compaction (recent sessions) · fan-out max 5",
    );
  });
});
