import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { heartbeatMonitorAgentId } from "../cron/heartbeat-monitor.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resolveHeartbeatPhaseMs } from "../infra/heartbeat-schedule.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  collectHeartbeatCadenceMigrationFindings,
  maybeMigrateHeartbeatCadenceToCron,
} from "./doctor-heartbeat-cadence-migration.js";

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

async function createFixture(every = "15m") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-cadence-"));
  tempDirs.push(root);
  process.env.HOME = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = root;
  const env = process.env;
  const cfg = {
    agents: {
      defaults: { heartbeat: { every } },
      list: [{ id: "main" }],
    },
  } as OpenClawConfig;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  return { cfg, env, storePath };
}

async function loadMonitor(storePath: string, agentId: string) {
  const store = await loadCronJobsStore(storePath);
  return store.jobs.find((job) => heartbeatMonitorAgentId(job) === agentId);
}

async function loadMainMonitor(storePath: string) {
  return loadMonitor(storePath, "main");
}

describe("heartbeat cadence cron migration", () => {
  it("previews without mutation, applies, updates, and reruns idempotently", async () => {
    const fixture = await createFixture();

    const findings = await collectHeartbeatCadenceMigrationFindings(fixture.cfg, fixture.env);
    expect(findings).toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-cadence-migration",
        requirement: "heartbeat-monitor-create",
        target: "main",
      }),
    ]);

    const preview = await maybeMigrateHeartbeatCadenceToCron({
      cfg: fixture.cfg,
      shouldRepair: false,
      env: fixture.env,
    });
    expect(preview).toEqual({ changes: [], warnings: [] });
    await expect(fs.access(resolveOpenClawStateSqlitePath(fixture.env))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await loadMainMonitor(fixture.storePath)).toBeUndefined();

    const migrated = await maybeMigrateHeartbeatCadenceToCron({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(migrated.warnings).toEqual([]);
    expect(migrated.changes).toEqual(['Create heartbeat monitor for agent "main" at 15m.']);
    const created = await loadMainMonitor(fixture.storePath);
    expect(created).toEqual(
      expect.objectContaining({
        declarationKey: "heartbeat:main",
        enabled: true,
        schedule: expect.objectContaining({ kind: "every", everyMs: 15 * 60_000 }),
        payload: { kind: "heartbeat" },
      }),
    );

    const updatedCfg = {
      ...fixture.cfg,
      agents: { ...fixture.cfg.agents, defaults: { heartbeat: { every: "45m" } } },
    } as OpenClawConfig;
    const updated = await maybeMigrateHeartbeatCadenceToCron({
      cfg: updatedCfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(updated.changes).toEqual(['Update heartbeat monitor for agent "main" at 45m.']);
    const changed = await loadMainMonitor(fixture.storePath);
    expect(changed?.id).toBe(created?.id);
    expect(changed?.schedule).toEqual(
      expect.objectContaining({ kind: "every", everyMs: 45 * 60_000 }),
    );

    const rerun = await maybeMigrateHeartbeatCadenceToCron({
      cfg: updatedCfg,
      shouldRepair: true,
      env: fixture.env,
    });
    expect(rerun).toEqual({ changes: [], warnings: [] });
    await expect(
      collectHeartbeatCadenceMigrationFindings(updatedCfg, fixture.env),
    ).resolves.toEqual([]);
  });

  it("preserves a disabled heartbeat as a disabled monitor row", async () => {
    const fixture = await createFixture("0m");

    const result = await maybeMigrateHeartbeatCadenceToCron({
      cfg: fixture.cfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result.warnings).toEqual([]);
    expect(await loadMainMonitor(fixture.storePath)).toEqual(
      expect.objectContaining({ enabled: false, payload: { kind: "heartbeat" } }),
    );
  });

  it("keeps multi-agent updates and creates scoped to their declared monitors", async () => {
    const fixture = await createFixture();
    const initialCfg = {
      agents: {
        list: [
          { id: "alpha", heartbeat: { every: "15m" } },
          { id: "beta", heartbeat: { every: "20m" } },
        ],
      },
    } as OpenClawConfig;
    await maybeMigrateHeartbeatCadenceToCron({
      cfg: initialCfg,
      shouldRepair: true,
      env: fixture.env,
    });
    const alphaBefore = await loadMonitor(fixture.storePath, "alpha");
    const betaBefore = await loadMonitor(fixture.storePath, "beta");

    const updatedCfg = {
      agents: {
        list: [
          { id: "alpha", heartbeat: { every: "45m" } },
          { id: "gamma", heartbeat: { every: "30m" } },
        ],
      },
    } as OpenClawConfig;
    const result = await maybeMigrateHeartbeatCadenceToCron({
      cfg: updatedCfg,
      shouldRepair: true,
      env: fixture.env,
    });

    expect(result).toEqual({
      changes: [
        'Update heartbeat monitor for agent "alpha" at 45m.',
        'Create heartbeat monitor for agent "gamma" at 30m.',
        'Remove stale heartbeat monitor for agent "beta".',
      ],
      warnings: [],
    });
    const alphaAfter = await loadMonitor(fixture.storePath, "alpha");
    const gammaAfter = await loadMonitor(fixture.storePath, "gamma");
    expect(alphaAfter).toEqual(
      expect.objectContaining({
        id: alphaBefore?.id,
        declarationKey: "heartbeat:alpha",
        agentId: "alpha",
        schedule: expect.objectContaining({ kind: "every", everyMs: 45 * 60_000 }),
      }),
    );
    expect(gammaAfter).toEqual(
      expect.objectContaining({
        declarationKey: "heartbeat:gamma",
        agentId: "gamma",
        schedule: expect.objectContaining({ kind: "every", everyMs: 30 * 60_000 }),
      }),
    );
    expect(gammaAfter?.id).not.toBe(betaBefore?.id);
    expect(await loadMonitor(fixture.storePath, "beta")).toBeUndefined();
  });

  it("uses the supplied environment for the writable scheduler seed", async () => {
    const ambientRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-heartbeat-cadence-ambient-"),
    );
    const suppliedRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-heartbeat-cadence-supplied-"),
    );
    tempDirs.push(ambientRoot, suppliedRoot);
    process.env.HOME = path.join(ambientRoot, "home");
    process.env.OPENCLAW_STATE_DIR = ambientRoot;
    const ambientEnv = { ...process.env };
    const suppliedEnv = {
      ...process.env,
      HOME: path.join(suppliedRoot, "home"),
      OPENCLAW_STATE_DIR: suppliedRoot,
    };
    const ambientIdentity = loadOrCreateDeviceIdentity({ env: ambientEnv });
    const suppliedIdentity = loadOrCreateDeviceIdentity({ env: suppliedEnv });
    const intervalMs = 15 * 60_000;
    const agentId = ["main", "ops", "alpha", "beta"].find(
      (candidate) =>
        resolveHeartbeatPhaseMs({
          schedulerSeed: ambientIdentity.deviceId,
          agentId: candidate,
          intervalMs,
        }) !==
        resolveHeartbeatPhaseMs({
          schedulerSeed: suppliedIdentity.deviceId,
          agentId: candidate,
          intervalMs,
        }),
    );
    if (!agentId) {
      throw new Error("expected ambient and supplied identities to produce a distinct phase");
    }
    const cfg = {
      agents: {
        defaults: { heartbeat: { every: "15m" } },
        list: [{ id: agentId }],
      },
    } as OpenClawConfig;
    const storePath = resolveCronJobsStorePathFromConfig(cfg, suppliedEnv);

    const result = await maybeMigrateHeartbeatCadenceToCron({
      cfg,
      shouldRepair: true,
      env: suppliedEnv,
    });

    expect(result.warnings).toEqual([]);
    const monitor = await loadMonitor(storePath, agentId);
    expect(monitor?.schedule).toEqual(
      expect.objectContaining({
        kind: "every",
        everyMs: intervalMs,
        anchorMs: resolveHeartbeatPhaseMs({
          schedulerSeed: suppliedIdentity.deviceId,
          agentId,
          intervalMs,
        }),
      }),
    );
  });
});
