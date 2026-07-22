// Tests root Claw install ownership and the narrow agent/workspace mutation slice.
import { access, mkdir, rmdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan, ClawAddMutationError } from "./add.js";
import { ClawCronInstallError } from "./cron.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  persistClawPackageRef,
  persistClawInstallRecord,
  readClawPackageRefs,
  readClawInstallRecord,
  updateClawInstallRecordStatus,
} from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

async function makePlan(
  manifestValue: unknown = { schemaVersion: 1, agent: { id: "worker" } },
  options: { workspace?: string } = {},
) {
  const root = tempDirs.make("openclaw-claw-add-");
  const parsed = parseClawManifest(manifestValue);
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
    byteLength: 123,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: options.workspace ?? join(root, "workspace-worker") },
  });
  return { root, plan };
}

function stateEnv(root: string) {
  return { OPENCLAW_STATE_DIR: join(root, "state") };
}

function readInstallRow(agentId: string, root: string) {
  return openOpenClawStateDatabase({ env: stateEnv(root) })
    .db.prepare(
      `SELECT agent_id, schema_version, claw_name, claw_version, integrity, plan_integrity,
              workspace, agent_config_digest, agent_owned_paths_json, status, added_at_ms
         FROM claw_installs
        WHERE agent_id = ?`,
    )
    .get(agentId) as
    | {
        agent_id: string;
        schema_version: string;
        claw_name: string;
        claw_version: string;
        integrity: string;
        plan_integrity: string;
        workspace: string;
        agent_config_digest: string;
        agent_owned_paths_json: string;
        status: string;
        added_at_ms: number | bigint;
      }
    | undefined;
}

describe("Claw root install provenance", () => {
  it("replays an exact package ref without losing its relationship or origin", async () => {
    const { root, plan } = await makePlan();
    const pkg = {
      kind: "plugin" as const,
      source: "clawhub" as const,
      ref: "@acme/audit",
      version: "1.2.3",
      integrity: `sha256:${"a".repeat(64)}`,
    };

    persistClawPackageRef(plan, pkg, {
      env: stateEnv(root),
      nowMs: 42,
      status: "pending",
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    });
    const replayed = persistClawPackageRef(plan, pkg, {
      env: stateEnv(root),
      nowMs: 84,
      status: "complete",
      relationship: "referenced",
      origin: "pre-existing",
      independentOwner: true,
    });

    expect(replayed).toMatchObject({
      status: "complete",
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: true,
      installedAtMs: 42,
      updatedAtMs: 84,
    });
    expect(readClawPackageRefs({ env: stateEnv(root) })).toEqual([replayed]);
  });

  it("persists package identity, agent ownership, workspace, and config digest", async () => {
    const { root, plan } = await makePlan();

    const record = persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 42 });

    expect(record).toMatchObject({
      schemaVersion: "openclaw.clawInstallRecord.v1",
      claw: { name: "@acme/worker", version: "1.0.0", integrity: "sha256:manifest" },
      manifestSchemaVersion: 1,
      planIntegrity: plan.planIntegrity,
      agentId: "worker",
      workspace: plan.agent.workspace,
      agentOwnedPaths: ['agents.entries["worker"]'],
      status: "complete",
      addedAtMs: 42,
    });
    expect(record.agentConfigDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readInstallRow("worker", root)).toMatchObject({
      agent_id: record.agentId,
      schema_version: record.schemaVersion,
      claw_name: record.claw.name,
      claw_version: record.claw.version,
      integrity: record.claw.integrity,
      plan_integrity: record.planIntegrity,
      workspace: record.workspace,
      agent_config_digest: record.agentConfigDigest,
      agent_owned_paths_json: JSON.stringify(record.agentOwnedPaths),
      status: record.status,
      added_at_ms: record.addedAtMs,
    });
  });

  it("does not overwrite a completed install record for the same agent", async () => {
    const { root, plan } = await makePlan();
    persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 1 });

    expect(() => persistClawInstallRecord(plan, { env: stateEnv(root), nowMs: 2 })).toThrow();
    expect(Number(readInstallRow("worker", root)?.added_at_ms)).toBe(1);
  });

  it("resumes a matching non-complete install record without inserting again", async () => {
    const { root, plan } = await makePlan();
    const first = persistClawInstallRecord(plan, {
      env: stateEnv(root),
      status: "pending",
      nowMs: 1,
    });

    const resumed = persistClawInstallRecord(plan, {
      env: stateEnv(root),
      status: "pending",
      nowMs: 2,
    });

    expect(resumed).toEqual(first);
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })).toMatchObject({
      agentId: "worker",
      status: "pending",
      addedAtMs: 1,
    });
  });

  it("rejects a stale phase update after an install reaches complete", async () => {
    const { root, plan } = await makePlan();
    const options = { env: stateEnv(root) };
    persistClawInstallRecord(plan, { ...options, status: "pending", nowMs: 1 });
    updateClawInstallRecordStatus("worker", "workspace_ready", {
      ...options,
      expectedStatuses: ["pending"],
      nowMs: 2,
    });
    updateClawInstallRecordStatus("worker", "config_committed", {
      ...options,
      expectedStatuses: ["workspace_ready"],
      nowMs: 3,
    });
    updateClawInstallRecordStatus("worker", "complete", {
      ...options,
      expectedStatuses: ["config_committed"],
      nowMs: 4,
    });

    expect(() =>
      updateClawInstallRecordStatus("worker", "partial", {
        ...options,
        expectedStatuses: ["pending", "partial"],
        nowMs: 5,
      }),
    ).toThrow("did not match the expected phase");
    expect(readClawInstallRecord("worker", options)?.status).toBe("complete");
  });
});

describe("applyClawAddPlan", () => {
  it("appends one agent, preserves defaults and existing agents, and creates a new workspace", async () => {
    const { root, plan } = await makePlan({
      schemaVersion: 1,
      agent: {
        id: "worker",
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
      },
    });
    let config: OpenClawConfig = {
      agents: {
        defaults: { workspace: "/operator/default" },
        entries: { main: { default: true } },
      },
    };

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      nowMs: 10,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result).toMatchObject({
      schemaVersion: "openclaw.clawAddResult.v1",
      stability: "experimental",
      status: "complete",
      workspaceCreated: true,
      configCommitted: true,
      installRecord: { agentId: "worker" },
    });
    expect(config.agents?.defaults).toEqual({ workspace: "/operator/default" });
    expect(config.agents?.entries).toEqual({
      main: { default: true },
      worker: {
        name: "Worker",
        identity: { name: "Work" },
        tools: { deny: ["exec"] },
        workspace: plan.agent.workspace,
      },
    });
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
  });

  it("materializes the implicit main agent before appending the first configured agent", async () => {
    const { root, plan } = await makePlan();
    let config: OpenClawConfig = {};

    await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(config.agents?.entries).toEqual({
      main: { default: true },
      worker: expect.any(Object),
    });
  });

  it("rejects overlap with the implicit main workspace before materializing it", async () => {
    const root = tempDirs.make("openclaw-claw-implicit-main-");
    const mainWorkspace = join(root, "main-workspace");
    const { root: planRoot, plan } = await makePlan(undefined, {
      workspace: join(mainWorkspace, "nested-claw"),
    });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(planRoot),
        commitConfig: async (transform) => {
          transform({ agents: { defaults: { workspace: mainWorkspace } } });
        },
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "workspace_collision" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
    expect(readInstallRow("worker", planRoot)?.status).toBe("partial");
  });

  it("rechecks agent collisions during the config commit and cleans the reserved workspace", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          transform({ agents: { entries: { worker: {} } } });
        },
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "agent_id_collision" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("rechecks normalized agent collisions during the config commit", async () => {
    const { root, plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, {
        env: stateEnv(root),
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          transform({ agents: { entries: { " Worker ": {} } } });
        },
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "agent_id_collision" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("rechecks aliased workspace collisions during the config commit", async () => {
    const root = tempDirs.make("openclaw-claw-workspace-alias-");
    const canonicalParent = join(root, "canonical");
    const aliasParent = join(root, "alias");
    await mkdir(canonicalParent);
    await symlink(canonicalParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    const { root: planRoot, plan } = await makePlan(undefined, {
      workspace: join(canonicalParent, "workspace-worker"),
    });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(planRoot),
        commitConfig: async (transform) => {
          transform({
            agents: {
              entries: { other: { workspace: join(aliasParent, "workspace-worker") } },
            },
          });
        },
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "workspace_collision" },
    });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("rejects workspace ancestry changes after planning", async () => {
    const root = tempDirs.make("openclaw-claw-workspace-swap-");
    const canonicalParent = join(root, "canonical");
    const alternateParent = join(root, "alternate");
    await mkdir(canonicalParent);
    await mkdir(alternateParent);
    const { root: planRoot, plan } = await makePlan(undefined, {
      workspace: join(canonicalParent, "workspace-worker"),
    });
    await rmdir(canonicalParent);
    await symlink(
      alternateParent,
      canonicalParent,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(planRoot),
      }),
    ).rejects.toMatchObject({ code: "workspace_path_changed" });
    await expect(access(join(alternateParent, "workspace-worker"))).rejects.toThrow();
    expect(readInstallRow("worker", planRoot)).toBeUndefined();
  });

  it("records a partial add when the workspace appears after planning", async () => {
    const { root, plan } = await makePlan();
    await mkdir(plan.agent.workspace);

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
      }),
    ).resolves.toMatchObject({
      status: "partial",
      workspaceCreated: false,
      configCommitted: false,
      error: { code: "workspace_collision" },
    });
    expect(readInstallRow("worker", root)?.status).toBe("partial");
  });

  it("records parent-directory creation failures before workspace mutation", async () => {
    const root = tempDirs.make("openclaw-claw-add-");
    const blockedParent = join(root, "blocked-parent");
    await writeFile(blockedParent, "not a directory", "utf8");
    const { plan } = await makePlan(undefined, {
      workspace: join(blockedParent, "workspace-worker"),
    });

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
      }),
    ).rejects.toMatchObject({ code: "workspace_parent_failed" });
    expect(readInstallRow("worker", root)).toBeUndefined();
  });

  it("removes a new workspace when its durable phase cannot be recorded", async () => {
    const { root, plan } = await makePlan();
    const statuses: string[] = [];

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
        updateRecord: (_agentId, status) => {
          statuses.push(status);
          if (status === "workspace_ready") {
            throw new Error("database unavailable");
          }
        },
      }),
    ).rejects.toMatchObject({ code: "provenance_failed" });

    expect(statuses).toEqual(["workspace_ready"]);
    await expect(access(plan.agent.workspace)).rejects.toThrow();
    expect(readInstallRow("worker", root)).toBeUndefined();
  });

  it("resumes a matching partial add with an existing non-empty workspace", async () => {
    const { root, plan } = await makePlan();
    let config: OpenClawConfig = {};
    let attempts = 0;

    const first = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        attempts += 1;
        if (attempts === 1) {
          await writeFile(join(plan.agent.workspace, "leftover.txt"), "keep", "utf8");
          throw new Error("config unavailable");
        }
        config = transform(config);
      },
    });

    expect(first).toMatchObject({
      status: "partial",
      error: { code: "config_commit_failed", message: "config unavailable" },
    });
    expect(readInstallRow("worker", root)?.status).toBe("workspace_ready");

    const retry = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(retry).toMatchObject({
      status: "complete",
      workspaceCreated: true,
      configCommitted: true,
    });
    expect(config.agents?.entries?.worker).toBeDefined();
    expect(readInstallRow("worker", root)?.status).toBe("complete");
  });

  it("recreates a missing workspace for a matching workspace-ready record", async () => {
    const { root, plan } = await makePlan();
    persistClawInstallRecord(plan, {
      env: stateEnv(root),
      status: "workspace_ready",
      nowMs: 1,
    });
    let config: OpenClawConfig = {};

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(result.status).toBe("complete");
    await expect(access(plan.agent.workspace)).resolves.toBeUndefined();
    expect(config.agents?.entries?.worker).toBeDefined();
  });

  it("rejects a non-directory replacement for a workspace-ready record", async () => {
    const { root, plan } = await makePlan();
    persistClawInstallRecord(plan, {
      env: stateEnv(root),
      status: "workspace_ready",
      nowMs: 1,
    });
    await writeFile(plan.agent.workspace, "not a directory", "utf8");
    let config: OpenClawConfig = {};

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        env: stateEnv(root),
        commitConfig: async (transform) => {
          config = transform(config);
        },
      }),
    ).rejects.toMatchObject({ code: "workspace_collision" });

    expect(config.agents?.entries).toBeUndefined();
    expect(readClawInstallRecord("worker", { env: stateEnv(root) })?.status).toBe(
      "workspace_ready",
    );
  });

  it("blocks declared components that this lifecycle slice cannot yet create", async () => {
    const { plan } = await makePlan({
      schemaVersion: 1,
      agent: { id: "worker" },
      packages: [
        {
          kind: "skill",
          source: "clawhub",
          ref: "demo",
          version: "1.0.0",
        },
      ],
    });

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: plan.planIntegrity }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ClawAddMutationError>>({ code: "plan_blocked" }),
    );
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("fails before mutation when the pending provenance record cannot be persisted", async () => {
    const { plan } = await makePlan();
    let config: OpenClawConfig = {};

    await expect(
      applyClawAddPlan(plan, {
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          config = transform(config);
        },
        persistRecord: () => {
          throw new Error("database unavailable");
        },
      }),
    ).rejects.toMatchObject({ code: "provenance_failed" });
    expect(config.agents?.entries).toBeUndefined();
  });

  it("rejects mutation when consent does not bind the current plan", async () => {
    const { plan } = await makePlan();

    await expect(
      applyClawAddPlan(plan, { consentPlanIntegrity: "sha256:stale" }),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
    await expect(access(plan.agent.workspace)).rejects.toThrow();
  });

  it("returns partial cron ownership when scheduler installation fails", async () => {
    const { root, plan } = await makePlan({
      schemaVersion: 1,
      agent: { id: "worker" },
      cronJobs: [
        {
          id: "daily-report",
          schedule: { cron: "0 9 * * *", timezone: "UTC" },
          session: "isolated",
          message: "Prepare report",
        },
      ],
    });
    const failedRef = {
      schemaVersion: "openclaw.clawCronRef.v1" as const,
      agentId: "worker",
      manifestId: "daily-report",
      declarationKey: "claw:worker:daily-report",
      status: "failed" as const,
      job: {
        id: "daily-report",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "isolated" as const,
        message: "Prepare report",
      },
      error: "gateway unavailable",
      createdAtMs: 1,
      updatedAtMs: 2,
    };

    const result = await applyClawAddPlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: stateEnv(root),
      commitConfig: async (transform) => {
        transform({});
      },
      installCronJobs: async () => {
        throw new ClawCronInstallError("cron_install_failed", "gateway unavailable", [failedRef]);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      cronJobs: [{ manifestId: "daily-report", status: "failed" }],
      installRecord: { status: "config_committed" },
      error: { code: "cron_install_failed", message: "gateway unavailable" },
    });
  });
});
