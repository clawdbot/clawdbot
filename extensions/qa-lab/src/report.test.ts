import { describe, expect, it } from "vitest";
import { renderQaMarkdownReport } from "./report.js";

describe("renderQaMarkdownReport", () => {
  it("renders multiline scenario details in fenced blocks", () => {
    const report = renderQaMarkdownReport({
      title: "QA",
      startedAt: new Date("2026-04-08T10:00:00.000Z"),
      finishedAt: new Date("2026-04-08T10:00:02.000Z"),
      scenarios: [
        {
          name: "Character vibes: Gollum improv",
          status: "pass",
          steps: [
            {
              name: "records transcript",
              status: "pass",
              details: "USER Alice: hello\n\nASSISTANT OpenClaw: my precious build",
            },
          ],
        },
      ],
    });

    expect(report).toContain("```text");
    expect(report).toContain("USER Alice: hello");
    expect(report).toContain("ASSISTANT OpenClaw: my precious build");
  });
});
