// Covers baseline config security audit findings.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  type DiagnosticSecurityEvent,
} from "../infra/diagnostic-events.js";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { runSecurityAudit } from "./audit.js";
import { collectSecurityAuditFindings } from "./audit.test-support.js";

const execFileAsync = promisify(execFile);

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
  it("preserves malformed roster defaults through the shared audit helper", async () => {
    const findings = await collectSecurityAuditFindings({
      agents: { entries: { main: {}, ops: {} } },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "config.agent_roster.invalid_default_count",
        detail: expect.stringContaining("found 0"),
      }),
    );
  });

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
      agents: { list: [{ id: "main", default: true }] },
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
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

  it("warns when an oversized global mcporter registry cannot be inspected", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-oversized-"));
    try {
      await fs.mkdir(path.join(stateDir, "skills", "config"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "skills", "config", "mcporter.json"),
        Buffer.alloc(16 * 1024 * 1024 + 1, 0x20),
      );

      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

      const checkIds = report.findings.map((finding) => finding.checkId);
      expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            checkId: "tools.exec.mcporter_registry_inspection_incomplete",
            severity: "warn",
          }),
        ]),
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not flag mcporter registry inspection when the registry is missing", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-missing-"));
    try {
      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

      const checkIds = report.findings.map((finding) => finding.checkId);
      expect(checkIds).not.toContain("tools.exec.mcporter_registry_inspection_incomplete");
      expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("warns when a malformed global mcporter registry cannot be inspected", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-malformed-"));
    try {
      await fs.mkdir(path.join(stateDir, "skills", "config"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "skills", "config", "mcporter.json"),
        "{ not json",
        "utf8",
      );

      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

      const checkIds = report.findings.map((finding) => finding.checkId);
      expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
      expect(checkIds).toContain("tools.exec.mcporter_registry_inspection_incomplete");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("does not inspect a malformed mcporter registry without relevant agent skill scopes", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-unused-"));
    try {
      await fs.mkdir(path.join(stateDir, "skills", "config"), { recursive: true });
      await fs.writeFile(
        path.join(stateDir, "skills", "config", "mcporter.json"),
        "{ not json",
        "utf8",
      );

      const report = await runSecurityAudit({
        config: { agents: { list: [{ id: "main", default: true }] } },
        sourceConfig: {},
        env: { OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      expect(report.findings.map((finding) => finding.checkId)).not.toContain(
        "tools.exec.mcporter_registry_inspection_incomplete",
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("warns when the global mcporter registry path is not a regular file", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-audit-mcporter-non-regular-"),
    );
    try {
      await fs.mkdir(path.join(stateDir, "skills", "config", "mcporter.json"), {
        recursive: true,
      });

      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

      const checkIds = report.findings.map((finding) => finding.checkId);
      expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
      expect(checkIds).toContain("tools.exec.mcporter_registry_inspection_incomplete");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "warns for a named-pipe mcporter registry without blocking",
    async () => {
      const stateDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-audit-mcporter-named-pipe-"),
      );
      try {
        const configDir = path.join(stateDir, "skills", "config");
        await fs.mkdir(configDir, { recursive: true });
        await execFileAsync("mkfifo", [path.join(configDir, "mcporter.json")]);

        const report = await runSecurityAudit({
          config: {
            agents: {
              list: [
                {
                  id: "asset-agent",
                  default: true,
                  skills: ["asset-lifecycle-tracking"],
                  tools: { exec: { host: "gateway", mode: "full" } },
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

        const checkIds = report.findings.map((finding) => finding.checkId);
        expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
        expect(checkIds).toContain("tools.exec.mcporter_registry_inspection_incomplete");
      } finally {
        await fs.rm(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("accepts a valid symlinked global mcporter registry", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcporter-symlink-"));
    try {
      const configDir = path.join(stateDir, "skills", "config");
      await fs.mkdir(configDir, { recursive: true });
      const targetPath = path.join(stateDir, "real-mcporter.json");
      await fs.writeFile(
        targetPath,
        JSON.stringify({
          mcpServers: {
            "whois-mcp": { baseUrl: "http://whois.example.test/mcp" },
          },
        }),
        "utf8",
      );
      await fs.symlink(targetPath, path.join(configDir, "mcporter.json"));

      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

      expect(report.findings.map((finding) => finding.checkId)).toContain(
        "tools.exec.agent_skill_mcp_boundary_drift",
      );
      expect(report.findings.map((finding) => finding.checkId)).not.toContain(
        "tools.exec.mcporter_registry_inspection_incomplete",
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("warns when an oversized symlinked global mcporter registry cannot be inspected", async () => {
    const stateDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-audit-mcporter-symlink-oversized-"),
    );
    try {
      const configDir = path.join(stateDir, "skills", "config");
      await fs.mkdir(configDir, { recursive: true });
      const targetPath = path.join(stateDir, "real-mcporter.json");
      await fs.writeFile(targetPath, Buffer.alloc(16 * 1024 * 1024 + 1, 0x20));
      await fs.symlink(targetPath, path.join(configDir, "mcporter.json"));

      const report = await runSecurityAudit({
        config: {
          agents: {
            list: [
              {
                id: "asset-agent",
                default: true,
                skills: ["asset-lifecycle-tracking"],
                tools: { exec: { host: "gateway", mode: "full" } },
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

      const checkIds = report.findings.map((finding) => finding.checkId);
      expect(checkIds).not.toContain("tools.exec.agent_skill_mcp_boundary_drift");
      expect(checkIds).toContain("tools.exec.mcporter_registry_inspection_incomplete");
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
            entries: { "docs-agent": { default: true, tools: { exec: { mode: "deny" } } } },
          },
          tools: { exec: { mode: "deny" } },
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

  it("audits inherited defaults independently of the default agent override", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-audit-mcp-defaults-"));
    try {
      const report = await runSecurityAudit({
        config: {
          mcp: {
            servers: {
              docs: { command: "node", args: ["docs-mcp.js"] },
            },
          },
          tools: { exec: { host: "gateway", security: "full", ask: "off" } },
          agents: {
            defaults: { skills: ["docs-search"] },
            list: [
              {
                id: "safe-default",
                default: true,
                skills: ["safe-only"],
                tools: { exec: { security: "deny" } },
              },
              { id: "inheritor" },
            ],
          },
        },
        sourceConfig: {},
        env: { OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        includeFilesystem: false,
        includeChannelSecurity: false,
      });

      const finding = report.findings.find(
        (entry) => entry.checkId === "tools.exec.agent_skill_mcp_boundary_drift",
      );
      expect(finding?.detail).toContain("- agents.defaults: agents.defaults.skills");
      expect(finding?.detail).toContain("- inheritor: agents.defaults.skills (inherited)");
      expect(finding?.detail).not.toContain("- safe-default:");
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  });

  it("suppresses configured accepted findings from the active audit report", async () => {
    const report = await runSecurityAudit({
      config: {
        agents: { list: [{ id: "main", default: true }] },
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
        agents: { entries: { main: { default: true } } },
        hooks: { gmail: { allowUnsafeExternalContent: true } },
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
                detailIncludes: "hooks.gmail.allowUnsafeExternalContent=true",
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
        detail: expect.stringContaining("hooks.gmail.allowUnsafeExternalContent=true"),
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
        config: { agents: { entries: { main: { default: true } } } },
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
