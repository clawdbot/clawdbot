import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

type ChannelSecurityFinding = Awaited<ReturnType<typeof collectChannelSecurityFindings>>[number];

function requireFinding(
  findings: ChannelSecurityFinding[],
  checkId: string,
): ChannelSecurityFinding {
  const finding = findings.find((entry) => entry.checkId === checkId);
  if (!finding) {
    throw new Error(`Expected finding ${checkId}`);
  }
  return finding;
}

describe("security audit channel dm policy", () => {
  it("warns when multiple DM senders share the main session", async () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      channels: { whatsapp: { enabled: true } },
    };
    const plugins: ChannelPlugin[] = [
      {
        id: "whatsapp",
        meta: {
          id: "whatsapp",
          label: "WhatsApp",
          selectionLabel: "WhatsApp",
          docsPath: "/channels/whatsapp",
          blurb: "Test",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          inspectAccount: () => ({ enabled: true, configured: true }),
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => ({
            policy: "allowlist",
            allowFrom: ["user-a", "user-b"],
            policyPath: "channels.whatsapp.dmPolicy",
            allowFromPath: "channels.whatsapp.",
            approveHint: "approve",
          }),
        },
      },
    ];

    const findings = await collectChannelSecurityFindings({
      cfg,
      plugins,
    });

    const sharedScopeFinding = requireFinding(
      findings,
      "channels.whatsapp.dm.scope_main_multiuser",
    );
    expect(sharedScopeFinding.severity).toBe("warn");
    expect(sharedScopeFinding.remediation).toContain(
      'config set session.dmScope "per-channel-peer"',
    );
  });

  it("flags public DMs and shared main-session scope together", async () => {
    const cfg: OpenClawConfig = {
      session: { dmScope: "main" },
      channels: { telegram: { enabled: true } },
    };
    const plugins: ChannelPlugin[] = [
      {
        id: "telegram",
        meta: {
          id: "telegram",
          label: "Telegram",
          selectionLabel: "Telegram",
          docsPath: "/channels/telegram",
          blurb: "Test",
        },
        capabilities: { chatTypes: ["direct"] },
        config: {
          listAccountIds: () => ["default"],
          inspectAccount: () => ({ enabled: true, configured: true }),
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: () => true,
        },
        security: {
          resolveDmPolicy: () => ({
            policy: "open",
            allowFrom: ["*"],
            policyPath: "channels.telegram.dmPolicy",
            allowFromPath: "channels.telegram.",
            approveHint: "approve",
          }),
        },
      },
    ];

    const findings = await collectChannelSecurityFindings({
      cfg,
      plugins,
    });

    const openDmFinding = requireFinding(findings, "channels.telegram.dm.open");
    expect(openDmFinding.severity).toBe("critical");

    const sharedScopeFinding = requireFinding(
      findings,
      "channels.telegram.dm.scope_main_multiuser",
    );
    expect(sharedScopeFinding.severity).toBe("warn");
  });
});
