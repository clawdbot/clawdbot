import { describe, expect, it } from "vitest";
import { normalizeHeartbeatWakeReason } from "./heartbeat-reason.js";

describe("heartbeat-reason", () => {
  it.each([
    { value: "  cron:job-1  ", expected: "cron:job-1" },
    { value: "  ", expected: "requested" },
    { value: undefined, expected: "requested" },
  ])("normalizes wake reasons for %j", ({ value, expected }) => {
    expect(normalizeHeartbeatWakeReason(value)).toBe(expected);
  });
});
