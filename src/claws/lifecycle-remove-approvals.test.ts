import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createAgent } from "../agents/agent-create.js";
import { beginAgentDeletion } from "../agents/agent-lifecycle-registry.js";
import { withTempHomeConfig, writeOpenClawConfig } from "../config/test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadExecApprovals, saveExecApprovals } from "../infra/exec-approvals.js";
import { readAgentDeletionJournal } from "../state/agent-deletion-journal.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { applyClawAddPlan } from "./add.js";
import {
  claimClawAgentConfigRemoval,
  digestClawAgentRemovalSurface,
} from "./lifecycle-config-removal.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  envSnapshot.restore();
});

async function buildApprovalFixture() {
  const root = tempDirs.make("openclaw-claw-remove-approvals-");
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
    byteLength: 100,
  };
  return await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace-worker") },
  });
}

describe("Claw exec approvals removal", () => {
  it.each([
    { label: "config-file commit", commit: false, complete: true },
    { label: "commitConfig seam", commit: true, complete: true },
    { label: "partial cleanup", commit: false, complete: false },
  ])("removes only the claw agent policy through the $label", async ({ commit, complete }) => {
    const addPlan = await buildApprovalFixture();

    await withTempHomeConfig({}, async ({ home }) => {
      const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw") };
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      await writeOpenClawConfig(home, config);
      saveExecApprovals({
        version: 1,
        agents: {
          "*": { security: "deny" },
          worker: {
            security: "allowlist",
            allowlist: [{ pattern: "/usr/bin/rm" }],
          },
          kept: {
            security: "allowlist",
            allowlist: [{ pattern: "/usr/bin/keep" }],
          },
        },
      });
      const plan = commit
        ? await buildClawRemovePlan("worker", { env, config })
        : await buildClawRemovePlan("worker");
      const common = {
        consentPlanIntegrity: plan.planIntegrity,
        trashPath: async () => complete,
      };

      const result = commit
        ? await applyClawRemovePlan(plan, {
            ...common,
            env,
            config,
            commitConfig: async (transform) => {
              config = transform(config);
            },
          })
        : await applyClawRemovePlan(plan, common);

      expect(result).toMatchObject({
        status: complete ? "complete" : "partial",
        agentRemoved: true,
      });
      expect(loadExecApprovals().agents).toEqual({
        "*": { security: "deny" },
        kept: {
          security: "allowlist",
          allowlist: [expect.objectContaining({ pattern: "/usr/bin/keep" })],
        },
      });
      expect(readAgentDeletionJournal("worker")).toMatchObject({
        cleanupCompleted: complete,
        deleteFiles: false,
      });
    });
  });

  it("blocks recreating the agent until destructive cleanup finishes", async () => {
    const addPlan = await buildApprovalFixture();

    await withTempHomeConfig({}, async ({ home }) => {
      const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw") };
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      await writeOpenClawConfig(home, config);
      const plan = await buildClawRemovePlan("worker");
      let creationDuringCleanup: Awaited<ReturnType<typeof createAgent>> | undefined;

      const result = await applyClawRemovePlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        trashPath: async () => {
          creationDuringCleanup ??= await createAgent({
            name: "worker",
            workspace: join(home, "replacement-worker"),
          });
          return true;
        },
      });

      expect(creationDuringCleanup).toMatchObject({
        status: "error",
        reason: "deletion-pending",
      });
      expect(result).toMatchObject({ status: "complete", agentRemoved: true });
      expect(readAgentDeletionJournal("worker")).toMatchObject({ cleanupCompleted: true });
    });
  });

  it("keeps the Claw retry owner when deletion journal completion is interrupted", async () => {
    const addPlan = await buildApprovalFixture();

    await withTempHomeConfig({}, async ({ home }) => {
      const env = { OPENCLAW_STATE_DIR: join(home, ".openclaw") };
      setTestEnvValue("OPENCLAW_STATE_DIR", env.OPENCLAW_STATE_DIR);
      let config: OpenClawConfig = {};
      await applyClawAddPlan(addPlan, {
        consentPlanIntegrity: addPlan.planIntegrity,
        env,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      });
      await writeOpenClawConfig(home, config);
      const plan = await buildClawRemovePlan("worker", { env, config });
      const state = openOpenClawStateDatabase({ env });
      state.db.exec(`
        CREATE TRIGGER fail_claw_deletion_completion
        BEFORE UPDATE OF cleanup_completed ON agent_deletion_journal
        WHEN NEW.cleanup_completed = 1
        BEGIN
          SELECT RAISE(ABORT, 'injected deletion journal completion failure');
        END;
      `);

      await expect(
        applyClawRemovePlan(plan, {
          consentPlanIntegrity: plan.planIntegrity,
          env,
          config,
          commitConfig: async (transform) => {
            config = transform(config);
          },
          trashPath: async () => true,
        }),
      ).rejects.toThrow("injected deletion journal completion failure");

      expect(readAgentDeletionJournal("worker", { env })).toMatchObject({
        cleanupCompleted: false,
      });
      await expect(readClawStatus("worker", { env, config })).resolves.toMatchObject({
        records: [
          expect.objectContaining({ install: expect.objectContaining({ agentId: "worker" }) }),
        ],
      });
    });
  });

  // beginAgentDeletion takes over an existing journal row, so a failed Claw removal must not roll
  // back a deletion another path started.
  it.each([
    { label: "keeps a pre-existing journal", seedJournal: true },
    { label: "rolls back the journal it opened", seedJournal: false },
  ])("$label when the config commit fails", async ({ seedJournal }) => {
    const root = tempDirs.make("openclaw-claw-remove-journal-");
    setTestEnvValue("OPENCLAW_STATE_DIR", join(root, "state"));
    if (seedJournal) {
      beginAgentDeletion({
        agentId: "worker",
        agentDir: join(root, "agent"),
        workspaceDir: join(root, "workspace"),
        sessionsDir: join(root, "sessions"),
      });
    }

    await expect(
      claimClawAgentConfigRemoval({
        agentId: "worker",
        expectedDigest: "sha256:unused",
        expectedRemovalSurfaceDigest: digestClawAgentRemovalSurface({}, "worker"),
        expectedState: "present",
        fallbackWorkspace: join(root, "workspace"),
        config: {},
        commitConfig: async () => {
          throw new Error("claw commit failed");
        },
        onModified: () => new Error("claw agent modified"),
      }),
    ).rejects.toThrow("claw commit failed");

    expect(readAgentDeletionJournal("worker") === undefined).toBe(!seedJournal);
  });
});
