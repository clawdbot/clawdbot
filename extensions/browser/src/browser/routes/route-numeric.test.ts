import { describe, expect, it } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS } from "../timer-delay.js";
import { readRouteTimerTimeoutMs } from "./route-numeric.js";

describe("browser route numeric helpers", () => {
  it("caps timer timeout fields to Node-safe bounds", () => {
    expect(readRouteTimerTimeoutMs("12345")).toBe(12_345);
    expect(readRouteTimerTimeoutMs(String(Number.MAX_SAFE_INTEGER))).toBe(
      MAX_SAFE_TIMEOUT_DELAY_MS,
    );
  });

  it("preserves timeout validation errors", () => {
    expect(() => readRouteTimerTimeoutMs("1e3")).toThrow("timeoutMs must be a positive integer.");
  });

  it("honors route-specific minimums", () => {
    expect(readRouteTimerTimeoutMs("1", "timeoutMs", { minMs: 1_000 })).toBe(1_000);
  });
});
