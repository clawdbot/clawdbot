import { describe, expect, it } from "vitest";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { collectElevatedFindings, runSecurityAudit } from "./audit.js";

describe("security audit config basics", () => {
  it("flags agent profile overrides when global tools.profile is minimal", () => {
    const findings = collectMinimalProfileOverrideFindings({
      tools: {
        profile: "minimal",
      },
      agents: {
        list: [
          {
            id: "owner",
            tools: { profile: "full" },
          },
        ],
      },
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "tools.profile_minimal_overridden" && finding.severity === "warn",
      ),
    ).toBe(true);
  });

  it("flags tools.elevated allowFrom wildcard as critical", () => {
    const findings = collectElevatedFindings({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["*"] },
        },
      },
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "tools.elevated.allowFrom.whatsapp.wildcard" &&
          finding.severity === "critical",
      ),
    ).toBe(true);
  });

  it("suppresses configured accepted findings from the active audit report", async () => {
    const report = await runSecurityAudit({
      config: {
        security: {
          audit: {
            suppressions: [
              {
                checkId: "gateway.trusted_proxies_missing",
                detailIncludes: "trustedProxies",
                reason: "loopback-only local development",
              },
            ],
          },
        },
      },
      sourceConfig: {},
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(
      report.findings.some((finding) => finding.checkId === "gateway.trusted_proxies_missing"),
    ).toBe(false);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "security.audit.suppressions.active",
          severity: "info",
        }),
      ]),
    );
    expect(report.suppressedFindings).toEqual([
      expect.objectContaining({
        checkId: "gateway.trusted_proxies_missing",
        suppression: { reason: "loopback-only local development" },
      }),
    ]);
    expect(report.summary.warn).toBe(report.findings.filter((f) => f.severity === "warn").length);
  });

  it("keeps unrelated dangerous flags active when one dangerous flag is suppressed", async () => {
    const report = await runSecurityAudit({
      config: {
        gateway: {
          controlUi: { allowInsecureAuth: true },
        },
        tools: {
          exec: {
            applyPatch: { workspaceOnly: false },
          },
        },
        security: {
          audit: {
            suppressions: [
              {
                checkId: "config.insecure_or_dangerous_flags",
                detailIncludes: "gateway.controlUi.allowInsecureAuth=true",
                reason: "accepted local-only browser auth testing",
              },
            ],
          },
        },
      },
      sourceConfig: {},
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
    });

    expect(report.suppressedFindings).toEqual([
      expect.objectContaining({
        checkId: "config.insecure_or_dangerous_flags",
        detail: expect.stringContaining("gateway.controlUi.allowInsecureAuth=true"),
      }),
    ]);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          checkId: "config.insecure_or_dangerous_flags",
          detail: expect.stringContaining("tools.exec.applyPatch.workspaceOnly=false"),
        }),
        expect.objectContaining({
          checkId: "security.audit.suppressions.active",
        }),
      ]),
    );
  });
});
