import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";

describe("nextcloud-talk channel status", () => {
  it("surfaces missing response feature probes as config issues", () => {
    const issues = nextcloudTalkPlugin.status?.collectStatusIssues?.([
      {
        accountId: "default",
        configured: true,
        probe: {
          ok: false,
          code: "missing_response_feature",
          message: "Nextcloud Talk bot is missing --feature response.",
        },
      },
    ]);

    expect(issues).toEqual([
      {
        channel: "nextcloud-talk",
        accountId: "default",
        kind: "config",
        message: "Nextcloud Talk bot is missing --feature response.",
        fix: "Add --feature response to the Talk bot.",
      },
    ]);
  });
});
