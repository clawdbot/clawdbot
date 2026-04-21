import { describe, expect, it } from "vitest";
import { collectSynologyChatSecurityAuditFindings } from "./security-audit.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

function createAccount(params: {
  accountId: string;
  dangerouslyAllowNameMatching?: boolean;
}): ResolvedSynologyChatAccount {
  return {
    accountId: params.accountId,
    enabled: true,
    token: "t",
    incomingUrl: "https://nas.example.com/incoming",
    nasHost: "https://nas.example.com",
    webhookPath: "/webapi/entry.cgi",
    webhookPathSource: "explicit",
    dangerouslyAllowNameMatching: params.dangerouslyAllowNameMatching ?? false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "allowlist",
    allowedUserIds: [],
    rateLimitPerMinute: 30,
    botName: "OpenClaw",
    allowInsecureSsl: false,
  };
}

describe("Synology Chat security audit findings", () => {
  it.each([
    {
      name: "audits base dangerous name matching",
      accountId: "default",
      orderedAccountIds: [] as string[],
      hasExplicitAccountPath: false,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: "Synology Chat dangerous name matching is enabled",
      },
    },
    {
      name: "audits non-default accounts for dangerous name matching",
      accountId: "beta",
      orderedAccountIds: ["alpha", "beta"],
      hasExplicitAccountPath: true,
      expectedMatch: {
        checkId: "channels.synology-chat.reply.dangerous_name_matching_enabled",
        severity: "info",
        title: expect.stringContaining("(account: beta)"),
      },
    },
  ])("$name", (testCase) => {
    const findings = collectSynologyChatSecurityAuditFindings({
      account: createAccount({
        accountId: testCase.accountId,
        dangerouslyAllowNameMatching: true,
      }),
      accountId: testCase.accountId,
      orderedAccountIds: testCase.orderedAccountIds,
      hasExplicitAccountPath: testCase.hasExplicitAccountPath,
    });

    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining(testCase.expectedMatch)]),
    );
  });
});
