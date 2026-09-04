import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { PersistedClawInstall } from "./provenance.js";
import type { ClawAddPlan, ClawManifest, ClawSourceIdentity } from "./types.js";
import type { ClawUpdatePlan } from "./update-plan.js";

// Shared by the applyClawUpdatePlan suites; a fresh set per call so no suite sees another's mutations.
export function clawUpdateFixtures() {
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
    agentOrigin: "created",
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
  function agentDigest(config: ClawAddPlan["agent"]["config"]): string {
    return `sha256:${createHash("sha256").update(stableStringify(config)).digest("hex")}`;
  }
  const targetAgentDigest = agentDigest(addPlan.agent.config);
  const adoptedTargetAgentDigest = agentDigest({ ...addPlan.agent.config, default: true });

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
      readiness: { ready: true, requirements: [] },
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
  return {
    source,
    manifest,
    install,
    addPlan,
    agentDigest,
    targetAgentDigest,
    adoptedTargetAgentDigest,
    plan,
    consent,
  };
}
