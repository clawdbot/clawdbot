import { describe, expect, it } from "vitest";
import { SessionLifecycleBlockedError } from "../../sessions/session-lifecycle-blocker.js";
import { sessionWorkAdmissionErrorShape } from "./session-lifecycle-error.js";

describe("sessionWorkAdmissionErrorShape", () => {
  it("keeps temporary lifecycle blockers retryable", () => {
    expect(
      sessionWorkAdmissionErrorShape(
        new SessionLifecycleBlockedError("code_mode_non_quiescent", [
          "agent:main:main",
          "session-main",
        ]),
      ),
    ).toEqual({
      code: "UNAVAILABLE",
      message: "Session still has non-quiescent Code Mode tool work; retry after it settles.",
      retryable: true,
    });
  });

  it("preserves ordinary admission failures as invalid requests", () => {
    expect(sessionWorkAdmissionErrorShape(new Error("session is archived"))).toEqual({
      code: "INVALID_REQUEST",
      message: "Error: session is archived",
    });
  });
});
