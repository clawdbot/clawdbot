import { describe, expect, it } from "vitest";
import {
  buildCronCommandSummary,
  redactCronCommandSummaryForExternalDelivery,
} from "./command-output-summary.js";

describe("cron command output summaries", () => {
  it("prepends preserved action lines that were truncated out of the captured tail", () => {
    const summary = buildCronCommandSummary({
      stdout: "tail only",
      stderr: "",
      preservedStdoutLines: ["Visit https://example.com/device and enter code ABCD-EFGH"],
    });

    expect(summary).toBe(
      "action-required output preserved:\nVisit https://example.com/device and enter code ABCD-EFGH\n\ntail only",
    );
  });

  it("redacts action-required URLs and codes before external cron delivery", () => {
    const summary =
      "action-required output preserved:\nVisit https://example.com/device or www.example.com/device and enter code ABCD-EFGH\n\ncompleted";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nVisit [redacted-url] or [redacted-url] and enter code [redacted-code]\n\ncompleted",
    );
  });

  it("redacts numeric and unseparated codes on action-required lines", () => {
    const summary =
      "action-required output preserved:\nEnter code 123456\nCopy this code ABCDEF12\n\nBuild 123456 is complete";

    expect(redactCronCommandSummaryForExternalDelivery(summary)).toBe(
      "action-required output preserved:\nEnter code [redacted-code]\nCopy this code [redacted-code]\n\nBuild 123456 is complete",
    );
  });

  it("masks token assignments on action-required lines before external delivery", () => {
    const summary =
      "action-required output preserved:\nLog in with token=opaque-secret-value\n\nLog in with token=opaque-secret-value";

    const redacted = redactCronCommandSummaryForExternalDelivery(summary);

    expect(redacted).not.toContain("opaque-secret-value");
    expect(redacted).toContain("token=***");
  });
});
