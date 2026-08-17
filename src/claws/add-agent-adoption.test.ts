// Apply-time compare-and-swap coverage for adopting a configured agent.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord, readClawInstallRecord } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawAddPlan, ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function fixture(): Promise<{
  root: string;
  plan: ClawAddPlan;
  config: OpenClawConfig;
}> {
  const root = tempDirs.make("openclaw-claw-agent-adopt-apply-");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 1,
  };
  const existing = { id: "worker", name: "Worker", workspace, default: true };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace, adoptExistingAgent: true, existingAgents: [existing] },
  });
  return {
    root,
    plan,
    config: { agents: { entries: { worker: { name: "Worker", workspace, default: true } } } },
  };
}

describe("applyClawAddPlan agent adoption", () => {
  it("asserts exact config without rewriting the adopted entry", async () => {
    const { root, plan, config } = await fixture();
    const commitConfig = vi.fn(async (transform) => {
      expect(transform(config)).toBe(config);
    });

    const result = await applyClawAddPlan(plan, {
      env: { OPENCLAW_STATE_DIR: join(root, "state") },
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig,
    });

    expect(result).toMatchObject({ status: "complete", configCommitted: true });
    expect(commitConfig).toHaveBeenCalledOnce();
  });

  it("accepts a canonical plan for a non-canonical configured roster key", async () => {
    const { root, plan, config } = await fixture();
    const worker = config.agents?.entries?.worker;
    if (!worker) {
      throw new Error("fixture agent missing");
    }
    const nonCanonicalConfig: OpenClawConfig = {
      agents: { entries: { WORKER: worker } },
    };
    const commitConfig = vi.fn(async (transform) => {
      expect(transform(nonCanonicalConfig)).toBe(nonCanonicalConfig);
    });

    const result = await applyClawAddPlan(plan, {
      env: { OPENCLAW_STATE_DIR: join(root, "state") },
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => nonCanonicalConfig,
      commitConfig,
    });

    expect(result).toMatchObject({ status: "complete", configCommitted: true });
    expect(commitConfig).toHaveBeenCalledOnce();
  });

  it("clears a new pending record when the pre-mutation digest changed", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const installPackages = vi.fn();
    const createWorkspaceFiles = vi.fn();
    const commitConfig = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        env,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => ({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Changed" } } },
        }),
        installPackages,
        createWorkspaceFiles,
        commitConfig,
      }),
    ).rejects.toMatchObject({ code: "agent_config_conflict" });

    expect(installPackages).not.toHaveBeenCalled();
    expect(createWorkspaceFiles).not.toHaveBeenCalled();
    expect(commitConfig).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toBeUndefined();
  });

  it("keeps durable v3 provenance when the final compare-and-swap loses a race", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        transform({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        });
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      error: { code: "agent_config_conflict" },
      installRecord: { agentOrigin: "adopted" },
    });
    expect(readClawInstallRecord("worker", { env })).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v3",
      agentOrigin: "adopted",
    });
  });

  it("rejects a concurrently configured overlapping workspace in the final CAS", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    let committedConfig: OpenClawConfig | undefined;

    const result = await applyClawAddPlan(plan, {
      env,
      consentPlanIntegrity: plan.planIntegrity,
      readConfig: () => config,
      commitConfig: async (transform) => {
        const racedConfig: OpenClawConfig = {
          ...config,
          agents: {
            entries: {
              ...config.agents?.entries,
              other: { workspace: join(plan.agent.workspace, "nested") },
            },
          },
        };
        committedConfig = transform(racedConfig);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      configCommitted: false,
      error: { code: "agent_workspace_conflict" },
      installRecord: { agentOrigin: "adopted" },
    });
    expect(committedConfig).toBeUndefined();
  });

  it("preserves an existing v3 resume record when the early digest check loses a race", async () => {
    const { root, plan, config } = await fixture();
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    const resumeRecord = persistClawInstallRecord(plan, { env, status: "partial", nowMs: 1 });
    const installPackages = vi.fn();

    await expect(
      applyClawAddPlan(plan, {
        env,
        resumeRecord,
        consentPlanIntegrity: plan.planIntegrity,
        readConfig: () => ({
          ...config,
          agents: { entries: { worker: { ...config.agents?.entries?.worker, name: "Raced" } } },
        }),
        installPackages,
      }),
    ).rejects.toMatchObject({ code: "agent_config_conflict" });

    expect(installPackages).not.toHaveBeenCalled();
    expect(readClawInstallRecord("worker", { env })).toEqual(resumeRecord);
  });
});
