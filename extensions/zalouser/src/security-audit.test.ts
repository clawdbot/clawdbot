import { describe, expect, it } from "vitest";
import { collectZalouserSecurityAuditFindings } from "./security-audit.js";
import type { ResolvedZalouserAccount, ZalouserAccountConfig } from "./types.js";

function createAccount(config: ZalouserAccountConfig): ResolvedZalouserAccount {
  return {
    accountId: "default",
    enabled: true,
    profile: "default",
    authenticated: true,
    config,
  };
}

describe("Zalouser security audit findings", () => {
  const cases: Array<{
    name: string;
    config: ZalouserAccountConfig;
    expectedSeverity: "info" | "warn";
    expectedTitle: string;
    expectedRemediation: string;
    detailIncludes: string[];
    detailExcludes?: string[];
  }> = [
    {
      name: "warns when group routing contains mutable group entries",
      config: {
        enabled: true,
        groups: {
          "Ops Room": { enabled: true },
          "group:g-123": { enabled: true },
        },
      } satisfies ZalouserAccountConfig,
      expectedSeverity: "warn",
      expectedTitle: "Zalouser group routing contains mutable group entries",
      expectedRemediation:
        "Prefer stable Zalo group IDs in channels.zalouser.groups, or explicitly opt in with dangerouslyAllowNameMatching=true if you accept mutable group-name matching.",
      detailIncludes: ["channels.zalouser.groups:Ops Room"],
      detailExcludes: ["group:g-123"],
    },
    {
      name: "marks mutable group routing as break-glass when dangerous matching is enabled",
      config: {
        enabled: true,
        dangerouslyAllowNameMatching: true,
        groups: {
          "Ops Room": { enabled: true },
        },
      } satisfies ZalouserAccountConfig,
      expectedSeverity: "info",
      expectedTitle: "Zalouser group routing uses break-glass name matching",
      expectedRemediation:
        "Prefer stable Zalo group IDs (for example group:<id> or provider-native g- ids), then disable dangerouslyAllowNameMatching.",
      detailIncludes: ["out-of-scope"],
    },
  ];

  it.each(cases)("$name", (testCase) => {
    const findings = collectZalouserSecurityAuditFindings({
      account: createAccount(testCase.config),
      accountId: "default",
      orderedAccountIds: ["default"],
      hasExplicitAccountPath: false,
    });
    const finding = findings.find(
      (entry) => entry.checkId === "channels.zalouser.groups.mutable_entries",
    );

    if (!finding) {
      throw new Error("expected mutable Zalo User group finding");
    }
    expect(finding.checkId).toBe("channels.zalouser.groups.mutable_entries");
    expect(finding.severity).toBe(testCase.expectedSeverity);
    expect(finding.title).toBe(testCase.expectedTitle);
    expect(finding.remediation).toBe(testCase.expectedRemediation);
    for (const snippet of testCase.detailIncludes) {
      expect(finding.detail).toContain(snippet);
    }
    for (const snippet of testCase.detailExcludes ?? []) {
      expect(finding.detail).not.toContain(snippet);
    }
  });
});
