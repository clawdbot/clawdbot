// Nextcloud Talk tests cover channel.status plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

  it("keeps API credential inspection off runtime resolution", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-talk-status-"));
    const apiPasswordFile = path.join(directory, "api-password");
    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "bot-secret",
          apiUser: "bot",
          apiPasswordFile,
        },
      },
    } satisfies CoreConfig;

    try {
      const account = nextcloudTalkPlugin.config.resolveAccount(cfg, "default");
      expect(account.apiCredentialStatus).toBeUndefined();
      expect(account.credentialDiagnostics).toBeUndefined();

      fs.writeFileSync(apiPasswordFile, "api-password\n", "utf8");
      const inspected = (await nextcloudTalkPlugin.config.inspectAccount?.(
        cfg,
        "default",
      )) as typeof account;
      expect(nextcloudTalkPlugin.config.describeAccount?.(inspected, cfg)).toMatchObject({
        configured: true,
        apiCredentialStatus: "available",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
