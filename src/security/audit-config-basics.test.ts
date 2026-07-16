// Covers baseline config security audit findings.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../infra/diagnostic-events.js";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { runSecurityAudit } from "./audit.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

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

  it("flags tools.elevated allowFrom wildcard as critical", async () => {
    const findings = await collectSecurityAuditFindings({
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

  it("flags per-agent skill allowlists combined with host exec and a global mcporter registry", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-"));
    try {
      await fs.mkdir(path.join(stateDir, "skills", "config"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "skills", "config", "mcporter.json"),
        JSON.stringify({
          mcpServers: {
            "hugegraph-asset": { baseUrl: "http://asset.example.test/mcp" },
            "whois-mcp": { baseUrl: "http://whois.example.test/mcp" },
          },
        }),
        "utf8",
      );

      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", security: "full", ask: "off" } },
              },
            ],
          },
        },
        sourceConfig: {},
        env: { OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "tools.exec.agent_skill_mcp_boundary_drift",
            severity: "warn",
            detail: expect.stringContaining("asset-agent"),
          }),
        ]),
      );
      const finding = report.findings.find(
        (entry) => entry.checkId === "tools.exec.agent_skill_mcp_boundary_drift",
      );
      expect(finding?.detail).toContain("whois-mcp");
      expect(finding?.detail).toContain("skills/config/mcporter.json");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not flag per-agent skill allowlists when matching agents deny exec", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-deny-"));
    try {
      const report = await runSecurityAudit({
        config: {
          mcp: {
            servers: {
              docs: { command: "node", args: ["docs-mcp.js"] },
            },
          },
          agents: {
            defaults: { skills: ["docs-search"] },
            list: [{ id: "docs-agent", tools: { exec: { security: "deny" } } }],
          },
          tools: { exec: { security: "deny" } },
        },
        sourceConfig: {},
        env: { OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(report.findings.map((finding) => finding.checkId)).not.toContain(
        "tools.exec.agent_skill_mcp_boundary_drift",
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
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

  it("emits a redacted security audit summary event", async () => {
    resetDiagnosticEventsForTest();
    const captured = captureSecurityEvents();

    let report: Awaited<ReturnType<typeof runSecurityAudit>>;
    try {
      report = await runSecurityAudit({
        config: {
          logging: {
            redactSensitive: "off",
          },
        },
        sourceConfig: {},
        env: {},
        includeFilesystem: false,
        includeChannelSecurity: false,
      });
    } finally {
      captured.stop();
    }

    expect(report!.summary.warn).toBeGreaterThan(0);
    const expectedSeverity = report!.summary.critical > 0 ? "critical" : "medium";
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      category: "audit",
      action: "security.audit.completed",
      outcome: "failure",
      severity: expectedSeverity,
      actor: { kind: "operator" },
      target: { kind: "config", name: "security.audit" },
      policy: { id: "security.audit", decision: "not_applicable" },
      control: { id: "security.audit", family: "authorization" },
      attributes: {
        critical_count: report!.summary.critical,
        warn_count: report!.summary.warn,
        info_count: report!.summary.info,
        suppressed_count: 0,
        deep: false,
        include_filesystem: false,
        include_channel_security: false,
      },
    });
    const serialized = JSON.stringify(captured.events);
    expect(serialized).not.toContain("redactSensitive");
    expect(serialized).not.toContain("logs and status output");
  });
});
