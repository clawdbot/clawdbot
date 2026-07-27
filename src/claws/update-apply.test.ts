import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ClawCronUpdateError } from "./cron-update.js";
import {
  persistClawInstallRecord,
  readClawInstallRecord,
  type PersistedClawInstall,
} from "./provenance.js";
import type { ClawAddPlan, ClawManifest, ClawSourceIdentity } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import type { ClawUpdatePlan } from "./update-plan.js";

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
const addPlan: ClawAddPlan = {
  schemaVersion: "openclaw.clawAddPlan.v1",
  stability: "experimental",
  dryRun: true,
  mutationAllowed: false,
  manifestSchemaVersion: 1,
  planIntegrity: "sha256:target-add-plan",
  claw: source,
  agent: {
    requestedId: "worker",
    finalId: "worker",
    workspace: "/tmp/workspace-worker",
    config: { id: "worker", name: "Worker v2", workspace: "/tmp/workspace-worker" },
  },
  summary: {
    totalActions: 1,
    agentActions: 1,
    workspaceActions: 0,
    packageActions: 0,
    mcpServerActions: 0,
    cronJobActions: 0,
    blockedActions: 0,
    capabilityEscalations: 0,
  },
  actions: [],
  capabilityChanges: [],
  blockers: [],
  diagnostics: [],
  readiness: { ready: true, requirements: [] },
};

function plan(actions: ClawUpdatePlan["actions"]): ClawUpdatePlan {
  return {
    schemaVersion: "openclaw.clawUpdatePlan.v1",
    stability: "experimental",
    dryRun: true,
    mutationAllowed: false,
    planIntegrity: "sha256:update-plan",
    found: true,
    agentId: "worker",
    currentClaw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:current" },
    targetClaw: { name: "@acme/worker", version: "2.0.0", integrity: "sha256:target" },
    summary: {
      totalActions: actions.length,
      added: 0,
      changed: actions.filter((action) => action.action === "change").length,
      removed: 0,
      released: 0,
      unchanged: actions.filter((action) => action.action === "unchanged").length,
      manual: 0,
      blocked: actions.filter((action) => action.blocked).length,
      capabilityChanges: 0,
      capabilityEscalations: 0,
    },
    actions,
    capabilityChanges: [],
    blockers: [],
    diagnostics: [],
  };
}

function consent(updatePlan: ClawUpdatePlan) {
  return {
    sourceMcpServers: {},
    consentPlanIntegrity: updatePlan.planIntegrity,
  };
}

describe("applyClawUpdatePlan", () => {
  it("rejects consent that does not match the preview before rebuilding", async () => {
    const updatePlan = plan([]);
    const rebuildPlan = vi.fn();

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          sourceMcpServers: {},
          consentPlanIntegrity: "sha256:different-plan",
          rebuildPlan,
        },
      ),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
    expect(rebuildPlan).not.toHaveBeenCalled();
  });

  it("rejects a capability disclosure that changed after consent", async () => {
    const updatePlan = plan([]);
    const changed = {
      ...updatePlan,
      capabilityChanges: [
        {
          kind: "mcpServer" as const,
          id: "search",
          path: "mcpServers.search",
          action: "add" as const,
          classification: "escalation" as const,
          requiresDistinctConsent: true,
          reason: "target adds an MCP execution surface",
          effect: { transport: "stdio", command: "npx", args: ["search-server"] },
          desired: { summary: "stdio:npx search-server", digest: "sha256:capability" },
        },
      ],
    };
    const readInstall = vi.fn(() => install);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => changed),
          readInstall,
        },
      ),
    ).rejects.toMatchObject({ code: "update_changed" });
    expect(readInstall).not.toHaveBeenCalled();
  });

  it("compare-writes the owned agent and advances root provenance", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
        desiredDigest: "sha256:target-agent",
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    const persisted = { ...install, claw: source, updatedAtMs: 2 };
    const persistInstall = vi.fn(() => persisted);

    const result = await applyClawUpdatePlan(
      updatePlan,
      { targetManifest: manifest, targetSource: source },
      {
        config,
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        buildAddPlan: vi.fn(async () => addPlan),
        readInstall: vi.fn(() => install),
        persistInstall,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      },
    );

    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker v2",
      workspace: "/tmp/workspace-worker",
    });
    expect(persistInstall).toHaveBeenCalledWith(addPlan, expect.any(Object));
    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawUpdateResult.v1",
      status: "complete",
      agentId: "worker",
      targetClaw: { version: "2.0.0" },
    });
  });

  it("activates cron only after package and agent updates succeed", async () => {
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "restore agent",
      },
    ]);
    const order: string[] = [];
    let config: OpenClawConfig = { agents: { entries: {} } };

    await applyClawUpdatePlan(
      updatePlan,
      { targetManifest: manifest, targetSource: source },
      {
        config,
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        buildAddPlan: vi.fn(async () => addPlan),
        readInstall: vi.fn(() => install),
        applyWorkspace: vi.fn(async () => {
          order.push("workspace");
          return { appliedPaths: [], rollback: vi.fn(async () => undefined) };
        }),
        applyMcp: vi.fn(async () => {
          order.push("mcp");
          return { appliedNames: [], rollback: vi.fn(async () => undefined) };
        }),
        applyPackage: vi.fn(async () => {
          order.push("package");
          return { appliedIds: [], rollback: vi.fn(async () => undefined) };
        }),
        commitConfig: async (transform) => {
          order.push("agent");
          config = transform(config);
        },
        applyCron: vi.fn(async () => {
          order.push("cron");
          return { appliedIds: [], rollback: vi.fn(async () => undefined) };
        }),
        persistInstall: vi.fn(() => {
          order.push("provenance");
          return { ...install, claw: source };
        }),
      },
    );

    expect(order).toEqual(["workspace", "mcp", "package", "agent", "cron", "provenance"]);
  });

  it("preserves cron prerequisites when the gateway mutation outcome is uncertain", async () => {
    const root = tempDirs.make("openclaw-claw-update-apply-");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const currentAddPlan: ClawAddPlan = {
      ...addPlan,
      claw: install.claw,
      planIntegrity: install.planIntegrity,
      agent: {
        ...addPlan.agent,
        config: { id: "worker", name: "Worker", workspace: addPlan.agent.workspace },
      },
    };
    const currentRecord = persistClawInstallRecord(currentAddPlan, { env, nowMs: 1 });
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "restore agent",
      },
      {
        kind: "cronJob",
        id: "heartbeat",
        action: "add",
        target: "cronJobs.heartbeat",
        blocked: false,
        reason: "target adds cron job",
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: {} } };
    const workspaceRollback = vi.fn(async () => undefined);
    const mcpRollback = vi.fn(async () => undefined);
    const packageRollback = vi.fn(async () => undefined);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          env,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          applyWorkspace: vi.fn(async () => ({
            appliedPaths: [],
            rollback: workspaceRollback,
          })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback })),
          applyPackage: vi.fn(async () => ({
            appliedIds: [],
            rollback: packageRollback,
          })),
          commitConfig: async (transform) => {
            config = transform(config);
          },
          applyCron: vi.fn(async () => {
            throw new ClawCronUpdateError("cron transport closed", true);
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "update_partial" });

    const partialRecord = readClawInstallRecord("worker", { env });
    expect(config.agents?.entries?.worker).toEqual({
      name: "Worker v2",
      workspace: "/tmp/workspace-worker",
    });
    expect(partialRecord).toMatchObject({
      claw: { version: "2.0.0", integrity: "sha256:target" },
      planIntegrity: addPlan.planIntegrity,
      status: "partial",
    });
    expect(partialRecord?.agentConfigDigest).not.toBe(currentRecord.agentConfigDigest);
    expect(packageRollback).not.toHaveBeenCalled();
    expect(mcpRollback).not.toHaveBeenCalled();
    expect(workspaceRollback).not.toHaveBeenCalled();
  });

  it("stops before agent mutation when a package update fails", async () => {
    const targetPackage = {
      kind: "skill" as const,
      source: "clawhub" as const,
      ref: "search",
      version: "1.0.0",
    };
    const packageDetails = {
      ...targetPackage,
      integrity: "sha256:search",
      ownerAction: "install" as const,
    };
    const desiredDigest = `sha256:${createHash("sha256")
      .update(
        stableStringify({
          package: targetPackage,
          integrity: packageDetails.integrity,
          installId: undefined,
          riskWarning: undefined,
        }),
      )
      .digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "package",
        id: "skill:search",
        action: "add",
        target: "packages.skill:search",
        blocked: false,
        reason: "target adds package",
        desiredDigest,
      },
    ]);
    const packageManifest = { ...manifest, packages: [targetPackage] };
    const packageAddPlan = {
      ...addPlan,
      actions: [
        {
          kind: "package" as const,
          id: "skill:search",
          action: "install" as const,
          target: "clawhub:search@1.0.0",
          details: packageDetails,
          blocked: false,
        },
      ],
    };
    const commitConfig = vi.fn();

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: packageManifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => packageAddPlan),
          readInstall: vi.fn(() => install),
          persistInstall: vi.fn(),
          applyPackage: vi.fn(async () => {
            throw new Error("installer unavailable");
          }),
          commitConfig,
        },
      ),
    ).rejects.toMatchObject({ code: "package_update_failed" });
    expect(commitConfig).not.toHaveBeenCalled();
  });

  it("preserves resolved plugin metadata when applying an owned version upgrade", async () => {
    const packageRoot = tempDirs.make("openclaw-claw-plugin-update-");
    const targetSource = {
      ...source,
      packageRoot,
      manifestPath: join(packageRoot, "openclaw.claw.json"),
    };
    const targetPackage = {
      kind: "plugin" as const,
      source: "clawhub" as const,
      ref: "github",
      version: "2.0.0",
    };
    const resolved = {
      integrity: `sha256:${"a".repeat(64)}`,
      installId: "github",
      warning: "Review @acme/github before installation.",
    };
    const desiredDigest = `sha256:${createHash("sha256")
      .update(
        stableStringify({
          package: targetPackage,
          integrity: resolved.integrity,
          installId: resolved.installId,
          riskWarning: resolved.warning,
        }),
      )
      .digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "package",
        id: "plugin:github",
        action: "change",
        target: "packages.plugin:github",
        blocked: false,
        reason: "target changes package version",
        desiredDigest,
      },
    ]);
    const packagePreflight = vi.fn(async () => ({
      ok: false as const,
      code: "plugin_version_conflict",
      message: "The Claw owns the installed previous version.",
      installedVersion: "1.0.0",
      ...resolved,
    }));
    const applyPackage = vi.fn(async () => ({
      appliedIds: ["plugin:github"],
      rollback: vi.fn(async () => undefined),
    }));

    await applyClawUpdatePlan(
      updatePlan,
      { targetManifest: { ...manifest, packages: [targetPackage] }, targetSource },
      {
        config: {},
        ...consent(updatePlan),
        rebuildPlan: vi.fn(async () => updatePlan),
        packagePreflight,
        readInstall: vi.fn(() => install),
        persistInstall: vi.fn(() => ({ ...install, claw: source })),
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
      },
    );

    expect(packagePreflight).toHaveBeenCalledOnce();
    expect(applyPackage).toHaveBeenCalledOnce();
  });

  it("rolls workspace and MCP changes back when root provenance cannot advance", async () => {
    const updatePlan = plan([
      {
        kind: "workspaceFile",
        id: "SOUL.md",
        action: "change",
        target: "/tmp/workspace-worker/SOUL.md",
        blocked: false,
        reason: "target changed",
      },
    ]);
    const workspaceRollback = vi.fn(async () => undefined);
    const mcpRollback = vi.fn(async () => undefined);

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          applyWorkspace: vi.fn(async () => ({
            appliedPaths: ["SOUL.md"],
            rollback: workspaceRollback,
          })),
          applyMcp: vi.fn(async () => ({ appliedNames: [], rollback: mcpRollback })),
          persistInstall: vi.fn(() => {
            throw new Error("provenance race");
          }),
        },
      ),
    ).rejects.toMatchObject({ code: "provenance_update_failed" });
    expect(mcpRollback).toHaveBeenCalledOnce();
    expect(workspaceRollback).toHaveBeenCalledOnce();
  });

  it("restores the agent when the config commit throws after transforming state", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: { worker: { name: "Worker" } } } };
    let commits = 0;

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          commitConfig: async (transform) => {
            config = transform(config);
            commits += 1;
            if (commits === 1) {
              throw new Error("post-write failure");
            }
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent_update_failed" });
    expect(config.agents?.entries?.worker).toEqual({ name: "Worker" });
    expect(commits).toBe(2);
  });

  it("does not recreate an agent removed after planning", async () => {
    const currentAgent = { id: "worker", name: "Worker" };
    const currentDigest = `sha256:${createHash("sha256").update(stableStringify(currentAgent)).digest("hex")}`;
    const updatePlan = plan([
      {
        kind: "agent",
        id: "worker",
        action: "change",
        target: 'agents.entries["worker"]',
        blocked: false,
        reason: "target changed",
        currentDigest,
      },
    ]);
    let config: OpenClawConfig = { agents: { entries: {} } };

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config,
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => updatePlan),
          buildAddPlan: vi.fn(async () => addPlan),
          readInstall: vi.fn(() => install),
          commitConfig: async (transform) => {
            config = transform(config);
          },
        },
      ),
    ).rejects.toMatchObject({ code: "agent_changed" });
    expect(config.agents?.entries?.worker).toBeUndefined();
  });

  it("rejects a stale or manually blocked plan", async () => {
    const updatePlan = plan([]);
    const changed = { ...updatePlan, targetClaw: { ...updatePlan.targetClaw!, version: "3.0.0" } };
    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: manifest, targetSource: source },
        {
          config: {},
          ...consent(updatePlan),
          rebuildPlan: vi.fn(async () => changed),
          readInstall: vi.fn(() => install),
        },
      ),
    ).rejects.toMatchObject({ code: "update_changed" });

    await expect(
      applyClawUpdatePlan(
        {
          ...updatePlan,
          actions: [
            {
              kind: "agent",
              id: "worker",
              action: "manual",
              target: "agent",
              blocked: true,
              reason: "drift",
            },
          ],
        },
        { targetManifest: manifest, targetSource: source },
        { config: {}, ...consent(updatePlan), readInstall: vi.fn(() => install) },
      ),
    ).rejects.toMatchObject({ code: "update_blocked" });
  });
});
import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
