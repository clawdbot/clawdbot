import { describe, expect, it } from "vitest";
import {
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
} from "./restart-unavailable.js";

describe("gateway drain rejection detection", () => {
  it.each([
    ["gateway-restarting", isGatewayRestartUnavailableError],
    ["gateway-suspending", isGatewaySuspendUnavailableError],
  ] as const)("recognizes %s only from structured details", (reason, detect) => {
    expect(
      detect({
        code: "UNAVAILABLE",
        message: "Work admission is closed",
        retryable: true,
        details: { reason, phase: "draining" },
      }),
    ).toBe(true);
    expect(
      detect(Object.assign(new Error("Work admission is closed"), { details: { reason } })),
    ).toBe(true);
    for (const error of [
      undefined,
      null,
      reason,
      new Error(reason),
      { message: reason },
      { details: null },
      { details: reason },
      { details: {} },
      { details: { reason: "startup-sidecars" } },
      {
        details: {
          reason: reason === "gateway-suspending" ? "gateway-restarting" : "gateway-suspending",
        },
      },
    ]) {
      expect(detect(error)).toBe(false);
    }
  });
});
