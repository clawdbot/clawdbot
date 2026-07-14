// Covers config validation issue formatting for user-facing output.
import { describe, expect, it } from "vitest";
import {
  formatConfigIssueLine,
  formatConfigIssueLines,
  formatConfigIssueSummary,
  normalizeConfigIssues,
} from "./issue-format.js";

describe("config issue format", () => {
  it("formats issue lines with and without markers", () => {
    expect(formatConfigIssueLine({ path: "", message: "broken" }, "-")).toBe("- : broken");
    expect(
      formatConfigIssueLine({ path: "", message: "broken" }, "-", { normalizeRoot: true }),
    ).toBe("- <root>: broken");
    expect(formatConfigIssueLine({ path: "gateway.bind", message: "invalid" }, "")).toBe(
      "gateway.bind: invalid",
    );
    expect(
      formatConfigIssueLines(
        [
          { path: "", message: "first" },
          { path: "channels.signal.dmPolicy", message: "second" },
        ],
        "×",
        { normalizeRoot: true },
      ),
    ).toEqual(["× <root>: first", "× channels.signal.dmPolicy: second"]);
  });

  it("sanitizes control characters and ANSI sequences in formatted lines", () => {
    expect(
      formatConfigIssueLine(
        {
          path: "gateway.\nbind\x1b[31m",
          message: "bad\r\n\tvalue\x1b[0m\u0007",
        },
        "-",
      ),
    ).toBe("- gateway.\\nbind: bad\\r\\n\\tvalue");
  });

  it("formats concise issue summaries", () => {
    expect(formatConfigIssueSummary([])).toBeNull();
    expect(
      formatConfigIssueSummary(
        [
          { path: "", message: "root broken" },
          { path: "gateway.auth.password.source", message: "Required" },
          { path: "agents.defaults.execution", message: "Unrecognized key" },
        ],
        { maxIssues: 2 },
      ),
    ).toBe("<root>: root broken; gateway.auth.password.source: Required; and 1 more");
  });

  it("normalizes issue collections for machine output", () => {
    expect(
      normalizeConfigIssues([
        {
          path: "update.channel",
          message: "invalid",
          allowedValues: [],
          allowedValuesHiddenCount: 2,
        },
      ]),
    ).toEqual([{ path: "update.channel", message: "invalid" }]);
  });
});
