import { describe, expect, it } from "vitest";
import type { SkillStatusEntry } from "../skills/discovery/status.js";
import { createCoreHealthChecks, type CoreHealthCheckDeps } from "./doctor-core-checks.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function createDeps(
  collectWorkspaceSuggestionNotes: CoreHealthCheckDeps["collectWorkspaceSuggestionNotes"],
): CoreHealthCheckDeps {
  return {
    async detectUnavailableSkills(): Promise<readonly SkillStatusEntry[]> {
      return [];
    },
    async collectSecurityWarnings() {
      return [];
    },
    collectWorkspaceSuggestionNotes,
    async collectRuntimeToolSchemaFindings() {
      return [];
    },
    async collectProviderCatalogProjectionFindings() {
      return [];
    },
    async collectLocalAudioAccelerationFindings() {
      return [];
    },
    async collectGatewayHealthFindings() {
      return [];
    },
    async collectGatewayDaemonFindings() {
      return [];
    },
    async listGatewayCronJobs() {
      return [];
    },
  };
}

function createWorkspaceSuggestionsCheck(
  collectWorkspaceSuggestionNotes: CoreHealthCheckDeps["collectWorkspaceSuggestionNotes"],
): HealthCheck {
  const check = createCoreHealthChecks(createDeps(collectWorkspaceSuggestionNotes)).find(
    (candidate) => candidate.id === "core/doctor/workspace-suggestions",
  );
  if (!check || !("detect" in check)) {
    throw new Error("workspace suggestions check not found");
  }
  return check;
}

describe("core/doctor/workspace-suggestions", () => {
  it("labels secondary-agent findings with structured targets", async () => {
    const check = createWorkspaceSuggestionsCheck(async (workspaceDir) =>
      workspaceDir === "/tmp/secondary"
        ? ["- Back up this workspace.", "Memory system not found in workspace."]
        : [],
    );

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          entries: {
            main: { default: true, workspace: "/tmp/main" },
            secondary: { workspace: "/tmp/secondary" },
          },
        },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Agent "secondary": - Back up this workspace.',
        target: "secondary",
      }),
      expect.objectContaining({
        message: 'Agent "secondary": Memory system not found in workspace.',
        target: "secondary",
      }),
    ]);
  });

  it("keeps shared workspace suggestions agent-scoped", async () => {
    const check = createWorkspaceSuggestionsCheck(async () => [
      "Memory system not found in workspace.",
    ]);

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg: {
        agents: {
          entries: {
            main: { default: true, workspace: "/tmp/shared" },
            secondary: { workspace: "/tmp/shared" },
          },
        },
      },
    });

    expect(findings).toEqual([
      expect.objectContaining({
        message: 'Agent "main": Memory system not found in workspace.',
        target: "main",
      }),
      expect.objectContaining({
        message: 'Agent "secondary": Memory system not found in workspace.',
        target: "secondary",
      }),
    ]);
  });

  it("preserves the explicit empty-roster failure", async () => {
    const check = createWorkspaceSuggestionsCheck(async () => []);

    await expect(
      check.detect({
        mode: "lint",
        runtime,
        cfg: { agents: { entries: {} } },
      }),
    ).rejects.toThrow("No agents configured");
  });
});
