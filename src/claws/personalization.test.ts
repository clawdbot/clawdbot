import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { applyClawConfigurePlan, buildClawConfigurePlan } from "./configure.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "./lifecycle-state.js";
import { readClawStatus } from "./lifecycle-status.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  createClawPersonalizationSeeds,
  createClawUpdatePersonalizationSeeds,
} from "./personalization.js";
import { buildClawSetupReconciliation } from "./setup-reconcile.js";
import { readClawSetupPending, readClawSetupState } from "./setup-state.js";
import { buildClawSetupPlan } from "./setup.js";
import type { ClawManifestV2, ClawSourceIdentity } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

function manifest(): ClawManifestV2 {
  return {
    schemaVersion: 2,
    agent: { id: "personalized" },
    workspace: { bootstrapFiles: {}, files: [] },
    packages: [],
    mcpServers: {},
    cronJobs: [],
    setup: {
      inputs: [{ id: "name", type: "string", label: "Name", maxLength: 256 }],
    },
    personalization: {
      seeds: [{ source: "setup/USER.md.tmpl", destination: "USER.md" }],
    },
  };
}

function source(root: string, version = "1.0.0"): ClawSourceIdentity {
  return {
    kind: "package",
    name: "@acme/personalized",
    version,
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: `sha256:${version}`,
    byteLength: 100,
  };
}

async function fixture() {
  const root = tempDirs.make("openclaw-claw-personalization-");
  await mkdir(join(root, "setup"));
  await writeFile(join(root, "setup", "USER.md.tmpl"), "# User\n\nName: {{ input.name }}\n");
  const claw = manifest();
  const setup = await buildClawSetupPlan({
    manifest: claw,
    packageRoot: root,
    answers: { name: "Avery" },
  });
  const plan = await buildClawAddPlan({
    manifest: claw,
    source: source(root),
    answers: { name: "Avery" },
    context: { workspace: join(root, "workspace") },
  });
  if (!setup.materialization || plan.blockers.length > 0) {
    throw new Error("Personalization fixture did not produce a consentable plan.");
  }
  return { root, claw, setup, plan, env: stateEnv(root) };
}

describe("Claw personalization state", () => {
  it("creates a user-owned seed and keeps answers out of the add result", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    const result = await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe("complete");
    expect(JSON.stringify(result)).not.toContain("Avery");
    expect(await readFile(join(current.root, "workspace", "USER.md"), "utf8")).toContain("Avery");
    expect(readClawSetupState("personalized", { env: current.env })).toMatchObject({
      status: "complete",
      answers: [{ id: "name", value: "Avery", source: "explicit" }],
      seeds: [{ destination: "USER.md", status: "complete" }],
    });
    const status = await readClawStatus("personalized", {
      env: current.env,
      config,
      sourceMcpServers: {},
    });
    expect(status.records[0]?.setup).not.toHaveProperty("answers");
    expect(status.records[0]?.setup).not.toHaveProperty("answerDigest");
    expect(JSON.stringify(status)).not.toContain("Avery");

    const removePlan = await buildClawRemovePlan("personalized", {
      env: current.env,
      config,
      sourceMcpServers: {},
    });
    expect(removePlan.actions).toContainEqual(
      expect.objectContaining({
        kind: "personalizationSeed",
        id: "USER.md",
        action: "retain",
        blocked: false,
      }),
    );
    const removed = await applyClawRemovePlan(removePlan, {
      env: current.env,
      config,
      consentPlanIntegrity: removePlan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(removed.status).toBe("complete");
    expect(readClawSetupState("personalized", { env: current.env })).toBeUndefined();
    expect(readClawSetupPending("personalized", { env: current.env })).toBeUndefined();
    expect(await readFile(join(current.root, "workspace", "USER.md"), "utf8")).toContain("Avery");
  });

  it("recovers exact seed bytes but rejects different occupied content", async () => {
    const current = await fixture();
    await mkdir(current.plan.agent.workspace);
    await createClawPersonalizationSeeds(current.plan, current.setup.materialization!, {
      env: current.env,
    });
    await expect(
      createClawPersonalizationSeeds(current.plan, current.setup.materialization!, {
        env: current.env,
      }),
    ).resolves.toMatchObject({ seeds: [{ status: "complete" }] });

    const conflicting = await fixture();
    await mkdir(conflicting.plan.agent.workspace);
    await writeFile(join(conflicting.plan.agent.workspace, "USER.md"), "local\n");
    await expect(
      createClawPersonalizationSeeds(conflicting.plan, conflicting.setup.materialization!, {
        env: conflicting.env,
      }),
    ).rejects.toMatchObject({
      code: "setup_seed_collision",
    });
  });

  it("resumes an add after a seed collision is repaired", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    const first = await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      createPersonalizationSeeds: async (plan, materialization, options) => {
        await writeFile(join(plan.agent.workspace, "USER.md"), "local collision\n");
        return createClawPersonalizationSeeds(plan, materialization, options);
      },
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(first.status).toBe("partial");
    expect(readClawSetupState("personalized", { env: current.env })?.status).toBe("partial");

    await unlink(join(current.plan.agent.workspace, "USER.md"));
    const resumed = await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(resumed.status, JSON.stringify(resumed.error)).toBe("complete");
    expect(readClawSetupState("personalized", { env: current.env })?.status).toBe("complete");
    expect(await readFile(join(current.plan.agent.workspace, "USER.md"), "utf8")).toContain(
      "Avery",
    );
  });
});

describe("Claw personalization update reconciliation", () => {
  it("applies a version 1 to version 2 personalization migration", async () => {
    const root = tempDirs.make("openclaw-claw-personalization-migration-");
    await mkdir(join(root, "setup"));
    await writeFile(join(root, "setup", "USER.md.tmpl"), "Name: {{ input.name }}\n");
    const env = stateEnv(root);
    const v1 = {
      schemaVersion: 1 as const,
      agent: { id: "personalized" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    };
    const v1Plan = await buildClawAddPlan({
      manifest: v1,
      source: source(root),
      context: { workspace: join(root, "workspace") },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(v1Plan, {
      env,
      consentPlanIntegrity: v1Plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const v2 = manifest();
    const v2Source = source(root, "2.0.0");
    const updatePlan = await buildClawUpdatePlan({
      agentId: "personalized",
      targetManifest: v2,
      targetSource: v2Source,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
      answers: { name: "Avery" },
    });
    expect(updatePlan.blockers).toEqual([]);
    expect(updatePlan.actions).toContainEqual(
      expect.objectContaining({ kind: "personalizationSeed", id: "USER.md", action: "add" }),
    );

    await expect(
      applyClawUpdatePlan(
        updatePlan,
        { targetManifest: v2, targetSource: v2Source, answers: { name: "Avery" } },
        {
          env,
          config,
          sourceMcpServers: {},
          consentPlanIntegrity: updatePlan.planIntegrity,
          commitConfig: async (transform) => {
            config = transform(config);
          },
          finalizeSetup: () => {
            throw new Error("simulated setup publication interruption");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "update_partial" });
    expect(readClawSetupState("personalized", { env })).toBeUndefined();
    expect(readClawSetupPending("personalized", { env })).toMatchObject({
      clawVersion: "2.0.0",
      status: "pending",
    });

    const retry = await buildClawUpdatePlan({
      agentId: "personalized",
      targetManifest: v2,
      targetSource: v2Source,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
    });
    expect(retry.blockers).toEqual([]);
    const result = await applyClawUpdatePlan(
      retry,
      { targetManifest: v2, targetSource: v2Source },
      {
        env,
        config,
        sourceMcpServers: {},
        consentPlanIntegrity: retry.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      },
    );
    expect(result.status).toBe("complete");
    expect(await readFile(join(root, "workspace", "USER.md"), "utf8")).toContain("Avery");
    expect(readClawSetupState("personalized", { env })).toMatchObject({
      clawVersion: "2.0.0",
      status: "complete",
    });
    expect(readClawSetupPending("personalized", { env })).toBeUndefined();
  });

  it("publishes a zero-seed setup update without accessing the workspace", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const setupState = readClawSetupState("personalized", { env: current.env });
    const targetSource = source(current.root, "2.0.0");
    const updatePlan = await buildClawUpdatePlan({
      agentId: "personalized",
      targetManifest: current.claw,
      targetSource,
      config,
      sourceMcpServers: {},
      stateOptions: { env: current.env },
    });
    const reconciliation = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 2,
      currentSetup: setupState,
      targetManifest: current.claw,
      targetSource,
      workspace: current.plan.agent.workspace,
      workspaceFiles: [],
    });
    if (!reconciliation.materialization || !reconciliation.targetState) {
      throw new Error("Zero-seed update fixture did not materialize setup state.");
    }
    expect(reconciliation.materialization.seeds).toEqual([]);

    const missingWorkspace = join(current.root, "missing-workspace");
    await expect(
      createClawUpdatePersonalizationSeeds(
        updatePlan,
        missingWorkspace,
        reconciliation.materialization,
        reconciliation.targetState,
        { env: current.env },
      ),
    ).resolves.toMatchObject({ clawVersion: "2.0.0", status: "pending" });
  });

  it("resumes a partial update from exact seed bytes and pending answers", async () => {
    const root = tempDirs.make("openclaw-claw-personalization-recovery-");
    await mkdir(join(root, "setup"));
    await writeFile(join(root, "setup", "USER.md.tmpl"), "Name: {{ input.name }}\n");
    await writeFile(join(root, "setup", "TEAM.md.tmpl"), "Team: {{ input.team }}\n");
    const env = stateEnv(root);
    const v1 = {
      schemaVersion: 1 as const,
      agent: { id: "personalized" },
      workspace: { bootstrapFiles: {}, files: [] },
      packages: [],
      mcpServers: {},
      cronJobs: [],
    };
    const v1Plan = await buildClawAddPlan({
      manifest: v1,
      source: source(root),
      context: { workspace: join(root, "workspace") },
    });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(v1Plan, {
      env,
      consentPlanIntegrity: v1Plan.planIntegrity,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const v2: ClawManifestV2 = {
      ...manifest(),
      setup: {
        inputs: [
          { id: "name", type: "string", label: "Name", required: true, maxLength: 256 },
          { id: "team", type: "string", label: "Team", required: true, maxLength: 256 },
        ],
      },
      personalization: {
        seeds: [
          { source: "setup/USER.md.tmpl", destination: "USER.md" },
          { source: "setup/TEAM.md.tmpl", destination: "TEAM.md" },
        ],
      },
    };
    const v2Source = source(root, "2.0.0");
    const answers = { name: "Avery", team: "Platform" };
    const updatePlan = await buildClawUpdatePlan({
      agentId: "personalized",
      targetManifest: v2,
      targetSource: v2Source,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
      answers,
    });
    const reconciliation = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 1,
      targetManifest: v2,
      targetSource: v2Source,
      workspace: v1Plan.agent.workspace,
      workspaceFiles: [],
      answers,
    });
    if (!reconciliation.materialization || !reconciliation.targetState) {
      throw new Error("Recovery fixture did not materialize setup state.");
    }

    await writeFile(join(v1Plan.agent.workspace, "TEAM.md"), "local collision\n");
    await expect(
      createClawUpdatePersonalizationSeeds(
        updatePlan,
        v1Plan.agent.workspace,
        reconciliation.materialization,
        reconciliation.targetState,
        { env },
      ),
    ).rejects.toMatchObject({
      code: "setup_seed_collision",
      completedDestinations: ["USER.md"],
    });
    expect(readClawSetupPending("personalized", { env })).toMatchObject({
      status: "partial",
      answers: expect.arrayContaining([
        expect.objectContaining({ id: "name", value: "Avery" }),
        expect.objectContaining({ id: "team", value: "Platform" }),
      ]),
    });

    await unlink(join(v1Plan.agent.workspace, "TEAM.md"));
    const retry = await buildClawUpdatePlan({
      agentId: "personalized",
      targetManifest: v2,
      targetSource: v2Source,
      config,
      sourceMcpServers: {},
      stateOptions: { env },
    });
    expect(retry.blockers).toEqual([]);
    const result = await applyClawUpdatePlan(
      retry,
      { targetManifest: v2, targetSource: v2Source },
      {
        env,
        config,
        sourceMcpServers: {},
        consentPlanIntegrity: retry.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      },
    );
    expect(result.status).toBe("complete");
    expect(readClawSetupPending("personalized", { env })).toBeUndefined();
    expect(await readFile(join(v1Plan.agent.workspace, "USER.md"), "utf8")).toContain("Avery");
    expect(await readFile(join(v1Plan.agent.workspace, "TEAM.md"), "utf8")).toContain("Platform");
  });

  it("preserves existing seeds, requires answers only for new effects, and rejects downgrade", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const setupState = readClawSetupState("personalized", { env: current.env });
    const target: ClawManifestV2 = {
      ...manifest(),
      setup: {
        inputs: [
          {
            id: "name",
            type: "string",
            label: "Display name",
            required: true,
            maxLength: 256,
          },
          { id: "team", type: "string", label: "Team", required: true, maxLength: 256 },
        ],
      },
      personalization: {
        seeds: [
          { source: "setup/USER.md.tmpl", destination: "USER.md" },
          { source: "setup/TEAM.md.tmpl", destination: "TEAM.md" },
        ],
      },
    };
    await writeFile(join(current.root, "setup", "USER.md.tmpl"), "Changed {{ input.name }}\n");
    await writeFile(join(current.root, "setup", "TEAM.md.tmpl"), "Team: {{ input.team }}\n");

    const missing = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 2,
      currentSetup: setupState,
      targetManifest: target,
      targetSource: source(current.root, "2.0.0"),
      workspace: current.plan.agent.workspace,
      workspaceFiles: [],
    });
    expect(missing.blockers).toContainEqual(
      expect.objectContaining({ code: "setup_answer_required", path: "$.answers.team" }),
    );
    expect(missing.actions).toContainEqual(
      expect.objectContaining({ id: "USER.md", action: "unchanged", blocked: false }),
    );

    const answered = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 2,
      currentSetup: setupState,
      targetManifest: target,
      targetSource: source(current.root, "2.0.0"),
      workspace: current.plan.agent.workspace,
      workspaceFiles: [],
      answers: { team: "Platform" },
    });
    expect(answered.blockers).toEqual([]);
    expect(answered.actions).toContainEqual(
      expect.objectContaining({ id: "TEAM.md", action: "add", blocked: false }),
    );
    expect(answered.targetState?.answers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "name", value: "Avery" }),
        expect.objectContaining({ id: "team", value: "Platform" }),
      ]),
    );

    await writeFile(join(current.root, "workspace", "TEAM.md"), "local team\n");
    const occupied = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 2,
      currentSetup: setupState,
      targetManifest: target,
      targetSource: source(current.root, "2.0.0"),
      workspace: current.plan.agent.workspace,
      workspaceFiles: [],
      answers: { team: "Platform" },
    });
    expect(occupied.blockers).toContainEqual(
      expect.objectContaining({ code: "setup_seed_ownership_conflict" }),
    );

    const downgrade = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 2,
      currentSetup: setupState,
      targetManifest: {
        schemaVersion: 1,
        agent: target.agent,
        workspace: target.workspace,
        packages: [],
        mcpServers: {},
        cronJobs: [],
      },
      targetSource: source(current.root, "1.0.0"),
      workspace: current.plan.agent.workspace,
      workspaceFiles: [],
    });
    expect(downgrade.blockers).toContainEqual(
      expect.objectContaining({ code: "setup_schema_downgrade_unsupported" }),
    );
  });

  it("binds explicit regeneration to the current user-owned bytes", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    const setupState = readClawSetupState("personalized", { env: current.env });
    const regeneration = await buildClawSetupReconciliation({
      currentManifestSchemaVersion: 2,
      currentSetup: setupState,
      targetManifest: current.claw,
      targetSource: source(current.root),
      workspace: current.plan.agent.workspace,
      workspaceFiles: [],
      answers: { name: "Jordan" },
      regenerateSeeds: ["USER.md"],
    });
    expect(regeneration.blockers).toEqual([]);
    expect(regeneration.actions).toContainEqual(
      expect.objectContaining({
        id: "USER.md",
        action: "change",
        currentDigest: expect.stringMatching(/^sha256:/),
        desiredDigest: expect.stringMatching(/^sha256:/),
      }),
    );

    const configureParams = {
      target: "personalized",
      manifest: current.claw,
      source: source(current.root),
      config,
      sourceMcpServers: {},
      answers: { name: "Jordan" },
      regenerateSeeds: ["USER.md"],
      stateOptions: { env: current.env },
    };
    const configurePlan = await buildClawConfigurePlan(configureParams);
    expect(configurePlan.blockers).toEqual([]);
    const configured = await applyClawConfigurePlan(configurePlan, configureParams, {
      env: current.env,
      consentPlanIntegrity: configurePlan.planIntegrity,
    });
    expect(configured.appliedActions).toEqual([
      expect.objectContaining({ id: "USER.md", action: "change" }),
    ]);
    expect(await readFile(join(current.root, "workspace", "USER.md"), "utf8")).toContain("Jordan");
    expect(readClawSetupState("personalized", { env: current.env })?.answers).toContainEqual(
      expect.objectContaining({ id: "name", value: "Jordan" }),
    );
  });

  it("clears an optional stored answer while regenerating its seed", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    const configureParams = {
      target: "personalized",
      manifest: current.claw,
      source: source(current.root),
      config,
      sourceMcpServers: {},
      clearAnswers: ["name"],
      regenerateSeeds: ["USER.md"],
      stateOptions: { env: current.env },
    };
    const configurePlan = await buildClawConfigurePlan(configureParams);
    expect(configurePlan.blockers).toEqual([]);
    await applyClawConfigurePlan(configurePlan, configureParams, {
      env: current.env,
      consentPlanIntegrity: configurePlan.planIntegrity,
    });

    expect(await readFile(join(current.root, "workspace", "USER.md"), "utf8")).toBe(
      "# User\n\nName: \n",
    );
    expect(readClawSetupState("personalized", { env: current.env })?.answers).toEqual([]);
  });

  it("rejects clearing an answer without regenerating its user-owned seed", async () => {
    const current = await fixture();
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      env: current.env,
      consentPlanIntegrity: current.plan.planIntegrity,
      setupMaterialization: current.setup.materialization,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    const plan = await buildClawConfigurePlan({
      target: "personalized",
      manifest: current.claw,
      source: source(current.root),
      config,
      sourceMcpServers: {},
      clearAnswers: ["name"],
      stateOptions: { env: current.env },
    });

    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: "setup_answer_without_effect",
        path: "$.clearAnswers.name",
      }),
    );
  });
});
