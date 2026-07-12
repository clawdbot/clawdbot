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

describe("security audit trust model findings", () => {
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
        } satisfies OpenClawConfig,
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
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          expect(
            findings.some((finding) =>
              finding.checkId.startsWith("security.exposure.open_groups_"),
            ),
          ).toBe(false);
        },
      },
      {
        name: "flags open groupPolicy when coding profile exposes cron",
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
          expect(finding?.detail).toContain("controlPlane=[cron]");
          expect(finding?.detail).not.toContain("controlPlane=[gateway, cron]");
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
            "agents.defaults (profile=messaging; controlPlane=[cron])",
          );
        },
      },
      {
        name: "reports per-agent control-plane exposure",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: { elevated: { enabled: false }, profile: "messaging" },
          agents: {
            list: [{ id: "ops", tools: { profile: "messaging", alsoAllow: ["gateway"] } }],
          },
        } satisfies OpenClawConfig,
        assert: (findings: ReturnType<typeof audit>) => {
          const finding = findings.find(
            (entry) => entry.checkId === "security.exposure.open_groups_with_control_plane_tools",
          );
          expect(finding?.detail).toContain(
            "agents.list.ops (profile=messaging; controlPlane=[gateway])",
          );
          expect(finding?.detail).not.toContain("agents.defaults (profile=messaging");
        },
      },
      {
        name: "does not flag control-plane exposure when gateway and cron are denied",
        cfg: {
          channels: { whatsapp: { groupPolicy: "open" } },
          tools: {
            elevated: { enabled: false },
            profile: "coding",
            deny: ["gateway", "cron"],
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
