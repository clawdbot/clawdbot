import { describe, expect, it } from "vitest";
import { resolveCronRunErrorReason } from "./run-error-reason.js";

describe("resolveCronRunErrorReason", () => {
  it("keeps permanent local script errors out of provider timeout classification", () => {
    expect(
      resolveCronRunErrorReason("cron script failed: request timed out", undefined, {
        kind: "permanent",
      }),
    ).toBeUndefined();
  });

  it("preserves genuine script timeout classification", () => {
    expect(
      resolveCronRunErrorReason("cron script failed", undefined, {
        kind: "reason",
        reason: "timeout",
      }),
    ).toBe("timeout");
  });

  it("preserves provider error classification for other cron failures", () => {
    expect(resolveCronRunErrorReason("internal_error from provider")).toBe("timeout");
  });
});
