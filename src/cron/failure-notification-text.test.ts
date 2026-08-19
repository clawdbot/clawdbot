import { describe, expect, it } from "vitest";
import { cronFailureDetailLines } from "./failure-notification-text.js";

const GENERIC_DETAIL = "Check automation history for details.";

describe("cronFailureDetailLines", () => {
  it.each(["timeout", "rate_limit"] as const)("keeps classified %s failures compact", (reason) => {
    expect(cronFailureDetailLines(reason, "token=opaque-secret-value\nstack body")).toEqual([
      `Cause: ${reason}`,
    ]);
  });

  it.each([
    [
      "external wrapper",
      'upstream rejected response\n<<<EXTERNAL_UNTRUSTED_CONTENT id="deadbeefdeadbeef">>>\nprivate body',
    ],
    [
      "security notice",
      "SECURITY NOTICE: The following content is from an EXTERNAL, UNTRUSTED source (e.g., email, webhook).\nprivate body",
    ],
    ["empty detail", "\n \r\n"],
  ])("uses the generic fallback for %s", (_name, error) => {
    expect(cronFailureDetailLines(undefined, error)).toEqual([GENERIC_DETAIL]);
  });

  it("sanitizes controls and collapses whitespace from the first non-empty line", () => {
    const error = "\n\u001b[31m  cron\t script \u0007 failed  \u001b[0m\nstack body";

    expect(cronFailureDetailLines(undefined, error)).toEqual(["Last error: cron script failed"]);
  });

  it("truncates without splitting a UTF-16 surrogate pair", () => {
    const error = `${"x".repeat(198)}🎉trailing`;

    expect(cronFailureDetailLines(undefined, error)).toEqual([`Last error: ${"x".repeat(198)}…`]);
  });
});
