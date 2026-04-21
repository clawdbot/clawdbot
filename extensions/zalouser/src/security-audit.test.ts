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
    detailIncludes: string[];
    detailExcludes?: string[];
    expectFindingMatch?: { checkId: string; severity: "info" | "warn" };
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
      detailIncludes: ["out-of-scope"],
      expectFindingMatch: {
        checkId: "channels.zalouser.groups.mutable_entries",
        severity: "info",
      },
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

    expect(finding).toBeDefined();
    expect(finding?.severity).toBe(testCase.expectedSeverity);
    for (const snippet of testCase.detailIncludes) {
      expect(finding?.detail).toContain(snippet);
    }
    for (const snippet of testCase.detailExcludes ?? []) {
      expect(finding?.detail).not.toContain(snippet);
    }
    if (testCase.expectFindingMatch) {
      expect(findings).toEqual(
        expect.arrayContaining([expect.objectContaining(testCase.expectFindingMatch)]),
      );
    }
  });
});
