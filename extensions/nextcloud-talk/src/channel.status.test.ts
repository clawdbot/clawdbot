// Nextcloud Talk tests cover channel.status plugin behavior.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { nextcloudTalkPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

describe("nextcloud-talk channel status", () => {
  it.each([
    { botSecret: "bot-secret", baseUrl: "https://cloud.example.com", configured: true },
    {
      botSecret: { source: "env" as const, provider: "default", id: "MISSING_TALK_SECRET" },
      baseUrl: "https://cloud.example.com",
      configured: true,
    },
    { botSecret: undefined, baseUrl: "https://cloud.example.com", configured: false },
    { botSecret: "bot-secret", baseUrl: undefined, configured: false },
  ])("inspects webhook configuration as configured=$configured", async (entry) => {
    const cfg = {
      channels: {
        "nextcloud-talk": {
          accounts: { work: { botSecret: entry.botSecret, baseUrl: entry.baseUrl } },
        },
      },
    } satisfies CoreConfig;
    const account = inspectNextcloudTalkAccount({ cfg, accountId: "work" });
    expect(await nextcloudTalkPlugin.config.isConfigured?.(account, cfg)).toBe(entry.configured);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: entry.configured,
      mode: "webhook",
      apiCredentialStatus: "missing",
    });
    expect(account.baseUrl).toBe(entry.baseUrl ?? "");
    expect(await nextcloudTalkPlugin.config.inspectAccount?.(cfg, "work")).toMatchObject({
      configured: entry.configured,
      baseUrl: entry.baseUrl ? "[set]" : "[missing]",
    });
  });

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
      expect(inspected).toMatchObject({
        configured: true,
        apiCredentialStatus: "available",
        secretSource: "config",
        mode: "webhook",
        baseUrl: "[set]",
      });
      expect(nextcloudTalkPlugin.config.describeAccount?.(inspected, cfg)).toMatchObject({
        configured: true,
        apiCredentialStatus: "available",
      });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports an unavailable API password ref without using a lower-priority file", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nextcloud-talk-api-ref-"));
    const apiPasswordFile = path.join(directory, "api-password");
    fs.writeFileSync(apiPasswordFile, "lower-priority-password\n", "utf8");
    const accountConfig = {
      baseUrl: "https://cloud.example.com",
      botSecret: "bot-secret",
      apiUser: "bot",
      apiPassword: { source: "env", provider: "default", id: "MISSING_TALK_API_PASSWORD" },
      apiPasswordFile,
    } as const;
    const cfg = {
      channels: { "nextcloud-talk": { accounts: { work: accountConfig } } },
    } satisfies CoreConfig;

    try {
      expect(() => resolveNextcloudTalkApiCredentials(accountConfig)).toThrow(
        /unresolved SecretRef/,
      );
      const inspected = await nextcloudTalkPlugin.config.inspectAccount?.(cfg, "work");
      expect(inspected).toMatchObject({
        accountId: "work",
        configured: true,
        tokenStatus: "available",
        apiCredentialStatus: "configured_unavailable",
      });
      expect(JSON.stringify(inspected)).not.toContain("lower-priority-password");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
