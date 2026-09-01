import { describe, expect, it } from "vitest";
import {
  resolveAdmittedCronCompletionStatus,
  resolveCronCompletionStatus,
} from "./completion-status.js";

describe("resolveAdmittedCronCompletionStatus", () => {
  it("fails a stale-suppressed default announce delivery so the one-shot is retained (#131491)", () => {
    // The stale-run guard records a plain not-delivered outcome with no
    // suppression reason; requested delivery is required unless explicitly
    // best-effort, so discarding the run's only deliverable can never resolve
    // to a successful completion that would retire the one-shot.
    expect(
      resolveAdmittedCronCompletionStatus(
        { delivery: { mode: "announce" } },
        "ok",
        "not-delivered",
      ),
    ).toBe("failed");
  });

  it("keeps intentional silence successful without claiming delivery", () => {
    expect(
      resolveAdmittedCronCompletionStatus(
        { delivery: { mode: "announce" } },
        "ok",
        "not-delivered",
        "silent",
      ),
    ).toBe("succeeded");
  });

  it("keeps delivered and error outcomes unchanged", () => {
    expect(
      resolveAdmittedCronCompletionStatus({ delivery: { mode: "announce" } }, "ok", "delivered"),
    ).toBe("succeeded");
    expect(
      resolveAdmittedCronCompletionStatus(
        { delivery: { mode: "announce" } },
        "error",
        "not-delivered",
      ),
    ).toBe("failed");
    expect(
      resolveAdmittedCronCompletionStatus({ delivery: { mode: "announce" } }, "ok", "unknown"),
    ).toBe("unknown");
    expect(
      resolveAdmittedCronCompletionStatus({ delivery: { mode: "none" } }, "ok", "not-requested"),
    ).toBe("succeeded");
  });
});

describe("resolveCronCompletionStatus", () => {
  it("resolves legacy stored facts without a required-delivery contract", () => {
    expect(resolveCronCompletionStatus({ status: "ok", deliveryStatus: "not-requested" })).toBe(
      "succeeded",
    );
    expect(resolveCronCompletionStatus({ status: "ok", delivered: true })).toBe("succeeded");
    expect(resolveCronCompletionStatus({ status: "ok", deliveryStatus: "not-delivered" })).toBe(
      "unknown",
    );
  });
});
