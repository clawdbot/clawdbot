import { describe, expect, it } from "vitest";
import { collectBlueBubblesStatusIssues } from "./status-issues.js";

describe("collectBlueBubblesStatusIssues", () => {
  it("reports unconfigured enabled accounts", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "default",
        enabled: true,
        configured: false,
      },
    ]);

    expect(issues).toEqual([
      expect.objectContaining({
        channel: "bluebubbles",
        accountId: "default",
        kind: "config",
      }),
    ]);
  });

  it("reports probe failure and runtime error for configured running accounts", () => {
    const issues = collectBlueBubblesStatusIssues([
      {
        accountId: "work",
        enabled: true,
        configured: true,
        running: true,
        lastError: "timeout",
        probe: {
          ok: false,
          status: 503,
        },
      },
    ]);

    expect(issues).toHaveLength(2);
    expect(issues[0]).toEqual(
      expect.objectContaining({
        channel: "bluebubbles",
        accountId: "work",
        kind: "runtime",
      }),
    );
    expect(issues[1]).toEqual(
      expect.objectContaining({
        channel: "bluebubbles",
        accountId: "work",
        kind: "runtime",
        message: "Channel error: timeout",
      }),
    );
  });
});
