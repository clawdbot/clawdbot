// Removal coverage for Claw installs that adopted an existing operator-owned workspace.
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { inspectClawWorkspaceFile } from "./lifecycle-delete-support.js";
import { clawRemoveFixtures } from "./lifecycle-remove.test-support.js";
import { applyClawRemovePlan, buildClawRemovePlan } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { persistClawInstallRecord } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";
import { CLAW_ADOPTED_WORKSPACE_MARKER_PATH, clawWorkspaceWasAdopted } from "./workspace-origin.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const { fixture, addFixture } = clawRemoveFixtures(tempDirs);

describe("Claw remove with an adopted workspace", () => {
  async function adoptedFixture() {
    const root = tempDirs.make("openclaw-claw-adopt-remove-");
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
    const parsed = parseClawManifest({
      schemaVersion: 1,
      agent: { id: "worker", name: "Worker" },
      workspace: { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } },
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
      byteLength: 100,
    };
    // The operator's directory already holds the declared file, so after adoption every entry in
    // it is Claw-managed and nothing distinguishes it from a workspace this install created.
    const workspace = join(root, "existing-workspace");
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "SOUL.md"), "managed\n", "utf8");
    const plan = await buildClawAddPlan({
      manifest: parsed.manifest,
      source,
      context: { workspace, adoptExistingWorkspace: true },
    });
    const env = { OPENCLAW_STATE_DIR: join(root, "state") };
    let config: OpenClawConfig = {};
    await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    // The install records the canonical workspace path, which is what removal compares against.
    return { env, workspace: plan.agent.workspace, getConfig: () => config };
  }

  it("plans retention for an adopted workspace holding only declared files", async () => {
    const current = await adoptedFixture();

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "workspace",
        action: "retain",
        reason: "Workspace existed before this Claw adopted it.",
        details: expect.objectContaining({ retained: true }),
      }),
    );
  });

  it("never trashes an adopted workspace directory during removal", async () => {
    const current = await adoptedFixture();

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const removed = await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        transform(current.getConfig());
      },
      purgeSessions: async () => undefined,
      // Delete for real: a trash stub that only records calls cannot tell a retained directory
      // from one the canonical path spelling hid from the assertion.
      trashPath: async (target) => {
        await rm(target, { recursive: true, force: true });
        return true;
      },
    });

    expect(removed).toMatchObject({ status: "complete" });
    await expect(stat(current.workspace)).resolves.toMatchObject({});
  });

  it("still purges created-agent history when only its workspace was adopted", async () => {
    const current = await adoptedFixture();
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const purgeSessions = vi.fn(async () => undefined);
    const trashed: string[] = [];

    await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        transform(current.getConfig());
      },
      purgeSessions,
      trashPath: async (target) => {
        trashed.push(target);
        return true;
      },
    });

    const agentState = plan.actions.find((action) => action.kind === "agentState")?.target;
    const transcripts = plan.actions.find((action) => action.kind === "sessionTranscripts")?.target;
    expect(purgeSessions).toHaveBeenCalledOnce();
    expect(trashed).toEqual(expect.arrayContaining([agentState, transcripts]));
    expect(trashed).not.toContain(current.workspace);
  });

  it("keeps a removal preview read-only when no origin marker exists", async () => {
    const current = await addFixture();
    const db = openOpenClawStateDatabase({ env: current.env }).db;
    const markerCount = () =>
      db
        .prepare("SELECT count(*) AS count FROM claw_workspace_files WHERE target_path = ?")
        .get(CLAW_ADOPTED_WORKSPACE_MARKER_PATH) as { count: number };
    expect(markerCount().count).toBe(0);

    await buildClawRemovePlan("worker", { env: current.env, config: current.getConfig() });

    expect(markerCount().count).toBe(0);
  });

  it("ignores an origin marker recorded for a different workspace", async () => {
    const current = await addFixture();
    const workspace = current.plan.agent.workspace;
    const db = openOpenClawStateDatabase({ env: current.env }).db;
    db.prepare(
      `INSERT OR REPLACE INTO claw_workspace_files (
         agent_id, target_path, schema_version, workspace, source_path,
         content_digest, status, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'complete', 1, 1)`,
    ).run(
      "worker",
      CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
      "openclaw.clawWorkspaceFileRecord.v1",
      `${workspace}-previous`,
      CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
      "openclaw:adopted-workspace",
    );

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "trash" }),
    );
  });

  it("clears a stale origin marker when a non-adopted install is persisted", async () => {
    const current = await fixture({ id: "worker" });
    const db = openOpenClawStateDatabase({ env: current.env }).db;
    db.prepare(
      `INSERT OR REPLACE INTO claw_workspace_files (
         agent_id, target_path, schema_version, workspace, source_path,
         content_digest, status, created_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, 'complete', 1, 1)`,
    ).run(
      "worker",
      CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
      "openclaw.clawWorkspaceFileRecord.v1",
      current.plan.agent.workspace,
      CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
      "openclaw:adopted-workspace",
    );

    persistClawInstallRecord(current.plan, { env: current.env, nowMs: 5 });

    expect(
      clawWorkspaceWasAdopted("worker", current.plan.agent.workspace, { env: current.env }),
    ).toBe(false);
  });

  it("makes an older reader fail closed on the adopted-workspace marker", async () => {
    const current = await adoptedFixture();

    const inspected = await inspectClawWorkspaceFile({
      schemaVersion: "openclaw.clawWorkspaceFileRecord.v1",
      agentId: "worker",
      workspace: current.workspace,
      path: CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
      sourcePath: CLAW_ADOPTED_WORKSPACE_MARKER_PATH,
      contentDigest: "openclaw:adopted-workspace",
      status: "complete",
      createdAtMs: 1,
      updatedAtMs: 1,
    });

    expect(inspected).toMatchObject({ state: "unsafe" });
  });

  it("drops the adopted-workspace origin once the install is removed", async () => {
    const current = await adoptedFixture();
    expect(clawWorkspaceWasAdopted("worker", current.workspace, { env: current.env })).toBe(true);

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    await applyClawRemovePlan(plan, {
      env: current.env,
      config: current.getConfig(),
      consentPlanIntegrity: plan.planIntegrity,
      commitConfig: async (transform) => {
        transform(current.getConfig());
      },
      purgeSessions: async () => undefined,
      trashPath: async () => true,
    });

    expect(clawWorkspaceWasAdopted("worker", current.workspace, { env: current.env })).toBe(false);
  });
});
