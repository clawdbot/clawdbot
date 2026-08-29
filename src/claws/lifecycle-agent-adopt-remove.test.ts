// Removal coverage for historical state retained after configured-agent adoption.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listOpenClawRegisteredAgentDatabases,
  registerOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

async function adoptedAgentFixture() {
  const root = tempDirs.make("openclaw-claw-agent-adopt-remove-");
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
  let config: OpenClawConfig = {
    agents: { entries: { worker: { name: "Worker", workspace, default: true } } },
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: {
      workspace,
      adoptExistingAgent: true,
      existingAgents: [{ id: "worker", name: "Worker", workspace, default: true }],
    },
  });
  const env = { OPENCLAW_STATE_DIR: join(root, "state") };
  await applyClawAddPlan(plan, {
    env,
    consentPlanIntegrity: plan.planIntegrity,
    readConfig: () => config,
    commitConfig: async (transform) => {
      config = transform(config);
    },
  });
  return {
    env,
    workspace,
    getConfig: () => config,
    setConfig: (next: OpenClawConfig) => (config = next),
  };
}

describe("Claw remove after configured-agent adoption", () => {
  it("reports adopted agent origin in status", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    current.setConfig({ agents: { entries: { WORKER: agent } } });

    await expect(
      readClawStatus("worker", { env: current.env, config: current.getConfig() }),
    ).resolves.toMatchObject({ records: [{ agentOrigin: "adopted", agentState: "present" }] });
  });

  it("plans retention for the pre-existing agent and session state", async () => {
    const current = await adoptedAgentFixture();

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agentState", action: "retain", blocked: false }),
        expect.objectContaining({ kind: "sessionIndex", action: "retain", blocked: false }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "retain", blocked: false }),
        expect.objectContaining({ kind: "workspace", action: "retain", blocked: false }),
      ]),
    );
  });

  it("keeps durable database discovery for the retained adopted agent", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    current.setConfig({ agents: { entries: { WORKER: agent } } });
    const databasePath = join(
      current.env.OPENCLAW_STATE_DIR,
      "agents",
      "worker",
      "agent",
      "openclaw-agent.sqlite",
    );
    registerOpenClawAgentDatabase({ agentId: "worker", path: databasePath, env: current.env });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        current.setConfig(transform(current.getConfig()));
      },
      purgeSessions: vi.fn(),
      trashPath: vi.fn(async () => true),
    });

    expect(result.status).toBe("complete");
    // Removal retains the adopted agent's database and sessions, so the registration that finds
    // them must survive; unregistering here would orphan state the operator still owns.
    expect(
      listOpenClawRegisteredAgentDatabases({ env: current.env }).map((entry) => entry.agentId),
    ).toEqual(["worker"]);
  });

  it("removes managed config without purging or trashing historical state", async () => {
    const current = await adoptedAgentFixture();
    const agent = current.getConfig().agents?.entries?.worker;
    if (!agent) {
      throw new Error("fixture agent missing");
    }
    current.setConfig({ agents: { entries: { WORKER: agent } } });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const purgeSessions = vi.fn();
    const trashPath = vi.fn(async () => true);

    const result = await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        current.setConfig(transform(current.getConfig()));
      },
      purgeSessions,
      trashPath,
    });

    expect(result.status).toBe("complete");
    expect(Object.keys(current.getConfig().agents?.entries ?? {})).toEqual([]);
    expect(purgeSessions).not.toHaveBeenCalled();
    expect(trashPath).not.toHaveBeenCalled();
  });
});
