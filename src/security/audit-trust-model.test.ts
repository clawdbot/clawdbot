// Verifies trust-model audit findings and severity mapping.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectExposureMatrixFindings,
  collectLikelyMultiUserSetupFindings,
} from "./audit-extra.sync.js";

function audit(cfg: OpenClawConfig) {
  return [...collectExposureMatrixFindings(cfg), ...collectLikelyMultiUserSetupFindings(cfg)];
}

function requireMultiUserHeuristicFinding(findings: ReturnType<typeof audit>) {
  const finding = findings.find(
    (entry) => entry.checkId === "security.trust_model.multi_user_heuristic",
  );
  if (!finding) {
    throw new Error("Expected multi-user heuristic finding");
  }
  return finding;
}

function requireGroupScopeMainFinding(findings: ReturnType<typeof audit>) {
  const finding = findings.find(
    (entry) => entry.checkId === "security.trust_model.group_scope_main",
  );
  if (!finding) {
    throw new Error("Expected group-scope main finding");
  }
  return finding;
}

describe("security audit trust model findings", () => {
  it.each([
    { name: "inherited", groupPolicy: undefined, expected: true },
    { name: "explicitly disabled", groupPolicy: "disabled", expected: false },
  ] as const)("audits account group targets with $name policy", ({ groupPolicy, expected }) => {
    const findings = collectLikelyMultiUserSetupFindings({
      channels: {
        discord: {
          groupPolicy: "allowlist",
          accounts: {
            work: { ...(groupPolicy ? { groupPolicy } : {}), guilds: { "1234567890": {} } },
          },
        },
      },
    });
    const finding = findings.find(
      (entry) => entry.checkId === "security.trust_model.multi_user_heuristic",
    );
    expect(Boolean(finding)).toBe(expected);
    if (expected) {
      expect(finding?.detail).toContain(
        'channels.discord.accounts.work.groupPolicy="allowlist" with configured group targets',
      );
    }
  });

  it("evaluates trust-model exposure findings", () => {
    const cases = [
      {
        name: "flags open groupPolicy when tools.elevated is enabled",
        cfg: {
          tools: { elevated: { enabled: true, allowFrom: { whatsapp: ["+1"] } } },
          channels: { whatsapp: { groupPolicy: "open" } },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_elevated" &&
                finding.severity === "critical",
            ),
          ).toBe(true);
        },
      },
      {
        name: "flags open groupPolicy when runtime/filesystem tools are exposed without guards",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_runtime_or_fs" &&
                finding.severity === "critical",
            ),
          ).toBe(true);
        },
      },
      {
        name: "does not flag runtime/filesystem exposure for open groups when sandbox mode is all",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
          },
          agents: {
            defaults: {
              sandbox: { mode: "all" },
            },
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not flag runtime/filesystem exposure for open groups when runtime is denied and fs is workspace-only",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
            deny: ["group:runtime"],
            fs: { workspaceOnly: true },
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) => finding.checkId === "security.exposure.open_groups_with_runtime_or_fs",
            ),
          ).toBe(false);
        },
      },
      {
        name: "warns when config heuristics suggest a likely multi-user setup",
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
              guilds: {
                "1234567890": {
                  channels: {
                    "7777777777": { enabled: true },
                  },
                },
              },
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = requireMultiUserHeuristicFinding(findings);
          expect(finding.severity).toBe("warn");
          expect(finding.detail).toContain(
            'channels.discord.groupPolicy="allowlist" with configured group targets',
          );
          expect(finding.detail).toContain("personal-assistant");
          expect(finding.detail).toContain("https://docs.openclaw.ai/gateway/multi-tenant-hosting");
          expect(finding.remediation).toContain('agents.defaults.sandbox.mode="all"');
        },
      },
      {
        name: "does not warn for multi-user heuristic when no shared-user signals are configured",
        cfg: {
          channels: {
            discord: {
              groupPolicy: "allowlist",
            },
          },
          tools: { elevated: { enabled: false } },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) => finding.checkId === "security.trust_model.multi_user_heuristic",
            ),
          ).toBe(false);
          expect(
            findings.some((finding) => finding.checkId === "security.trust_model.group_scope_main"),
          ).toBe(false);
        },
      },
      {
        name: "warns when global group scope shares all rooms with the main session",
        cfg: {
          session: { groupScope: "main" },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = requireGroupScopeMainFinding(findings);
          expect(finding).toMatchObject({
            severity: "warn",
            title: "Group rooms share the main session",
          });
          expect(finding.detail).toContain('session.groupScope="main"');
          expect(finding.detail).toContain("all group/channel rooms");
          expect(finding.remediation).toContain(
            "https://docs.openclaw.ai/channels/groups#session-keys",
          );
        },
      },
      {
        name: "warns with the matched room for binding group scope",
        cfg: {
          session: { groupScope: "per-group" },
          bindings: [
            {
              agentId: "support",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "channel", id: "1234567890" },
                guildId: "9876543210",
                roles: ["operators", "reviewers"],
              },
              session: { groupScope: "main" },
            },
          ],
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = requireGroupScopeMainFinding(findings);
          expect(finding.severity).toBe("warn");
          expect(finding.detail).toContain(
            "discord accountId=work peer=channel:1234567890 guild=9876543210 roles=operators,reviewers",
          );
          expect(finding.detail).not.toContain("all group/channel rooms");
        },
      },
      {
        name: "does not warn for a direct-only binding group scope",
        cfg: {
          bindings: [
            {
              agentId: "support",
              match: {
                channel: "whatsapp",
                peer: { kind: "direct", id: "user-a" },
              },
              session: { groupScope: "main" },
            },
          ],
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some((finding) => finding.checkId === "security.trust_model.group_scope_main"),
          ).toBe(false);
        },
      },
      {
        name: "does not warn for a main-scoped room binding shadowed by an earlier equivalent binding",
        cfg: {
          bindings: [
            {
              agentId: "isolated",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "group", id: "room-1" },
              },
              session: { groupScope: "per-group" },
            },
            {
              agentId: "shared",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "channel", id: "room-1" },
              },
              session: { groupScope: "main" },
            },
          ],
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some((finding) => finding.checkId === "security.trust_model.group_scope_main"),
          ).toBe(false);
        },
      },
      {
        name: "warns when a main-scoped room binding precedes an equivalent binding",
        cfg: {
          bindings: [
            {
              agentId: "shared",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "channel", id: "room-1" },
              },
              session: { groupScope: "main" },
            },
            {
              agentId: "isolated",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "group", id: "room-1" },
              },
              session: { groupScope: "per-group" },
            },
          ],
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = requireGroupScopeMainFinding(findings);
          expect(finding.detail).toContain("discord accountId=work peer=channel:room-1");
        },
      },
      {
        name: "warns for a more-specific main-scoped room binding after a broader binding",
        cfg: {
          bindings: [
            {
              agentId: "isolated",
              match: { channel: "discord", accountId: "work" },
              session: { groupScope: "per-group" },
            },
            {
              agentId: "shared",
              match: {
                channel: "discord",
                accountId: "work",
                peer: { kind: "group", id: "room-1" },
              },
              session: { groupScope: "main" },
            },
          ],
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = requireGroupScopeMainFinding(findings);
          expect(finding.detail).toContain("discord accountId=work peer=group:room-1");
        },
      },
      {
        name: "flags open dmPolicy when tools.elevated is enabled",
        cfg: {
          tools: { elevated: { enabled: true, allowFrom: { feishu: ["ou_123"] } } },
          channels: { feishu: { groupPolicy: "disabled", dmPolicy: "open" } },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_elevated",
          );
          expect(finding?.severity).toBe("critical");
          expect(finding?.detail).toContain("channels.feishu.dmPolicy");
        },
      },
      {
        name: "flags open dmPolicy when runtime/filesystem tools are exposed without guards",
        cfg: {
          channels: { feishu: { groupPolicy: "disabled", dmPolicy: "open" } },
          tools: { elevated: { enabled: false }, profile: "coding" },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_runtime_or_fs",
          );
          expect(finding?.severity).toBe("critical");
          expect(finding?.detail).toContain("channels.feishu.dmPolicy");
        },
      },
      {
        name: "flags account-level open dmPolicy",
        cfg: {
          channels: {
            discord: {
              dmPolicy: "allowlist",
              accounts: { work: { dmPolicy: "open" } },
            },
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_elevated",
          );
          expect(finding?.detail).toContain("channels.discord.accounts.work.dmPolicy");
          expect(finding?.detail).not.toContain("channels.discord.dmPolicy");
        },
      },
      {
        name: "flags supported legacy open dm.policy",
        cfg: {
          channels: { discord: { dm: { policy: "open" } } },
        } as unknown as OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_elevated",
          );
          expect(finding?.detail).toContain("channels.discord.dm.policy");
        },
      },
      {
        name: "preserves the detected nested-only DM policy path in remediation",
        cfg: {
          channels: { matrix: { dm: { policy: "open" } } },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_elevated",
          );
          expect(finding?.detail).toContain("channels.matrix.dm.policy");
          expect(finding?.remediation).toContain("each listed group/DM policy");
          expect(finding?.remediation).not.toContain("dmPolicy");
        },
      },
      {
        name: "prefers canonical dmPolicy over conflicting legacy dm.policy",
        cfg: {
          channels: {
            discord: {
              dmPolicy: "allowlist",
              dm: { policy: "open" },
            },
          },
        } as unknown as OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some((finding) =>
              finding.checkId.startsWith("security.exposure.open_groups_"),
            ),
          ).toBe(false);
        },
      },
      {
        name: "flags open groupPolicy when coding profile exposes automations and plugins",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false }, profile: "coding" },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_control_plane_tools",
          );
          expect(finding?.severity).toBe("critical");
          expect(finding?.detail).toContain("channels.whatsapp.groupPolicy");
          expect(finding?.detail).toContain("controlPlane=[automations, plugins]");
          expect(finding?.remediation).toContain("automations, gateway, plugins");
          expect(finding?.detail).not.toContain("controlPlane=[automations, gateway]");
        },
      },
      {
        name: "flags open dmPolicy when gateway is explicitly allowed",
        cfg: {
          channels: { slack: { dmPolicy: "open" } },
          tools: { elevated: { enabled: false }, allow: ["gateway"] },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_control_plane_tools",
          );
          expect(finding?.severity).toBe("critical");
          expect(finding?.detail).toContain("channels.slack.dmPolicy");
          expect(finding?.detail).toContain("controlPlane=[gateway]");
        },
      },
      {
        name: "flags global alsoAllow that widens a restrictive profile",
        cfg: {
          channels: { slack: { dmPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "messaging",
            alsoAllow: ["cron"],
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_control_plane_tools",
          );
          expect(finding?.detail).toContain(
            "agents.defaults (profile=messaging; controlPlane=[automations])",
          );
        },
      },
      {
        name: "reports per-agent control-plane exposure",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false }, profile: "messaging" },
          agents: {
            entries: { ops: { tools: { profile: "messaging", alsoAllow: ["gateway"] } } },
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_control_plane_tools",
          );
          expect(finding?.detail).toContain(
            "agents.entries.ops (profile=messaging; controlPlane=[gateway])",
          );
          expect(finding?.detail).not.toContain("agents.defaults (profile=messaging");
        },
      },
      {
        name: "does not flag control-plane exposure when gateway, cron, and plugins are denied",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
            deny: ["gateway", "cron", "plugins"],
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_control_plane_tools",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not classify other owner-only tools as control-plane exposure",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false }, allow: ["nodes", "computer"] },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_control_plane_tools",
            ),
          ).toBe(false);
        },
      },
      {
        name: "does not flag control-plane exposure when inbound policy is not open",
        cfg: {
          channels: { whatsapp: { groupPolicy: "allowlist" } },
          tools: { elevated: { enabled: false }, profile: "coding" },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some(
              (finding) =>
                finding.checkId === "security.exposure.open_groups_with_control_plane_tools",
            ),
          ).toBe(false);
        },
      },
    ] as const;

    for (const testCase of cases) {
      testCase.assert(audit(testCase.cfg));
    }
  });
});
