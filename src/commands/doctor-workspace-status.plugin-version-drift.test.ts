// Focused QA evidence for official Codex plugin drift through doctor diagnostics.
import { describe, expect, it, vi } from "vitest";
import * as noteModule from "../../packages/terminal-core/src/note.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { detectPluginVersionDrift } from "../plugins/plugin-version-drift.js";
import {
  collectWorkspaceStatusHealthFindings,
  noteWorkspaceStatus,
} from "./doctor-workspace-status.js";

vi.mock("../agents/agent-scope.js", () => ({
  listAgentIds: () => [],
  resolveAgentWorkspaceDir: () => {
    throw new Error("plugin drift evidence must not inspect agent workspaces");
  },
  tryResolveDefaultAgentId: () => undefined,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilityWarnings: () => {
    throw new Error("plugin drift evidence must not use compatibility warnings");
  },
  buildPluginRegistrySnapshotReport: () => {
    throw new Error("plugin drift evidence must not use registry diagnostics");
  },
}));

vi.mock("../tasks/task-flow-runtime-internal.js", () => ({
  listTaskFlowRecords: () => [],
}));

vi.mock("../tasks/runtime-internal.js", () => ({
  listTasksForFlowId: () => [],
}));

const config: OpenClawConfig = {
  plugins: {
    entries: {
      codex: { enabled: true },
    },
  },
};

function detectCodexDrift(installedVersion: string, gatewayVersion: string) {
  const report = detectPluginVersionDrift({
    gatewayVersion,
    installRecords: {
      codex: {
        source: "npm",
        spec: `@openclaw/codex@${installedVersion}`,
        resolvedName: "@openclaw/codex",
        resolvedVersion: installedVersion,
      },
    },
    config,
  });
  for (const entry of report.drifts) {
    entry.targetResolution = {
      status: "resolved",
      packageName: "@openclaw/codex",
      requestedTarget: gatewayVersion,
      version: gatewayVersion,
    };
  }
  return report;
}

describe("official Codex plugin version drift doctor evidence", () => {
  it("reports an unresolved post-restart target instead of silently omitting readiness", () => {
    const readiness = {
      status: "unresolved" as const,
      reason: "Gateway service package version is unavailable.",
      runningGatewayVersion: "2026.5.30",
    };

    expect(
      collectWorkspaceStatusHealthFindings(config, { pluginVersionReadiness: readiness }),
    ).toEqual([
      expect.objectContaining({
        requirement: "plugin-version-restart-readiness",
        message: expect.stringContaining("Gateway service package version is unavailable"),
      }),
    ]);

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      noteWorkspaceStatus(config, { pluginVersionReadiness: readiness });
      expect(noteSpy).toHaveBeenCalledWith(
        expect.stringContaining("Running Gateway: OpenClaw 2026.5.30"),
        "Plugin restart readiness",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("reports when compatible plugins still need the older running Gateway restarted", () => {
    const restartVersion = "2026.6.1";
    const runningGatewayVersion = "2026.5.30";
    const readiness = {
      status: "resolved" as const,
      runningGatewayVersion,
      report: detectCodexDrift(restartVersion, restartVersion),
    };

    expect(
      collectWorkspaceStatusHealthFindings(config, { pluginVersionReadiness: readiness }),
    ).toEqual([
      expect.objectContaining({
        requirement: "plugin-version-gateway-restart",
        message: expect.stringContaining(`running Gateway is ${runningGatewayVersion}`),
        fixHint: "openclaw gateway restart",
      }),
    ]);

    const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
    try {
      noteWorkspaceStatus(config, { pluginVersionReadiness: readiness });
      expect(noteSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Running Gateway: OpenClaw ${runningGatewayVersion}`),
        "Plugin restart readiness",
      );
    } finally {
      noteSpy.mockRestore();
    }
  });

  it("reports older and newer pins as advisory drift while accepting correction suffixes", () => {
    const gatewayVersion = "2026.6.1";

    for (const installedVersion of ["2026.5.30", "2026.6.2"]) {
      const report = detectCodexDrift(installedVersion, gatewayVersion);
      expect(report).toEqual({
        gatewayVersion,
        drifts: [
          {
            pluginId: "codex",
            installedVersion,
            gatewayVersion,
            source: "npm",
            packageName: "@openclaw/codex",
            spec: `@openclaw/codex@${installedVersion}`,
            targetResolution: {
              status: "resolved",
              packageName: "@openclaw/codex",
              requestedTarget: gatewayVersion,
              version: gatewayVersion,
            },
          },
        ],
      });

      expect(
        collectWorkspaceStatusHealthFindings(config, {
          pluginVersionReadiness: { status: "resolved", report },
        }),
      ).toEqual([
        {
          checkId: "core/doctor/workspace-status",
          severity: "warning",
          message: `Plugin codex is ${installedVersion}, but a Gateway restart will load OpenClaw ${gatewayVersion}.`,
          path: "plugins.entries.codex",
          target: "codex",
          requirement: "plugin-version-drift",
          fixHint: "openclaw plugins update @openclaw/codex@2026.6.1 && openclaw gateway restart",
        },
      ]);

      const noteSpy = vi.spyOn(noteModule, "note").mockImplementation(() => {});
      try {
        noteWorkspaceStatus(config, {
          pluginVersionReadiness: { status: "resolved", report },
        });
        const driftNotes = noteSpy.mock.calls.filter(
          ([, title]) => title === "Plugin restart readiness",
        );
        expect(driftNotes).toHaveLength(1);
        expect(driftNotes[0]?.[0]).toContain(
          `1 active official plugin not on post-restart OpenClaw ${gatewayVersion}`,
        );
        expect(driftNotes[0]?.[0]).toContain(
          `codex: ${installedVersion} (npm) -> expected ${gatewayVersion}`,
        );
        expect(driftNotes[0]?.[0]).toContain("openclaw plugins update @openclaw/codex@2026.6.1");
        expect(driftNotes[0]?.[0]).toContain("openclaw gateway restart");
      } finally {
        noteSpy.mockRestore();
      }
    }

    for (const [installedVersion, correctionGatewayVersion] of [
      ["2026.6.1", "2026.6.1-1"],
      ["2026.6.1-1", "2026.6.1"],
    ] as const) {
      const report = detectCodexDrift(installedVersion, correctionGatewayVersion);
      expect(report.drifts).toEqual([]);
      expect(
        collectWorkspaceStatusHealthFindings(config, {
          pluginVersionReadiness: {
            status: "resolved",
            report,
            runningGatewayVersion: installedVersion,
          },
        }),
      ).toEqual([]);
    }
  });
});
