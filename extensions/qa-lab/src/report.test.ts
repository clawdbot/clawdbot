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

    expect(report).toBe(`# QA

- Started: 2026-04-08T10:00:00.000Z
- Finished: 2026-04-08T10:00:02.000Z
- Duration ms: 2000
- Passed: 1
- Failed: 0


## Scenarios

### Character vibes: Gollum improv

- Status: pass
- Steps:
  - [x] records transcript
    - Details:

\`\`\`text
USER Alice: hello

ASSISTANT OpenClaw: my precious build
\`\`\`

`);
  });
});
