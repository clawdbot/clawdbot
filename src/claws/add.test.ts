import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { makeProvenancePlan, stateEnv } from "./provenance.test-helpers.js";
import type { ClawOpenClawProfile } from "./types.js";
import { applyClawUpdatePlan } from "./update-apply.js";
import { consent, manifest, source } from "./update-apply.test-helpers.js";
import { buildClawUpdatePlan } from "./update-plan.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("Claw add lifecycle", () => {
  it("applies, tracks drift, updates, and removes profile model and delegation settings", async () => {
    const root = tempDirs.make("openclaw-claw-update-profile-");
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const localSource = { ...source, packageRoot: root };
    const agentProfile: ClawOpenClawProfile["agent"] = {
      model: { primary: "acme/primary", fallbacks: ["acme/fallback"] },
      subagents: { allowAgents: ["researcher"], delegationMode: "prefer" },
    };
    const initial = await buildClawAddPlan({
      manifest,
      source: localSource,
      openClawProfile: { schemaVersion: 1, agent: agentProfile },
      context: { workspace: join(root, "workspace") },
    });
    let config: OpenClawConfig = {};
    const commitConfig = async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
      config = transform(config);
    };
    await applyClawAddPlan(initial, {
      env,
      commitConfig,
      consentPlanIntegrity: initial.planIntegrity,
    });
    expect(config.agents?.entries?.worker).toMatchObject(agentProfile);
    await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
      records: [{ agentState: "present" }],
    });
    for (const change of [
      { model: { primary: "acme/operator" } },
      { subagents: { allowAgents: [] } },
    ]) {
      const modified = structuredClone(config);
      Object.assign(modified.agents!.entries!.worker!, change);
      await expect(readClawStatus("worker", { env, config: modified })).resolves.toMatchObject({
        records: [{ agentState: "modified" }],
      });
    }
    const targetProfiles: ClawOpenClawProfile["agent"][] = [
      {
        model: { primary: "acme/replacement", fallbacks: [] },
        subagents: { allowAgents: [], delegationMode: "suggest" },
      },
      {},
    ];
    for (const agent of targetProfiles) {
      const target = {
        targetManifest: manifest,
        targetSource: localSource,
        targetOpenClawProfile: { schemaVersion: 1 as const, agent },
      };
      const update = await buildClawUpdatePlan({
        ...target,
        agentId: "worker",
        config,
        sourceMcpServers: {},
        stateOptions: { env },
      });
      expect(update.blockers).toEqual([]);
      expect(update.actions).toContainEqual(
        expect.objectContaining({ kind: "agent", action: "change" }),
      );
      expect(update.capabilityChanges.map((change) => change.path)).toEqual(
        expect.arrayContaining([
          "agent.model",
          "agent.subagents.allowAgents",
          "agent.subagents.delegationMode",
        ]),
      );
      await expect(
        applyClawUpdatePlan(update, target, {
          env,
          config,
          commitConfig,
          ...consent(update),
        }),
      ).resolves.toMatchObject({ status: "complete" });
      expect(config.agents?.entries?.worker?.model).toEqual(agent.model);
      expect(config.agents?.entries?.worker?.subagents).toEqual(agent.subagents);
      await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
        records: [{ agentState: "present" }],
      });
    }
  });

  it("records a failed config commit only after persistence resolves", async () => {
    const root = tempDirs.make("openclaw-claw-add-commit-failure-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      commitConfig: async (transform) => {
        transform({});
        throw new Error("config unavailable after transform");
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      installRecord: { status: "partial" },
      error: { code: "config_commit_failed", message: "config unavailable after transform" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
    expect(readClawInstallRecord("worker", { env })?.status).toBe("partial");
  });

  it("replaces committed legacy config before upgrading v1 plan identity", async () => {
    const root = tempDirs.make("openclaw-claw-add-v1-resume-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const legacyPlan = {
      ...plan,
      planIntegrity: "sha256:legacy-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "coding" as const },
        },
      },
    };
    const boundedPlan = {
      ...plan,
      planIntegrity: "sha256:bounded-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "full" as const, allow: ["read"] },
        },
      },
    };
    await mkdir(boundedPlan.agent.workspace, { recursive: true });
    persistClawInstallRecord(legacyPlan, { env, status: "workspace_ready", nowMs: 1 });
    openOpenClawStateDatabase({ env })
      .db /* sqlite-allow-raw: test-only downgrade simulates an interrupted v1 add. */
      .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }
    let config: OpenClawConfig = {
      agents: {
        entries: {
          worker: Object.fromEntries(
            Object.entries(legacyPlan.agent.config).filter(([key]) => key !== "id"),
          ),
        },
      },
    };

    const result = await applyClawAddPlan(boundedPlan, {
      env,
      consentPlanIntegrity: legacyPlan.planIntegrity,
      resumeRecord: legacyRecord,
      resumePlan: legacyPlan,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      seedPackageBootstrap: async () => undefined,
      createWorkspaceFiles: async () => [],
      installPackages: async () => [],
      installMcpServers: async () => [],
      installCronJobs: async () => [],
    });

    expect(result.status).toBe("complete");
    expect(config.agents?.entries?.worker).toMatchObject({
      tools: { profile: "full", allow: ["read"] },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      planIntegrity: boundedPlan.planIntegrity,
      status: "complete",
    });
  });

  it("retries after v1 promotion fails behind the bounded config commit", async () => {
    const root = tempDirs.make("openclaw-claw-add-v1-promotion-retry-");
    const env = stateEnv(root);
    const { plan } = await makeProvenancePlan(root, {
      schemaVersion: 1,
      agent: { id: "worker" },
    });
    const legacyPlan = {
      ...plan,
      planIntegrity: "sha256:legacy-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "coding" as const },
        },
      },
    };
    const boundedPlan = {
      ...plan,
      planIntegrity: "sha256:bounded-plan",
      agent: {
        ...plan.agent,
        config: {
          ...plan.agent.config,
          tools: { profile: "full" as const, allow: ["read"] },
        },
      },
    };
    await mkdir(boundedPlan.agent.workspace, { recursive: true });
    persistClawInstallRecord(legacyPlan, { env, status: "workspace_ready", nowMs: 1 });
    openOpenClawStateDatabase({ env })
      .db /* sqlite-allow-raw: test-only downgrade simulates an interrupted v1 add. */
      .prepare("UPDATE claw_installs SET schema_version = ? WHERE agent_id = ?")
      .run("openclaw.clawInstallRecord.v1", "worker");
    const legacyRecord = readClawInstallRecord("worker", { env });
    if (!legacyRecord) {
      throw new Error("expected legacy install record");
    }
    let config: OpenClawConfig = {
      agents: {
        entries: {
          worker: Object.fromEntries(
            Object.entries(legacyPlan.agent.config).filter(([key]) => key !== "id"),
          ),
        },
      },
    };
    const commitConfig = async (transform: (config: OpenClawConfig) => OpenClawConfig) => {
      config = transform(config);
    };
    const dependencies = {
      env,
      consentPlanIntegrity: legacyPlan.planIntegrity,
      resumeRecord: legacyRecord,
      resumePlan: legacyPlan,
      commitConfig,
      seedPackageBootstrap: async () => undefined,
      createWorkspaceFiles: async () => [],
      installPackages: async () => [],
      installMcpServers: async () => [],
      installCronJobs: async () => [],
    };
    const persistRecord = vi
      .fn<typeof persistClawInstallRecord>()
      .mockImplementationOnce((...args) => persistClawInstallRecord(...args))
      .mockImplementationOnce(() => {
        throw new Error("injected v1 promotion failure");
      });

    const first = await applyClawAddPlan(boundedPlan, { ...dependencies, persistRecord });

    expect(first).toMatchObject({
      status: "partial",
      configCommitted: true,
      error: { message: "injected v1 promotion failure" },
    });
    expect(config.agents?.entries?.worker).toMatchObject({
      tools: { profile: "full", allow: ["read"] },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      planIntegrity: legacyPlan.planIntegrity,
      status: "workspace_ready",
    });

    const second = await applyClawAddPlan(boundedPlan, dependencies);

    expect(second.status).toBe("complete");
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v2",
      planIntegrity: boundedPlan.planIntegrity,
      status: "complete",
    });
  });
});
