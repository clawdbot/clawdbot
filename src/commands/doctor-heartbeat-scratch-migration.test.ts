import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { heartbeatMonitorAgentId } from "../cron/heartbeat-monitor.js";
import { readCronJobScratchState, writeCronJobScratch } from "../cron/scratch-store.js";
import {
  loadCronJobsStore,
  resolveCronJobsStorePath,
  resolveCronJobsStorePathFromConfig,
} from "../cron/store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  collectHeartbeatScratchMigrationFindings,
  maybeMigrateHeartbeatFilesToScratch,
} from "./doctor-heartbeat-scratch-migration.js";

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalStateDir: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-migration-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const cfg = {
    agents: {
      defaults: { heartbeat: { every: "30m" } },
      list: [{ id: "main", workspace }],
    },
  } as OpenClawConfig;
  return { root, stateDir, workspace, cfg, heartbeatPath: path.join(workspace, "HEARTBEAT.md") };
}

async function loadMonitor(cfg?: OpenClawConfig) {
  const storePath = cfg ? resolveCronJobsStorePathFromConfig(cfg) : resolveCronJobsStorePath();
  const store = await loadCronJobsStore(storePath);
  const monitor = store.jobs.find((job) => heartbeatMonitorAgentId(job) === "main");
  if (!monitor) {
    throw new Error("expected migrated heartbeat monitor");
  }
  return { monitor, storePath };
}

describe("HEARTBEAT.md cron scratch migration", () => {
  it("previews without mutation, then migrates, archives, and reruns idempotently", async () => {
    const fixture = await createFixture();
    const content = `# Operations\n\ntasks:\n  - name: inbox\n    interval: 1h\n    prompt: Check inbox\n`;
    await fs.writeFile(fixture.heartbeatPath, content, "utf8");

    const findings = await collectHeartbeatScratchMigrationFindings(fixture.cfg);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-scratch-migration",
        requirement: "legacy-heartbeat-file",
        target: "main",
      }),
    ]);
    await maybeMigrateHeartbeatFilesToScratch({ cfg: fixture.cfg, shouldRepair: false });
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(content);

    const migrated = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(migrated.warnings).toEqual([]);
    expect(migrated.changes).toHaveLength(1);
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });

    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch).toEqual(
      expect.objectContaining({ content, revision: 1, sourceSha256: expect.any(String) }),
    );
    const archiveDir = path.join(fixture.stateDir, "backups", "heartbeat-migration");
    const archives = await fs.readdir(archiveDir);
    expect(archives).toHaveLength(1);
    await expect(fs.readFile(path.join(archiveDir, archives[0]!), "utf8")).resolves.toBe(content);

    const rerun = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(rerun).toEqual({ changes: [], warnings: [] });
  });

  it("leaves a legacy file when operator scratch has different content", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.heartbeatPath, "legacy file\n", "utf8");
    await maybeMigrateHeartbeatFilesToScratch({ cfg: fixture.cfg, shouldRepair: false });
    const prepared = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(prepared.warnings).toEqual([]);

    // Recreate a retired source after an operator edit: doctor must not overwrite it.
    const { monitor, storePath } = await loadMonitor();
    const current = readCronJobScratchState(storePath, monitor.id);
    writeCronJobScratch({
      storePath,
      jobId: monitor.id,
      content: "operator scratch\n",
      expectedRevision: current.currentRevision,
    });
    await fs.writeFile(fixture.heartbeatPath, "recreated legacy file\n", "utf8");

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("already has different cron scratch");
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(
      "recreated legacy file\n",
    );
    expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(
      "operator scratch\n",
    );
  });

  it("imports a shared workspace file into every agent monitor before removing it", async () => {
    const fixture = await createFixture();
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
        list: [
          { id: "main", workspace: fixture.workspace },
          { id: "ops", workspace: fixture.workspace },
        ],
      },
    } as OpenClawConfig;
    await fs.writeFile(fixture.heartbeatPath, "shared checklist\n", "utf8");

    const result = await maybeMigrateHeartbeatFilesToScratch({ cfg, shouldRepair: true });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(2);
    await expect(fs.access(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    const storePath = resolveCronJobsStorePath();
    const store = await loadCronJobsStore(storePath);
    for (const agentId of ["main", "ops"]) {
      const monitor = store.jobs.find((job) => heartbeatMonitorAgentId(job) === agentId);
      expect(monitor, agentId).toBeDefined();
      expect(readCronJobScratchState(storePath, monitor!.id).scratch?.content, agentId).toBe(
        "shared checklist\n",
      );
    }
  });

  it("respects a configured cron store partition", async () => {
    const fixture = await createFixture();
    const customStore = path.join(fixture.root, "custom-cron", "jobs.json");
    const cfg = { ...fixture.cfg, cron: { store: customStore } } as unknown as OpenClawConfig;
    await fs.writeFile(fixture.heartbeatPath, "custom store scratch\n", "utf8");

    const result = await maybeMigrateHeartbeatFilesToScratch({ cfg, shouldRepair: true });

    expect(result.warnings).toEqual([]);
    const { monitor, storePath } = await loadMonitor(cfg);
    expect(storePath).toBe(path.resolve(customStore));
    expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(
      "custom store scratch\n",
    );
    expect((await loadCronJobsStore(resolveCronJobsStorePath())).jobs).toEqual([]);
  });

  it("does not resurrect a legacy file after scratch was explicitly unset", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.heartbeatPath, "initial\n", "utf8");
    await maybeMigrateHeartbeatFilesToScratch({ cfg: fixture.cfg, shouldRepair: true });
    const { monitor, storePath } = await loadMonitor();
    const state = readCronJobScratchState(storePath, monitor.id);
    const unset = writeCronJobScratch({
      storePath,
      jobId: monitor.id,
      content: null,
      expectedRevision: state.currentRevision,
    });
    expect(unset.ok).toBe(true);
    await fs.writeFile(fixture.heartbeatPath, "recreated\n", "utf8");

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("scratch was explicitly unset");
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe("recreated\n");
    expect(readCronJobScratchState(storePath, monitor.id).scratch).toBeUndefined();
  });

  it("preserves a concurrent file replacement acquired by the atomic claim", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.heartbeatPath, "planned content\n", "utf8");
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await fs.writeFile(String(from), "concurrent replacement\n", "utf8");
      await rename(from, to);
    });

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings.join("\n")).toContain("changed before the migration claim");
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe(
      "concurrent replacement\n",
    );
    // Nothing may be committed for a failed claim: scratch would otherwise
    // shadow the restored replacement file on the next heartbeat.
    expect(result.changes).toEqual([]);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id)).toEqual({ currentRevision: 0 });
  });

  it("never clobbers a recreated file when restoring a failed claim", async () => {
    const fixture = await createFixture();
    await fs.writeFile(fixture.heartbeatPath, "claimed original\n", "utf8");
    const realpath = fs.realpath.bind(fs);
    // Fail the claim after the rename, and recreate the destination before the
    // restore runs — the classic editor atomic-save race.
    vi.spyOn(fs, "realpath").mockImplementation(async (target) => {
      if (String(target).includes(".doctor-importing-")) {
        await fs.writeFile(fixture.heartbeatPath, "editor rewrite\n", "utf8");
        throw new Error("simulated claim verification failure");
      }
      return await realpath(target);
    });

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.changes).toEqual([]);
    await expect(fs.readFile(fixture.heartbeatPath, "utf8")).resolves.toBe("editor rewrite\n");
    const workspaceEntries = await fs.readdir(fixture.workspace);
    const conflict = workspaceEntries.find((entry) => entry.includes(".conflict-"));
    expect(conflict, workspaceEntries.join(",")).toBeDefined();
    await expect(fs.readFile(path.join(fixture.workspace, conflict!), "utf8")).resolves.toBe(
      "claimed original\n",
    );
  });

  it("recovers an interrupted migration claim on the next doctor --fix", async () => {
    const fixture = await createFixture();
    const content = "interrupted checklist\n";
    // Simulate a crash after the claim rename: only the claim file exists.
    // Use a provably dead PID so recovery does not treat it as an active run.
    const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
    await fs.writeFile(
      `${fixture.heartbeatPath}.doctor-importing-${deadPid}-deadbeefdead`,
      content,
      "utf8",
    );

    const findings = await collectHeartbeatScratchMigrationFindings(fixture.cfg);
    expect(findings).toEqual([
      expect.objectContaining({ requirement: "heartbeat-file-migration-blocked" }),
    ]);
    expect(findings[0]!.message).toContain("interrupted migration claim");

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(content);
    const workspaceEntries = await fs.readdir(fixture.workspace);
    expect(workspaceEntries.filter((entry) => entry.includes(".doctor-importing-"))).toEqual([]);
  });

  it("refuses to steal a claim held by a live doctor process", async () => {
    const fixture = await createFixture();
    // This test's own PID is trivially alive and not ours-by-name.
    const claimPath = `${fixture.heartbeatPath}.doctor-importing-1-abcdefabcdef`;
    await fs.writeFile(claimPath, "in-flight migration\n", "utf8");

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("held by running process 1");
    await expect(fs.readFile(claimPath, "utf8")).resolves.toBe("in-flight migration\n");
  });

  it("migrates a contained symlinked HEARTBEAT.md and removes the link", async () => {
    const fixture = await createFixture();
    const targetPath = path.join(fixture.workspace, "real-heartbeat.md");
    await fs.writeFile(targetPath, "linked checklist\n", "utf8");
    await fs.symlink("real-heartbeat.md", fixture.heartbeatPath);

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    const { monitor, storePath } = await loadMonitor();
    expect(readCronJobScratchState(storePath, monitor.id).scratch?.content).toBe(
      "linked checklist\n",
    );
    // The symlink is removed; the contained target file itself is untouched.
    await expect(fs.lstat(fixture.heartbeatPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(targetPath, "utf8")).resolves.toBe("linked checklist\n");
  });

  it("rejects external symlink targets without importing or removing them", async () => {
    const fixture = await createFixture();
    const external = path.join(fixture.root, "outside.md");
    await fs.writeFile(external, "outside\n", "utf8");
    await fs.symlink(external, fixture.heartbeatPath);

    const result = await maybeMigrateHeartbeatFilesToScratch({
      cfg: fixture.cfg,
      shouldRepair: true,
    });
    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("escapes the agent workspace");
    await expect(fs.lstat(fixture.heartbeatPath)).resolves.toMatchObject({});
  });
});
