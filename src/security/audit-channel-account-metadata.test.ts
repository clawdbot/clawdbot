import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

function stubChannelPlugin(): ChannelPlugin {
  return {
    id: "discord",
    meta: {
      id: "discord",
      label: "Discord",
      selectionLabel: "Discord",
      docsPath: "/docs/testing",
      blurb: "test stub",
    },
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    config: {
      listAccountIds: () => [],
      defaultAccountId: () => "toString",
      inspectAccount: () => ({
        accountId: "toString",
        enabled: true,
        configured: true,
        config: { dangerouslyAllowNameMatching: true },
      }),
      resolveAccount: () => ({
        accountId: "toString",
        enabled: true,
        config: { dangerouslyAllowNameMatching: true },
      }),
      isEnabled: () => true,
      isConfigured: () => true,
    },
    security: {},
  };
}

function requireDangerousMatchingFinding(
  findings: Awaited<ReturnType<typeof collectChannelSecurityFindings>>,
) {
  const finding = findings.find(
    (entry) => entry.checkId === "channels.discord.allowFrom.dangerous_name_matching_enabled",
  );
  expect(finding).toMatchObject({
    checkId: "channels.discord.allowFrom.dangerous_name_matching_enabled",
  });
  if (!finding) {
    throw new Error("Expected dangerous name matching finding");
  }
  return finding;
}

describe("security audit channel account metadata", () => {
  it("does not treat prototype properties as explicit account config paths", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        discord: {
          enabled: true,
          token: "t",
          dangerouslyAllowNameMatching: true,
          accounts: {},
        },
      },
    };

    const findings = await collectChannelSecurityFindings({
      cfg,
      plugins: [stubChannelPlugin()],
    });

    const dangerousMatchingFinding = requireDangerousMatchingFinding(findings);
    expect(dangerousMatchingFinding.title).not.toContain("(account: toString)");
  });
});
