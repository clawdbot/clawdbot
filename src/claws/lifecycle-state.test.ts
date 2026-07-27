import { link, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { applyClawAddPlan } from "./add.js";
import { markClawCronRefRemoved, readClawCronRefs } from "./cron.js";
import { claimClawAgentConfigRemoval } from "./lifecycle-config-removal.js";
import { applyClawRemovePlan, buildClawRemovePlan, readClawStatus } from "./lifecycle-state.js";
import { buildClawAddPlan } from "./lifecycle.js";
import {
  persistClawInstallRecord,
  persistClawPackageRef,
  readClawPackageRefs,
} from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const packageIntegrity = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function cronReadView(agentId: string, ref: ReturnType<typeof readClawCronRefs>[number]) {
  const job = ref.job;
  const normalized = normalizeCronJobCreate({
    name: job.name ?? job.id,
    declarationKey: ref.declarationKey,
    ...(job.name ? { displayName: job.name } : {}),
    owner: { agentId },
    enabled: true,
    agentId,
    schedule: {
      kind: "cron",
      expr: job.schedule.cron,
      ...(job.schedule.timezone ? { tz: job.schedule.timezone } : {}),
    },
    sessionTarget: job.session === "main" ? `session:agent:${agentId}:main` : job.session,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: job.message },
    delivery: job.delivery
      ? {
          mode: job.delivery.mode,
          ...(job.delivery.channel ? { channel: job.delivery.channel } : {}),
        }
      : { mode: "none" },
  });
  if (!normalized || !ref.schedulerJobId) {
    throw new Error("expected complete cron provenance");
  }
  return {
    ...normalized,
    id: ref.schedulerJobId,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {},
  };
}

async function fixture(
  params: {
    id?: string;
    name?: string;
    withFile?: boolean;
    withCron?: boolean;
    withMcp?: boolean;
  } = {},
) {
  const root = tempDirs.make("openclaw-claw-remove-");
  if (params.withFile) {
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: params.id ?? "worker", name: "Worker" },
    workspace: params.withFile ? { bootstrapFiles: { "SOUL.md": { source: "SOUL.md" } } } : {},
    mcpServers: params.withMcp
      ? {
          docs: {
            command: "uvx",
            args: ["docs-mcp"],
            env: { DOCS_TOKEN: "${DOCS_TOKEN}" },
          },
        }
      : {},
    cronJobs: params.withCron
      ? [
          {
            id: "daily-report",
            schedule: { cron: "0 9 * * *", timezone: "UTC" },
            session: "isolated",
            message: "Prepare report",
          },
        ]
      : [],
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: params.name ?? "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, `workspace-${params.id ?? "worker"}`) },
  });
  return { root, plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}

async function addFixture(
  params: { withFile?: boolean; withCron?: boolean; withMcp?: boolean } = {},
) {
  const current = await fixture(params);
  let config: OpenClawConfig = {};
  await applyClawAddPlan(current.plan, {
    consentPlanIntegrity: current.plan.planIntegrity,
    env: current.env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
    ...(params.withMcp ? { installMcpServers: async () => [] } : {}),
  });
  return {
    ...current,
    getConfig: () => config,
    commitConfig: async (transform: (current: OpenClawConfig) => OpenClawConfig) => {
      config = transform(config);
    },
  };
}

describe("Claw status and remove", () => {
  it("rejects cleanup when an expected-missing agent id was recreated", async () => {
    await expect(
      claimClawAgentConfigRemoval({
        agentId: "worker",
        expectedDigest: "sha256:missing",
        expectedRemovalSurfaceDigest: "sha256:unused",
        expectedState: "missing",
        fallbackWorkspace: "/tmp/old-worker",
        config: { agents: { entries: { worker: { workspace: "/tmp/new-worker" } } } },
        onModified: () => new Error("agent recreated"),
      }),
    ).rejects.toThrow("agent recreated");
  });

  it("reports installed agent, managed files, and package references", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env, nowMs: 2 },
    );
    const status = await readClawStatus("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(status).toMatchObject({
      summary: {
        claws: 1,
        partial: 0,
        missingAgents: 0,
        driftedFiles: 0,
        packageRefs: 1,
        missingPackages: 1,
      },
      records: [
        {
          install: { agentId: "worker", claw: { name: "@acme/worker" } },
          agentState: "present",
          workspaceFiles: [{ path: "SOUL.md", state: "unchanged" }],
          packages: [{ kind: "plugin", ref: "audit", state: "missing" }],
        },
      ],
    });
  });

  it("counts every non-complete root install as partial", async () => {
    const current = await fixture();
    persistClawInstallRecord(current.plan, { env: current.env, status: "config_committed" });

    await expect(
      readClawStatus("worker", { env: current.env, config: { agents: { entries: {} } } }),
    ).resolves.toMatchObject({ summary: { claws: 1, partial: 1 } });
  });

  it("reports orphaned subordinate ownership without a root install row", async () => {
    const current = await fixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env, nowMs: 2 },
    );

    await expect(readClawStatus("worker", { env: current.env, config: {} })).resolves.toMatchObject(
      {
        summary: { claws: 1, partial: 1, missingAgents: 1, packageRefs: 1 },
        records: [
          {
            orphaned: true,
            install: { agentId: "worker", status: "partial" },
            packages: [{ ref: "audit", state: "missing" }],
          },
        ],
      },
    );

    const remove = await buildClawRemovePlan("worker", { env: current.env, config: {} });
    const removed = await applyClawRemovePlan(remove, {
      env: current.env,
      config: {},
      consentPlanIntegrity: remove.planIntegrity,
      commitConfig: async (transform) => {
        transform({});
      },
      purgeSessions: async () => undefined,
      trashPath: async () => true,
    });
    expect(removed).toMatchObject({ status: "complete", agentRemoved: false });
    await expect(readClawStatus("worker", { env: current.env, config: {} })).resolves.toMatchObject(
      {
        summary: { claws: 0 },
      },
    );
  });

  it("previews all canonical agent config deletion effects", async () => {
    const current = await addFixture();
    const config: OpenClawConfig = {
      ...current.getConfig(),
      bindings: [{ match: { channel: "telegram", accountId: "*" }, agentId: "worker" }],
      tools: { agentToAgent: { allow: ["worker"] } },
    } as OpenClawConfig;

    const plan = await buildClawRemovePlan("worker", { env: current.env, config });

    expect(plan.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", target: 'agents.entries["worker"]' }),
        expect.objectContaining({ kind: "configBinding", target: "bindings[agentId=worker]" }),
        expect.objectContaining({ kind: "agentAllow", target: "tools.agentToAgent.allow[worker]" }),
        expect.objectContaining({ kind: "workspace", action: "trash" }),
        expect.objectContaining({ kind: "agentState", action: "trash" }),
        expect.objectContaining({ kind: "sessionIndex", action: "delete" }),
        expect.objectContaining({ kind: "sessionTranscripts", action: "trash" }),
      ]),
    );
  });

  it("rejects consent when a binding changes without changing the binding count", async () => {
    const current = await addFixture();
    const config: OpenClawConfig = {
      ...current.getConfig(),
      bindings: [{ match: { channel: "telegram", accountId: "first" }, agentId: "worker" }],
    } as OpenClawConfig;
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    const changedConfig: OpenClawConfig = {
      ...config,
      bindings: [{ match: { channel: "telegram", accountId: "second" }, agentId: "worker" }],
    } as OpenClawConfig;

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          transform(changedConfig);
        },
      }),
    ).rejects.toMatchObject({ code: "agent_modified" });
  });

  it("previews and blocks operator-owned cron jobs attached to the agent", async () => {
    const current = await addFixture();
    const database = openOpenClawStateDatabase({ env: current.env });
    database.db
      .prepare(
        `INSERT INTO cron_jobs (
           store_key, job_id, name, enabled, created_at_ms, agent_id, owner_agent_id,
           schedule_kind, session_target, wake_mode, payload_kind, job_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "default",
        "operator-job",
        "Operator job",
        1,
        1,
        "worker",
        "worker",
        "every",
        "isolated",
        "now",
        "agentTurn",
        "{}",
        1,
      );

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_job_attached" }));
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "scheduledJob",
        id: "operator-job",
        action: "retain",
        blocked: true,
      }),
    );
  });

  it("does not treat Claw-owned cron jobs as external agent blockers", async () => {
    const current = await addFixture({ withCron: true });
    const database = openOpenClawStateDatabase({ env: current.env });
    database.db
      .prepare(
        `INSERT INTO cron_jobs (
           store_key, job_id, name, enabled, created_at_ms, agent_id, owner_agent_id,
           schedule_kind, session_target, wake_mode, payload_kind, job_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "default",
        "scheduler-daily",
        "Claw job",
        1,
        1,
        "worker",
        "worker",
        "cron",
        "isolated",
        "now",
        "agentTurn",
        "{}",
        1,
      );

    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });

    expect(plan.blockers).not.toContainEqual(
      expect.objectContaining({ code: "agent_job_attached" }),
    );
  });

  it("removes the agent and unchanged files but only releases package refs", async () => {
    const current = await addFixture({ withFile: true });
    persistClawPackageRef(
      current.plan,
      {
        kind: "skill",
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      { env: current.env },
    );
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      packageRefsReleased: 1,
      workspaceFiles: [{ path: "SOUL.md", action: "deleted" }],
    });
    expect(config.agents?.entries?.worker).toBeUndefined();
    await expect(readFile(join(current.plan.agent.workspace, "SOUL.md"), "utf8")).rejects.toThrow();
    await expect(readClawStatus("worker", { env: current.env, config })).resolves.toMatchObject({
      summary: { claws: 0 },
    });
  });

  it("removes scheduler-owned cron jobs before agent config", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({
        kind: "cronJob",
        id: "daily-report",
        action: "remove",
        target: "scheduler-daily",
      }),
    );
    let config = current.getConfig();
    const order: string[] = [];
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      cronGateway: {
        get: async () =>
          cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
        remove: async (id) => {
          order.push(`cron:${id}`);
          return { ok: true };
        },
      },
      commitConfig: async (transform) => {
        order.push("config");
        config = transform(config);
      },
    });
    expect(order).toEqual(["cron:scheduler-daily", "config"]);
    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [
        { manifestId: "daily-report", schedulerJobId: "scheduler-daily", action: "removed" },
      ],
    });
  });

  it("accepts the scheduler's default tool cap when removing a Claw cron job", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const ref = readClawCronRefs("worker", { env: current.env })[0]!;
    const live = cronReadView("worker", ref);
    const remove = vi.fn().mockResolvedValue({ ok: true });

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config: current.getConfig(),
      commitConfig: current.commitConfig,
      cronGateway: {
        get: async () => ({
          ...live,
          payload: { ...live.payload, toolsAllow: ["*"] },
        }),
        remove,
      },
    });

    expect(remove).toHaveBeenCalledWith(ref.schedulerJobId);
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("fails removal planning when source MCP config cannot be read", async () => {
    const current = await addFixture({ withCron: true });

    await expect(
      buildClawRemovePlan("worker", {
        env: current.env,
        config: current.getConfig(),
        listMcpServers: async () => ({
          ok: false,
          path: "config",
          error: "Config file is invalid.",
        }),
      }),
    ).rejects.toMatchObject({ code: "mcp_config_unavailable" });
  });

  it("removes cron before the canonical agent config lifecycle", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const calls: string[] = [];

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config: current.getConfig(),
      commitConfig: current.commitConfig,
      cronGateway: {
        get: async () =>
          cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
        remove: async (id) => {
          calls.push(`cron:${id}`);
          return { ok: true };
        },
      },
    });

    expect(calls).toEqual(["cron:scheduler-daily"]);
    expect(result).toMatchObject({
      status: "complete",
      agentRemoved: true,
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("retains the agent when recurring work cannot be disabled", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config: current.getConfig(),
      cronGateway: {
        get: async () =>
          cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
        remove: async () => {
          throw new Error("scheduler unavailable");
        },
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: false,
      error: { code: "cron_cleanup_failed", message: "scheduler unavailable" },
      cronJobs: [{ manifestId: "daily-report", action: "error" }],
    });
  });

  it("reconciles a lost cron.remove response when the gateway confirms absence", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const ref = readClawCronRefs("worker", { env: current.env })[0]!;
    let present = true;
    let config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      cronGateway: {
        get: async () => (present ? cronReadView("worker", ref) : undefined),
        remove: async () => {
          present = false;
          throw new Error("response lost");
        },
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("preserves a live cron job that changed after planning", async () => {
    const current = await addFixture({ withCron: true });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    const remove = vi.fn();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config: current.getConfig(),
      cronGateway: {
        get: async () => ({
          ...cronReadView("worker", readClawCronRefs("worker", { env: current.env })[0]!),
          schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
        }),
        remove,
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: false,
      error: { code: "cron_cleanup_failed", message: expect.stringContaining("changed") },
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("finishes local cleanup without repeating a confirmed remote cron removal", async () => {
    const current = await addFixture({ withCron: true });
    markClawCronRefRemoved("worker", "daily-report", { env: current.env });
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();
    const remoteRemovals: string[] = [];

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      cronGateway: {
        remove: async (id) => {
          remoteRemovals.push(id);
          return { ok: true };
        },
      },
    });

    expect(remoteRemovals).toEqual([]);
    expect(result).toMatchObject({
      status: "complete",
      cronJobs: [{ manifestId: "daily-report", action: "removed" }],
    });
  });

  it("preserves modified files while releasing their provenance", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    await writeFile(target, "operator edit\n", "utf8");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "retain" }),
    );
    const trashPath = vi.fn().mockResolvedValue(true);
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspaceFile", action: "retain", blocked: false }),
    );
    let config = current.getConfig();
    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      trashPath,
    });
    expect(result.workspaceFiles).toEqual([{ path: "SOUL.md", action: "retainedModified" }]);
    await expect(readFile(target, "utf8")).resolves.toBe("operator edit\n");
    expect(trashPath).not.toHaveBeenCalledWith(current.plan.agent.workspace, expect.anything());
  });

  it("preserves a workspace containing operator-created files", async () => {
    const current = await addFixture({ withFile: true });
    const operatorFile = join(current.plan.agent.workspace, "operator-notes.md");
    await writeFile(operatorFile, "keep me\n", "utf8");
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.actions).toContainEqual(
      expect.objectContaining({ kind: "workspace", action: "retain" }),
    );
    const trashPath = vi.fn().mockResolvedValue(true);

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        commitConfig: async (transform) => {
          transform(config);
        },
        purgeSessions: async () => undefined,
        trashPath,
      }),
    ).resolves.toMatchObject({ status: "complete" });
    await expect(readFile(operatorFile, "utf8")).resolves.toBe("keep me\n");
    expect(trashPath).not.toHaveBeenCalledWith(current.plan.agent.workspace, expect.anything());
  });

  it("retains a replacement introduced after planning instead of deleting it", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
        await writeFile(target, "replacement\n", "utf8");
      },
    });

    expect(result).toMatchObject({
      status: "complete",
      workspaceFiles: [{ path: "SOUL.md", action: "retainedModified" }],
    });
    await expect(readFile(target, "utf8")).resolves.toBe("replacement\n");
  });
  it("keeps the install ledger when workspace cleanup becomes unsafe after config commit", async () => {
    const current = await addFixture({ withFile: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config: current.getConfig(),
    });
    let config = current.getConfig();

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
        await rm(target);
        await link(join(current.root, "SOUL.md"), target);
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: true,
      workspaceFiles: [{ path: "SOUL.md", action: "error" }],
      error: { code: "workspace_cleanup_failed" },
    });
    await expect(readClawStatus("worker", { env: current.env, config })).resolves.toMatchObject({
      summary: { claws: 1, missingAgents: 1 },
      records: [{ install: { status: "partial" }, workspaceFiles: [{ state: "unsafe" }] }],
    });
  });

  it("purges session indexes and keeps provenance when canonical trash cleanup fails", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    let nextConfig = config;
    let purgedAgentId: string | undefined;

    const result = await applyClawRemovePlan(plan, {
      consentPlanIntegrity: plan.planIntegrity,
      env: current.env,
      config,
      commitConfig: async (transform) => {
        nextConfig = transform(nextConfig);
      },
      purgeSessions: async (_cfg, agentId) => {
        purgedAgentId = agentId;
      },
      trashPath: async () => false,
    });

    expect(purgedAgentId).toBe("worker");
    expect(result).toMatchObject({
      status: "partial",
      agentRemoved: true,
      error: { code: "workspace_cleanup_failed" },
    });
    await expect(
      readClawStatus("worker", { env: current.env, config: nextConfig }),
    ).resolves.toMatchObject({ records: [{ install: { status: "partial" } }] });
  });

  it("releases global plugin references without uninstalling the plugin", async () => {
    const current = await addFixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "1.0.0",
        integrity: packageIntegrity,
      },
      {
        env: current.env,
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    );
    let config = current.getConfig();
    const resolvePlugin = vi.fn().mockResolvedValue({
      status: "found",
      pluginId: "audit",
      record: { source: "clawhub", integrity: packageIntegrity },
      installedVersion: "1.0.0",
    });
    const packageDeps = {
      resolvePlugin,
      acquirePackageLease: vi.fn(() => ({ heartbeat: vi.fn(), release: vi.fn() })),
    };
    const plan = await buildClawRemovePlan("worker", {
      env: current.env,
      config,
      packageDeps,
    });

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
        packageDeps,
        commitConfig: async (transform) => {
          config = transform(config);
        },
      }),
    ).resolves.toMatchObject({ status: "complete", agentRemoved: true });
  });

  it("blocks removal when the created agent config changed", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const agent = config.agents!.entries!.worker!;
    config.agents!.entries!.worker = { ...agent, name: "Operator edit" };
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "agent_modified" }));
    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: plan.planIntegrity,
      }),
    ).rejects.toMatchObject({
      code: "remove_blocked",
    });
  });

  it("rejects removal consent for a different plan identity", async () => {
    const current = await addFixture();
    const config = current.getConfig();
    const plan = await buildClawRemovePlan("worker", { env: current.env, config });

    await expect(
      applyClawRemovePlan(plan, {
        env: current.env,
        config,
        consentPlanIntegrity: "sha256:stale",
      }),
    ).rejects.toMatchObject({ code: "plan_integrity_mismatch" });
  });

  it("requires an agent id when a package identity has multiple installs", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/shared" });
    const second = await fixture({ id: "worker-b", name: "@acme/shared" });
    persistClawInstallRecord(first.plan, { env: first.env });
    persistClawInstallRecord(second.plan, { env: first.env });
    const plan = await buildClawRemovePlan("@acme/shared", { env: first.env, config: {} });
    expect(plan.blockers).toContainEqual(expect.objectContaining({ code: "claw_ambiguous" }));
  });

  it("keeps Claw-introduced plugin origin on every surviving Claw reference", async () => {
    const first = await fixture({ id: "worker-a", name: "@acme/first" });
    const second = await fixture({ id: "worker-b", name: "@acme/second" });
    persistClawInstallRecord(first.plan, { env: first.env, nowMs: 1 });
    persistClawInstallRecord(second.plan, { env: first.env, nowMs: 2 });
    const plugin = {
      kind: "plugin",
      source: "clawhub",
      ref: "audit",
      version: "1.0.0",
      integrity: packageIntegrity,
    } as const;
    persistClawPackageRef(first.plan, plugin, {
      env: first.env,
      nowMs: 1,
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    });
    persistClawPackageRef(second.plan, plugin, {
      env: first.env,
      nowMs: 2,
      relationship: "referenced",
      origin: "claw-introduced",
      independentOwner: false,
    });
    const { id: firstId, ...firstConfig } = first.plan.agent.config;
    const { id: secondId, ...secondConfig } = second.plan.agent.config;
    let config: OpenClawConfig = {
      agents: { entries: { [firstId]: firstConfig, [secondId]: secondConfig } },
    };
    const remove = await buildClawRemovePlan("worker-a", { env: first.env, config });
    await applyClawRemovePlan(remove, {
      consentPlanIntegrity: remove.planIntegrity,
      env: first.env,
      config,
      commitConfig: async (transform) => {
        config = transform(config);
      },
    });

    expect(readClawPackageRefs({ env: first.env, agentId: "worker-b" })).toMatchObject([
      {
        ref: "audit",
        relationship: "referenced",
        origin: "claw-introduced",
        independentOwner: false,
      },
    ]);
  });
});
