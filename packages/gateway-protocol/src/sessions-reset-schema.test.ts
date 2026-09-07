import { expect, test } from "vitest";
import { validateSessionsResetParams } from "./index.js";

test("sessions.reset validates an expected session ID", () => {
  expect(
    validateSessionsResetParams({
      key: "agent:main:main",
      expectedSessionId: "session-before-reset",
    }),
  ).toBe(true);
  expect(validateSessionsResetParams({ key: "agent:main:main", expectedSessionId: "" })).toBe(
    false,
  );
});
