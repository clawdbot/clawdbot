import { access, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { McpServerConfig } from "../config/types.mcp.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { applyClawAddPlan } from "./add.js";
import { installClawCronJobs } from "./cron.js";
import { collectClawStateHealthFindings } from "./doctor.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { installClawMcpServers } from "./mcp.js";
import { persistClawPackageRef } from "./provenance.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function snapshotMcpServers(config: OpenClawConfig): Record<string, Record<string, unknown>> {
  return structuredClone(config.mcp?.servers ?? {}) as Record<string, Record<string, unknown>>;
}

async function fixture(
  params: { withFile?: boolean; withMcp?: boolean; withCron?: boolean; cron?: string } = {},
) {
  const root = tempDirs.make("openclaw-claw-doctor-");
  if (params.withFile) {
    await writeFile(join(root, "SOUL.md"), "managed\n", "utf8");
  }
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker", name: "Worker" },
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
            schedule: { cron: params.cron ?? "0 9 * * *", timezone: "UTC" },
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
    name: "@acme/worker",
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
    context: { workspace: join(root, "workspace-worker") },
  });
  const env = {
    OPENCLAW_STATE_DIR: join(root, "state"),
    OPENCLAW_EXPERIMENTAL_CLAWS: "1",
  };
  return { root, plan, env };
}

async function installFixture(
  params: { withFile?: boolean; withMcp?: boolean; withCron?: boolean; cron?: string } = {},
) {
  const current = await fixture(params);
  let config: OpenClawConfig = {};
  await applyClawAddPlan(current.plan, {
    consentPlanIntegrity: current.plan.planIntegrity,
    env: current.env,
    commitConfig: async (transform) => {
      config = transform(config);
    },
    installMcpServers: async (plan, options) =>
      await installClawMcpServers(plan, {
        ...options,
        setMcpServer: async ({ name, server }) => {
          const servers = { ...config.mcp?.servers, [name]: server as McpServerConfig };
          config.mcp = { ...config.mcp, servers };
          return { ok: true, path: "config", config, mcpServers: servers };
        },
      }),
    cronGateway: { add: async () => ({ id: "scheduler-daily" }) },
  });
  return { ...current, getConfig: () => config };
}

describe("collectClawStateHealthFindings", () => {
  it("does not create state when the database is absent", async () => {
    const current = await fixture();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);

    await expect(collectClawStateHealthFindings({ env: current.env, cfg: {} })).resolves.toEqual(
      [],
    );
    await expect(access(databasePath)).rejects.toThrow();
  });

  it("treats a pre-Claws state database as empty without modifying it", async () => {
    const current = await fixture();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE unrelated_state (id TEXT PRIMARY KEY); PRAGMA wal_checkpoint(TRUNCATE)",
    );
    database.close();
    await rm(`${databasePath}-wal`, { force: true });
    await rm(`${databasePath}-shm`, { force: true });
    const before = await readFile(databasePath);
    const beforeEntries = await readdir(dirname(databasePath));

    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: {},
        sourceMcpServers: {},
      }),
    ).resolves.toEqual([]);
    await expect(readFile(databasePath)).resolves.toEqual(before);
    await expect(readdir(dirname(databasePath))).resolves.toEqual(beforeEntries);
  });

  it.each(["claw_workspace_files", "claw_package_refs", "claw_mcp_server_refs", "claw_cron_refs"])(
    "reports orphaned ownership in %s without a root install table",
    async (table) => {
      const current = await fixture();
      const databasePath = resolveOpenClawStateSqlitePath(current.env);
      await mkdir(dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      database.exec(`
      CREATE TABLE ${table} (agent_id TEXT NOT NULL);
      INSERT INTO ${table} (agent_id) VALUES ('orphaned-agent');
    `);
      database.close();
      const before = await readFile(databasePath);

      await expect(
        collectClawStateHealthFindings({
          env: current.env,
          cfg: {},
          sourceMcpServers: {},
        }),
      ).resolves.toEqual([
        expect.objectContaining({
          severity: "warning",
          message:
            'Claw ownership references for agent "orphaned-agent" have no root install record.',
          path: "claws.orphaned-agent",
        }),
      ]);
      await expect(readFile(databasePath)).resolves.toEqual(before);
    },
  );

  it("reports an unreadable state database as a structured finding", async () => {
    const current = await fixture();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    await mkdir(dirname(databasePath), { recursive: true });
    await writeFile(databasePath, "not sqlite", "utf8");

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: {},
      sourceMcpServers: {},
    });
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("Could not inspect Claw lifecycle state"),
      }),
    ]);
  });

  it("reports a newer state schema instead of interpreting it", async () => {
    const current = await fixture();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    const newerSchemaVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1;
    database.exec(`PRAGMA user_version = ${newerSchemaVersion}`);
    database.close();

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: {},
      sourceMcpServers: {},
    });
    expect(findings).toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining(`uses newer schema version ${newerSchemaVersion}`),
      }),
    ]);
    const reopened = new DatabaseSync(databasePath, { readOnly: true });
    expect(reopened.isOpen).toBe(true);
    reopened.close();
  });

  it("does not change existing database bytes, metadata, schema, or journal mode", async () => {
    const current = await installFixture({ withMcp: true, withCron: true });
    closeOpenClawStateDatabaseForTest();
    const databasePath = resolveOpenClawStateSqlitePath(current.env);
    const beforeBytes = await readFile(databasePath);
    const beforeStat = await stat(databasePath);
    const beforeDb = new DatabaseSync(databasePath, { readOnly: true });
    const beforeSchema = beforeDb
      .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
      .all();
    const beforeVersion = beforeDb.prepare("PRAGMA user_version").get();
    const beforeJournal = beforeDb.prepare("PRAGMA journal_mode").get();
    beforeDb.close();

    await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
    });

    const afterStat = await stat(databasePath);
    const afterDb = new DatabaseSync(databasePath, { readOnly: true });
    expect(await readFile(databasePath)).toEqual(beforeBytes);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(afterStat.mode).toBe(beforeStat.mode);
    expect(
      afterDb.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
    ).toEqual(beforeSchema);
    expect(afterDb.prepare("PRAGMA user_version").get()).toEqual(beforeVersion);
    expect(afterDb.prepare("PRAGMA journal_mode").get()).toEqual(beforeJournal);
    afterDb.close();
  });

  it("stays hidden when the experimental Claws surface is disabled", async () => {
    const current = await fixture();
    await expect(
      collectClawStateHealthFindings({
        env: { ...current.env, OPENCLAW_EXPERIMENTAL_CLAWS: "" },
        cfg: {},
      }),
    ).resolves.toEqual([]);
  });

  it("reports no findings for a complete unchanged install", async () => {
    const current = await installFixture({ withFile: true, withMcp: true, withCron: true });
    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: current.getConfig(),
        sourceMcpServers: snapshotMcpServers(current.getConfig()),
        cronGateway: {
          list: async () => [
            {
              id: "scheduler-daily",
              agentId: "worker",
              owner: { agentId: "worker" },
              declarationKey: "claw:worker:daily-report",
              name: "daily-report",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Prepare report" },
              delivery: { mode: "none" },
              state: {},
            },
          ],
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not load MCP config when no Claw owns an MCP server", async () => {
    const current = await installFixture({ withFile: true });
    await writeFile(join(current.plan.agent.workspace, "SOUL.md"), "local edit\n", "utf8");
    const listMcpServers = vi.fn(async () => {
      throw new Error("MCP config unavailable");
    });

    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: current.getConfig(),
        listMcpServers,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        message: expect.stringContaining("workspace file changed"),
        path: "claws.worker.workspace.SOUL.md",
      }),
    ]);
    expect(listMcpServers).not.toHaveBeenCalled();
  });

  it("reports MCP config failure when a Claw owns an MCP server", async () => {
    const current = await installFixture({ withMcp: true });
    const listMcpServers = vi.fn(async () => ({
      ok: false as const,
      path: "/tmp/openclaw.json",
      error: "MCP config unavailable",
    }));

    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: current.getConfig(),
        listMcpServers,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("MCP config unavailable"),
      }),
    ]);
    expect(listMcpServers).toHaveBeenCalledOnce();
  });

  it("uses source MCP placeholders instead of resolved secret values", async () => {
    const current = await installFixture({ withMcp: true });
    const sourceMcpServers = structuredClone(current.getConfig().mcp?.servers ?? {});
    current.getConfig().mcp!.servers!.docs!.env = { DOCS_TOKEN: "resolved-secret" };

    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: current.getConfig(),
        sourceMcpServers,
      }),
    ).resolves.toEqual([]);
  });

  it("reports incomplete package lifecycle state", async () => {
    const current = await installFixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "plugin",
        source: "clawhub",
        ref: "audit",
        version: "2.0.0",
        integrity: "sha256:audit",
      },
      { env: current.env, status: "pending" },
    );

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("incomplete lifecycle state"),
        path: "claws.worker.packages.plugin.audit",
      }),
    );
  });

  it("projects agent and workspace drift from lifecycle status", async () => {
    const current = await installFixture({ withFile: true });
    current.getConfig().agents!.entries![current.plan.agent.finalId] = {
      ...current.getConfig().agents!.entries![current.plan.agent.finalId],
      name: "Operator edit",
    };
    await writeFile(join(current.plan.agent.workspace, "SOUL.md"), "local edit\n", "utf8");

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("changed after installation"),
          path: "agents.list.worker",
        }),
        expect.objectContaining({
          message: expect.stringContaining("workspace file changed"),
          path: "claws.worker.workspace.SOUL.md",
        }),
      ]),
    );
  });

  it("reports unsafe workspace targets and MCP config drift", async () => {
    const current = await installFixture({ withFile: true, withMcp: true });
    const target = join(current.plan.agent.workspace, "SOUL.md");
    await rm(target);
    await symlink(join(current.root, "SOUL.md"), target);
    current.getConfig().mcp!.servers!.docs = { command: "node", args: ["other.mjs"] };

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: expect.stringContaining("unsafe to inspect") }),
        expect.objectContaining({
          message: expect.stringContaining("modified ownership state"),
          path: "mcp.servers.docs",
        }),
      ]),
    );
  });

  it("reports partial installs and unresolved cron ownership", async () => {
    const current = await fixture({ withCron: true });
    let config: OpenClawConfig = {};
    await applyClawAddPlan(current.plan, {
      consentPlanIntegrity: current.plan.planIntegrity,
      env: current.env,
      commitConfig: async (transform) => {
        config = transform(config);
      },
      installCronJobs: async (plan, options) =>
        await installClawCronJobs(plan, {
          ...options,
          gateway: {
            add: async () => {
              throw new Error("gateway unavailable");
            },
          },
        }),
    });

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: config,
      sourceMcpServers: snapshotMcpServers(config),
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("incomplete install record (config_committed)"),
        }),
        expect.objectContaining({
          message: expect.stringContaining("pending ownership state"),
          path: "claws.worker.cronJobs.daily-report",
        }),
      ]),
    );
  });

  it("reports complete cron ownership as unknown without live Gateway inventory", async () => {
    const current = await installFixture({ withCron: true });

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("live Gateway state is unknown"),
        path: "claws.worker.cronJobs.daily-report",
      }),
    );
  });

  it("accepts complete cron ownership only when live Gateway inventory matches", async () => {
    const current = await installFixture({ withCron: true });

    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: current.getConfig(),
        sourceMcpServers: snapshotMcpServers(current.getConfig()),
        cronGateway: {
          list: async () => [
            {
              id: "scheduler-daily",
              agentId: "worker",
              owner: { agentId: "worker" },
              declarationKey: "claw:worker:daily-report",
              name: "daily-report",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Prepare report" },
              delivery: { mode: "none" },
              state: {},
            },
          ],
        },
      }),
    ).resolves.toEqual([]);
  });

  it("accepts Gateway default staggering for recurring top-of-hour schedules", async () => {
    const current = await installFixture({ withCron: true, cron: "0 * * * *" });

    await expect(
      collectClawStateHealthFindings({
        env: current.env,
        cfg: current.getConfig(),
        sourceMcpServers: snapshotMcpServers(current.getConfig()),
        cronGateway: {
          list: async () => [
            {
              id: "scheduler-daily",
              agentId: "worker",
              owner: { agentId: "worker" },
              declarationKey: "claw:worker:daily-report",
              name: "daily-report",
              enabled: true,
              createdAtMs: 1,
              updatedAtMs: 1,
              schedule: {
                kind: "cron",
                expr: "0 * * * *",
                tz: "UTC",
                staggerMs: 300_000,
              },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Prepare report" },
              delivery: { mode: "none" },
              state: {},
            },
          ],
        },
      }),
    ).resolves.toEqual([]);
  });

  it("reports disabled or missing live Gateway cron jobs", async () => {
    const current = await installFixture({ withCron: true });

    const disabled = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
      cronGateway: {
        list: async () => [
          {
            id: "scheduler-daily",
            agentId: "worker",
            owner: { agentId: "worker" },
            declarationKey: "claw:worker:daily-report",
            name: "daily-report",
            enabled: false,
            createdAtMs: 1,
            updatedAtMs: 1,
            schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
            sessionTarget: "isolated",
            wakeMode: "now",
            payload: { kind: "agentTurn", message: "Prepare report" },
            delivery: { mode: "none" },
            state: {},
          },
        ],
      },
    });
    expect(disabled).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("differs from live Gateway job"),
        path: "claws.worker.cronJobs.daily-report",
      }),
    );

    const missing = await collectClawStateHealthFindings({
      env: current.env,
      cfg: current.getConfig(),
      sourceMcpServers: snapshotMcpServers(current.getConfig()),
      cronGateway: { list: async () => [] },
    });
    expect(missing).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("missing from live Gateway inventory"),
        path: "claws.worker.cronJobs.daily-report",
      }),
    );
  });

  it("reports ownership references without a root install", async () => {
    const current = await fixture();
    persistClawPackageRef(
      current.plan,
      {
        kind: "skill",
        source: "clawhub",
        ref: "triage",
        version: "1.0.0",
        integrity: "sha256:triage",
      },
      { env: current.env },
    );

    const findings = await collectClawStateHealthFindings({
      env: current.env,
      cfg: {},
      sourceMcpServers: {},
    });
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("have no root install record"),
          path: "claws.worker",
        }),
      ]),
    );
  });
});
