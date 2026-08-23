// Nextcloud Talk tests cover channel.status plugin behavior.
import { describe, expect, it } from "vitest";
import { nextcloudTalkPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

describe("nextcloud-talk channel status", () => {
  it("classifies room tokens as groups", () => {
    expect(nextcloudTalkPlugin.messaging?.inferTargetChatType?.({ to: "room:abcdefgh" })).toBe(
      "group",
    );
  });

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

  it("preserves API credential availability on the account status surface", () => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "bot-secret",
          apiUser: "bot",
          apiPassword: "api-password",
        },
      },
    } satisfies CoreConfig;

    const account = nextcloudTalkPlugin.config.resolveAccount(cfg, "default");

    expect(nextcloudTalkPlugin.config.describeAccount?.(account, cfg)).toMatchObject({
      configured: true,
      apiCredentialStatus: "available",
    });
  });
});
