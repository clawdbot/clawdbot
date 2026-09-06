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

  it.each(["\n", "\r\n"])("matches complete trimmed action lines with %j separators", (newline) => {
    const action = "Visit https://example.com/device";
    const stdout = `before${newline}  ${action}  ${newline}after`;
    expect(
      buildCronCommandSummary({
        stdout,
        stderr: "",
        preservedStdoutLines: [` ${action} `, "Copy this code ABCD-EFGH"],
      }),
    ).toBe(`action-required output preserved:\nCopy this code ABCD-EFGH\n\n${stdout}`);
  });

  it("retains missing actions in stream order, including duplicates across streams", () => {
    const action = "Visit https://example.com/device";
    const stdout = `prefix ${action} suffix`;
    expect(
      buildCronCommandSummary({
        stdout,
        stderr: "warning",
        preservedStdoutLines: [` ${action} `, action, "Copy this code ABCD-EFGH"],
        preservedStderrLines: [action],
      }),
    ).toBe(
      `action-required output preserved:\n${action}\nCopy this code ABCD-EFGH\n${action}\n\nstdout:\n${stdout}\n\nstderr:\nwarning`,
    );
  });

  it("keeps independent preservation quotas before checking the captured tail", () => {
    const stdoutLines = Array.from(
      { length: 12 },
      (_, index) => `Visit https://example.com/${index}`,
    );
    const stderrLine = "Copy this code ABCD-EFGH";
    expect(
      buildCronCommandSummary({
        stdout: stdoutLines.join("\n"),
        stderr: "",
        preservedStdoutLines: [...stdoutLines, "Visit https://example.com/outside-quota"],
        preservedStderrLines: [stderrLine],
      }),
    ).toBe(`action-required output preserved:\n${stderrLine}\n\n${stdoutLines.join("\n")}`);
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
