// Tests heartbeat reason formatting and normalization.
import { describe, expect, it } from "vitest";
import {
  isHeartbeatActionWakeReason,
  isHeartbeatEventDrivenReason,
  normalizeHeartbeatWakeReason,
  resolveHeartbeatReasonKind,
} from "./heartbeat-reason.js";

describe("heartbeat-reason", () => {
  it.each([
    { value: "  cron:job-1  ", expected: "cron:job-1" },
    { value: "  ", expected: "requested" },
    { value: undefined, expected: "requested" },
  ])("normalizes wake reasons for %j", ({ value, expected }) => {
    expect(normalizeHeartbeatWakeReason(value)).toBe(expected);
  });

  it.each(["continuation", "silent-wake-enrichment", "delegate-return"])(
    "classifies %s as an event-driven wake",
    (reason) => {
      expect(resolveHeartbeatReasonKind(reason)).toBe("wake");
      expect(isHeartbeatEventDrivenReason(reason)).toBe(true);
    },
  );

  it("keeps delegate-return out of action-wake classification", () => {
    expect(isHeartbeatActionWakeReason("delegate-return")).toBe(false);
  });
});
