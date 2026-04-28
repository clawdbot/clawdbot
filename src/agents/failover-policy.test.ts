import { describe, expect, it } from "vitest";
import {
  shouldAllowCooldownProbeForReason,
  shouldPreserveTransientCooldownProbeSlot,
  shouldUseTransientCooldownProbeSlot,
} from "./failover-policy.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";

type ReasonCase = {
  reason: FailoverReason | null | undefined;
  allowCooldownProbe: boolean;
  useTransientProbeSlot: boolean;
  preserveTransientProbeSlot: boolean;
};

const CASES: ReasonCase[] = [
  {
    reason: "rate_limit",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "overloaded",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "billing",
    allowCooldownProbe: true,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "unknown",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "empty_response",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "no_error_details",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "unclassified",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: "model_not_found",
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: true,
  },
  {
    reason: "format",
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: true,
  },
  {
    reason: "auth",
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: true,
  },
  {
    reason: "auth_permanent",
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: true,
  },
  {
    reason: "session_expired",
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: true,
  },
  {
    reason: "timeout",
    allowCooldownProbe: true,
    useTransientProbeSlot: true,
    preserveTransientProbeSlot: false,
  },
  {
    reason: null,
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: false,
  },
  {
    reason: undefined,
    allowCooldownProbe: false,
    useTransientProbeSlot: false,
    preserveTransientProbeSlot: false,
  },
];

describe("failover-policy", () => {
  it("maps failover reasons to cooldown-probe decisions", () => {
    for (const testCase of CASES) {
      expect(shouldAllowCooldownProbeForReason(testCase.reason)).toBe(testCase.allowCooldownProbe);
      expect(shouldUseTransientCooldownProbeSlot(testCase.reason)).toBe(
        testCase.useTransientProbeSlot,
      );
      expect(shouldPreserveTransientCooldownProbeSlot(testCase.reason)).toBe(
        testCase.preserveTransientProbeSlot,
      );
    }
  });
});
