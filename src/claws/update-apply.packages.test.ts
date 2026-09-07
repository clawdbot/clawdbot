import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PersistedClawInstall } from "./provenance.js";
import type {
  ClawManifest,
  ClawOpenClawProfile,
  ClawPackage,
  ClawPackagePreflight,
  ClawSourceIdentity,
} from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import type { ClawUpdateAction, ClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const source: ClawSourceIdentity = {
  kind: "package",
  name: "@acme/worker",
  version: "2.0.0",
  packageRoot: "/tmp/target",
  manifestPath: "/tmp/target/openclaw.claw.json",
  integrityKind: "artifact",
  integrity: "sha256:target",
  byteLength: 1,
};
const manifest: ClawManifest = {
  schemaVersion: 1,
  agent: { id: "worker", name: "Worker v2" },
  workspace: { bootstrapFiles: {}, files: [] },
  packages: [],
  mcpServers: {},
  cronJobs: [],
};
const install: PersistedClawInstall = {
  schemaVersion: "openclaw.clawInstallRecord.v1",
  claw: { ...source, version: "1.0.0", integrity: "sha256:current" },
  manifestSchemaVersion: 1,
  planIntegrity: "sha256:current-add-plan",
  agentId: "worker",
  workspace: "/tmp/workspace-worker",
  agentConfigDigest: "sha256:current-agent",
  agentOwnedPaths: ['agents.entries["worker"]'],
  status: "complete",
  addedAtMs: 1,
  updatedAtMs: 1,
};
const weatherPackage: ClawPackage = {
  kind: "skill",
  source: "clawhub",
  ref: "@acme/weather",
  version: "1.0.0",
};

function plan(actions: ClawUpdateAction[]): ClawUpdatePlan {
  return {
    schemaVersion: "openclaw.clawUpdatePlan.v1",
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "worker",
    currentClaw: { name: source.name, version: "1.0.0", integrity: "sha256:current" },
    targetClaw: { name: source.name, version: source.version, integrity: source.integrity },
    summary: {
      totalActions: actions.length,
      added: actions.filter((action) => action.action === "add").length,
      changed: 0,
      removed: 0,
      released: 0,
      unchanged: actions.filter((action) => action.action === "unchanged").length,
      manual: 0,
      blocked: 0,
      capabilityChanges: 0,
      capabilityEscalations: 0,
    },
    actions,
    capabilityChanges: [],
    readiness: { ready: true, requirements: [] },
    blockers: [],
    diagnostics: [],
  };
}

function unchanged(id = "skill:@acme/weather"): ClawUpdateAction {
  return {
    kind: "package",
    id,
    action: "unchanged",
    target: "clawhub:@acme/weather@1.0.0",
    blocked: false,
    reason: "Recorded package reference already matches the exact target version.",
    currentDigest: "sha256:current-package",
    desiredDigest: "sha256:target-package",
  };
}

function targetSource(): ClawSourceIdentity {
  const packageRoot = tempDirs.make("openclaw-claw-update-package-");
  return {
    ...source,
    packageRoot,
    manifestPath: join(packageRoot, "openclaw.claw.json"),
  };
}

function options(updatePlan: ClawUpdatePlan, packagePreflight: ClawPackagePreflight) {
  return {
    config: {},
    sourceMcpServers: {},
    consentPlanIntegrity: updatePlan.planIntegrity,
    rebuildPlan: vi.fn(async () => updatePlan),
    readInstall: vi.fn(() => install),
    packagePreflight,
  };
}

describe("applyClawUpdatePlan package compatibility", () => {
  it("does not rematerialize an unchanged Claw-owned skill during apply", async () => {
    const updatePlan = plan([unchanged()]);
    const applyPackage = vi.fn(async () => ({
      appliedIds: [],
      rollback: vi.fn(async () => undefined),
    }));
    const result = await applyClawUpdatePlan(
      updatePlan,
      {
        targetManifest: { ...manifest, packages: [weatherPackage] },
        targetSource: targetSource(),
      },
      {
        ...options(
          updatePlan,
          vi.fn(async () => ({
            ok: false,
            code: "skill_version_conflict",
            message: "The already installed skill cannot be added again.",
          })),
        ),
        applyWorkspace: vi.fn(async () => ({
          appliedPaths: [],
          rollback: vi.fn(async () => undefined),
        })),
        applyMcp: vi.fn(async () => ({
          appliedNames: [],
          rollback: vi.fn(async () => undefined),
        })),
        applyCron: vi.fn(async () => ({
          appliedIds: [],
          rollback: vi.fn(async () => undefined),
        })),
        applyPackage,
        persistInstall: vi.fn(() => ({ ...install, claw: source })),
      },
    );

    expect(result.status).toBe("complete");
    expect(result.appliedActions).toEqual([]);
    expect(applyPackage).not.toHaveBeenCalled();
  });

  it("keeps package blockers for mutations when another package is unchanged", async () => {
    const alertsPackage: ClawPackage = {
      kind: "skill",
      source: "clawhub",
      ref: "@acme/alerts",
      version: "1.0.0",
    };
    const updatePlan = plan([
      unchanged(),
      {
        kind: "package",
        id: "skill:@acme/alerts",
        action: "add",
        target: "clawhub:@acme/alerts@1.0.0",
        blocked: false,
        reason: "The target adds a skill.",
        desiredDigest: "sha256:target-alerts",
      },
    ]);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        {
          targetManifest: { ...manifest, packages: [weatherPackage, alertsPackage] },
          targetSource: targetSource(),
        },
        options(
          updatePlan,
          vi.fn(async (pkg) => ({
            ok: false,
            code: "skill_version_conflict",
            message: `${pkg.ref} cannot be materialized.`,
          })),
        ),
      ),
    ).rejects.toMatchObject({ code: "update_target_blocked" });
  });

  it("rejects an unchanged package that disappears after planning", async () => {
    const updatePlan = plan([unchanged()]);
    await expect(
      applyClawUpdatePlan(
        updatePlan,
        {
          targetManifest: { ...manifest, packages: [weatherPackage] },
          targetSource: targetSource(),
        },
        options(
          updatePlan,
          vi.fn(async () => ({
            ok: true,
            action: "install" as const,
            integrity: "sha256:resolved-package",
            installId: "@acme/weather",
          })),
        ),
      ),
    ).rejects.toMatchObject({ code: "update_changed" });
  });

  it("keeps provenance blockers for unchanged profile extensions", async () => {
    const targetOpenClawProfile: ClawOpenClawProfile = {
      schemaVersion: 1,
      agent: {},
      extensions: [
        {
          id: "weather",
          kind: "plugin",
          format: "openclaw",
          source: "clawhub",
          ref: "@acme/weather",
          version: "1.0.0",
        },
      ],
    };
    const updatePlan = plan([unchanged("plugin:@acme/weather")]);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        {
          targetManifest: manifest,
          targetOpenClawProfile,
          targetSource: targetSource(),
        },
        options(
          updatePlan,
          vi.fn(async () => ({ ok: true, action: "reuse" as const })),
        ),
      ),
    ).rejects.toMatchObject({ code: "update_target_blocked" });
  });
});
