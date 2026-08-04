import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorSpecs } from "../cron/heartbeat-monitor.js";
import { heartbeatTaskDeclarationKey, isHeartbeatTaskCronJob } from "../cron/heartbeat-task.js";
import { readCronJobScratchState, writeCronJobScratch } from "../cron/scratch-store.js";
import { CronService } from "../cron/service.js";
import { loadCronJobsStore, resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { resolveHeartbeatSession } from "../infra/heartbeat-runner.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  collectHeartbeatTaskMigrationFindings,
  maybeMigrateHeartbeatTasksToCron,
} from "./doctor-heartbeat-task-migration.js";

const tempDirs: string[] = [];
let originalHome: string | undefined;
let originalStateDir: string | undefined;

function createTestCronService(storePath: string, cfg: OpenClawConfig, nowMs: number): CronService {
  const noop = () => {};
  const log = { debug: noop, info: noop, warn: noop, error: noop };
  return new CronService({
    storePath,
    nowMs: () => nowMs,
    cronEnabled: false,
    cronConfig: cfg.cron,
    defaultAgentId: resolveDefaultAgentId(cfg),
    log,
    enqueueSystemEvent: () => false,
    requestHeartbeat: noop,
    runIsolatedAgentJob: async () => ({
      status: "skipped",
      error: "tests do not execute cron jobs",
    }),
  });
}

beforeEach(() => {
  originalHome = process.env.HOME;
  originalStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(async () => {
  vi.restoreAllMocks();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
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

async function createFixture(
  nowMs: number,
  scratchContent = `# Operations

tasks:
  - name: inbox
    interval: 1h
    prompt: Check urgent inbox items
  - name: calendar
    interval: 2h
    prompt: Check the next meetings

# Keep alerts concise
`,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-heartbeat-task-migration-"));
  tempDirs.push(root);
  const env = { ...process.env, HOME: path.join(root, "home"), OPENCLAW_STATE_DIR: root };
  process.env.HOME = env.HOME;
  process.env.OPENCLAW_STATE_DIR = env.OPENCLAW_STATE_DIR;
  const cfg = {
    agents: { defaults: { heartbeat: { every: "30m" } }, list: [{ id: "main" }] },
  } as OpenClawConfig;
  const storePath = resolveCronJobsStorePathFromConfig(cfg, env);
  const cron = createTestCronService(storePath, cfg, nowMs);
  const spec = resolveHeartbeatMonitorSpecs(cfg, [])[0];
  if (!spec) {
    throw new Error("expected heartbeat monitor spec");
  }
  const added = await cron.add(spec.input, { enabledExplicit: true, systemOwned: true });
  const monitor = "job" in added ? added.job : added;
  writeCronJobScratch({
    storePath,
    jobId: monitor.id,
    content: scratchContent,
    expectedRevision: 0,
    options: { env },
  });
  const session = resolveHeartbeatSession(
    cfg,
    "main",
    cfg.agents?.defaults?.heartbeat,
    undefined,
    env,
  );
  await replaceSessionEntry(
    { storePath: session.storePath, sessionKey: session.sessionKey, env },
    {
      sessionId: "heartbeat-main",
      updatedAt: nowMs,
      heartbeatTaskState: { inbox: nowMs - 30 * 60_000 },
    },
  );
  return { cfg, env, monitor, nowMs, session, storePath };
}

async function createExistingInboxJob(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const cron = createTestCronService(fixture.storePath, fixture.cfg, fixture.nowMs - 60_000);
  const result = await cron.add(
    {
      declarationKey: heartbeatTaskDeclarationKey("main", "inbox"),
      displayName: "Previous inbox task",
      name: "inbox",
      description: "Existing operator-owned state",
      agentId: "main",
      enabled: true,
      schedule: {
        kind: "every",
        everyMs: 5 * 60 * 60_000,
        anchorMs: fixture.nowMs - 60_000,
      },
      payload: { kind: "systemEvent", text: "Previous inbox prompt" },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      state: { lastRunAtMs: fixture.nowMs - 10_000 },
    },
    { enabledExplicit: true, matchesExisting: isHeartbeatTaskCronJob },
  );
  return structuredClone("job" in result ? result.job : result);
}

describe("heartbeat scratch task cron migration", () => {
  it("previews, preserves cadence, clears the block, and reruns idempotently", async () => {
    const fixture = await createFixture(2_000_000_000_000);

    await expect(collectHeartbeatTaskMigrationFindings(fixture.cfg, fixture.env)).resolves.toEqual([
      expect.objectContaining({
        checkId: "core/doctor/heartbeat-task-cron-migration",
        requirement: "heartbeat-tasks-in-scratch",
        target: "main",
      }),
    ]);
    const preview = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: false,
      nowMs: fixture.nowMs,
    });
    expect(preview).toEqual({ changes: [], warnings: [] });
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toEqual([]);

    const migrated = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });
    expect(migrated.warnings).toEqual([]);
    expect(migrated.changes).toHaveLength(1);

    const jobs = (await loadCronJobsStore(fixture.storePath)).jobs
      .filter(isHeartbeatTaskCronJob)
      .toSorted((a, b) => a.name.localeCompare(b.name));
    expect(jobs).toHaveLength(2);
    expect(
      jobs.map((job) => ({ name: job.name, schedule: job.schedule, payload: job.payload })),
    ).toEqual([
      {
        name: "calendar",
        schedule: { kind: "every", everyMs: 2 * 60 * 60_000, anchorMs: fixture.nowMs + 1 },
        payload: { kind: "systemEvent", text: "Check the next meetings" },
      },
      {
        name: "inbox",
        schedule: {
          kind: "every",
          everyMs: 60 * 60_000,
          anchorMs: fixture.nowMs + 30 * 60_000,
        },
        payload: { kind: "systemEvent", text: "Check urgent inbox items" },
      },
    ]);
    expect(jobs.find((job) => job.name === "calendar")?.state.nextRunAtMs).toBe(fixture.nowMs + 1);
    expect(jobs.find((job) => job.name === "inbox")?.state.nextRunAtMs).toBe(
      fixture.nowMs + 30 * 60_000,
    );

    const scratch = readCronJobScratchState(fixture.storePath, fixture.monitor.id, {
      env: fixture.env,
    }).scratch;
    expect(scratch?.content).toContain("# Operations");
    expect(scratch?.content).toContain("# Keep alerts concise");
    expect(scratch?.content).not.toContain("tasks:");
    expect(
      resolveHeartbeatSession(fixture.cfg, "main", undefined, undefined, fixture.env).entry
        ?.heartbeatTaskState,
    ).toBeUndefined();

    const rerun = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs + 10_000,
    });
    expect(rerun).toEqual({ changes: [], warnings: [] });
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toHaveLength(2);
  });

  it("leaves cron jobs and legacy timestamps untouched when the scratch revision changes", async () => {
    const fixture = await createFixture(2_000_000_000_000);
    const existingSnapshot = await createExistingInboxJob(fixture);
    const concurrentScratch = `# Concurrent replacement
tasks:
  - name: follow-up
    interval: 3h
    prompt: Run the concurrent follow-up
# Keep concurrent prose
`;
    const migration = maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });
    const current = readCronJobScratchState(fixture.storePath, fixture.monitor.id, {
      env: fixture.env,
    });
    writeCronJobScratch({
      storePath: fixture.storePath,
      jobId: fixture.monitor.id,
      content: concurrentScratch,
      expectedRevision: current.currentRevision,
      options: { env: fixture.env },
    });
    const result = await migration;

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("scratch changed during task migration");
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe(concurrentScratch);
    const jobs = (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob);
    expect(jobs).toEqual([existingSnapshot]);
    expect(
      resolveHeartbeatSession(fixture.cfg, "main", undefined, undefined, fixture.env).entry
        ?.heartbeatTaskState,
    ).toEqual({ inbox: fixture.nowMs - 30 * 60_000 });
  });

  it("serializes two plans pinned to one scratch revision and converges the loser on rerun", async () => {
    const fixture = await createFixture(2_000_000_000_000);
    const outcomes = await Promise.all([
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs,
      }),
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs,
      }),
    ]);

    expect(outcomes.filter((outcome) => outcome.changes.length === 1)).toHaveLength(1);
    expect(
      outcomes.filter((outcome) =>
        outcome.warnings.some((warning) =>
          warning.includes("scratch changed during task migration"),
        ),
      ),
    ).toHaveLength(1);
    const committedJobs = (await loadCronJobsStore(fixture.storePath)).jobs.filter(
      isHeartbeatTaskCronJob,
    );
    expect(committedJobs).toHaveLength(2);
    expect(new Set(committedJobs.map((job) => job.declarationKey)).size).toBe(2);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).not.toContain("tasks:");

    const rerun = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs + 10_000,
    });
    expect(rerun).toEqual({ changes: [], warnings: [] });
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toEqual(committedJobs);
  });

  it("tolerates a crash after the state transaction and before legacy timestamp cleanup", async () => {
    const fixture = await createFixture(2_000_000_000_000);
    const cleanup = vi
      .spyOn(sessionAccessor, "patchSessionEntry")
      .mockRejectedValueOnce(new Error("simulated post-commit crash"));
    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(result.changes).toHaveLength(1);
    expect(result.warnings.join("\n")).toContain("simulated post-commit crash");
    const committedJobs = (await loadCronJobsStore(fixture.storePath)).jobs.filter(
      isHeartbeatTaskCronJob,
    );
    expect(committedJobs).toHaveLength(2);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).not.toContain("tasks:");
    expect(
      resolveHeartbeatSession(fixture.cfg, "main", undefined, undefined, fixture.env).entry
        ?.heartbeatTaskState,
    ).toEqual({ inbox: fixture.nowMs - 30 * 60_000 });

    cleanup.mockRestore();
    await expect(
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs + 10_000,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toEqual(committedJobs);
  });

  it("migrates duplicate-name tasks with stable identities and shared initial due time", async () => {
    const fixture = await createFixture(2_000_000_000_000);
    const state = readCronJobScratchState(fixture.storePath, fixture.monitor.id, {
      env: fixture.env,
    });
    const duplicate = `tasks:
  - name: inbox
    interval: 1h
    prompt: First
  - name: inbox
    interval: 1h
    prompt: Second
`;
    writeCronJobScratch({
      storePath: fixture.storePath,
      jobId: fixture.monitor.id,
      content: duplicate,
      expectedRevision: state.currentRevision,
      options: { env: fixture.env },
    });

    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toHaveLength(1);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe("");
    const jobs = (await loadCronJobsStore(fixture.storePath)).jobs
      .filter(isHeartbeatTaskCronJob)
      .toSorted((left, right) => left.payload.text.localeCompare(right.payload.text));
    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.declarationKey)).toEqual([
      heartbeatTaskDeclarationKey("main", "inbox", 0),
      heartbeatTaskDeclarationKey("main", "inbox", 1),
    ]);
    expect(new Set(jobs.map((job) => job.declarationKey)).size).toBe(2);
    expect(jobs.map((job) => job.schedule)).toEqual([
      {
        kind: "every",
        everyMs: 60 * 60_000,
        anchorMs: fixture.nowMs + 30 * 60_000,
      },
      {
        kind: "every",
        everyMs: 60 * 60_000,
        anchorMs: fixture.nowMs + 30 * 60_000,
      },
    ]);
    const initialIdentities = jobs.map((job) => ({ id: job.id, key: job.declarationKey }));

    await expect(
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs + 10_000,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    const rerunJobs = (await loadCronJobsStore(fixture.storePath)).jobs
      .filter(isHeartbeatTaskCronJob)
      .toSorted((left, right) => left.payload.text.localeCompare(right.payload.text));
    expect(rerunJobs.map((job) => ({ id: job.id, key: job.declarationKey }))).toEqual(
      initialIdentities,
    );
  });

  it("migrates a mixed unique and duplicate-name task block completely", async () => {
    const content = `tasks:
  - name: inbox
    interval: 1h
    prompt: First inbox pass
  - name: calendar
    interval: 2h
    prompt: Calendar pass
  - name: inbox
    interval: 1h
    prompt: Second inbox pass
`;
    const fixture = await createFixture(2_000_000_000_000, content);

    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(result.warnings).toEqual([]);
    const jobs = (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob);
    expect(jobs).toHaveLength(3);
    expect(new Set(jobs.map((job) => job.declarationKey)).size).toBe(3);
    expect(
      jobs.map((job) => job.payload.text).toSorted((left, right) => left.localeCompare(right)),
    ).toEqual(["Calendar pass", "First inbox pass", "Second inbox pass"]);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe("");
  });

  it("refuses orphan task fields beside a valid task without changing scratch", async () => {
    const content = `# Operations
tasks:
  interval: 15m
  prompt: Orphaned work must not disappear
  - name: inbox
    interval: 1h
    prompt: Check urgent inbox items
# Keep alerts concise
`;
    const fixture = await createFixture(2_000_000_000_000, content);

    await expect(collectHeartbeatTaskMigrationFindings(fixture.cfg, fixture.env)).resolves.toEqual([
      expect.objectContaining({
        severity: "error",
        requirement: "heartbeat-task-migration-blocked",
        message: expect.stringContaining("incomplete name/interval/prompt entry"),
      }),
    ]);
    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(result.changes).toEqual([]);
    expect(result.warnings.join("\n")).toContain("incomplete name/interval/prompt entry");
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe(content);
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toEqual([]);
  });

  it("does not migrate a task block hidden by a mid-line HTML comment opener", async () => {
    const content = `Notes <!--
tasks:
  - name: disabled
    interval: 5m
    prompt: This must remain disabled
-->
# Keep this scratch
`;
    const fixture = await createFixture(2_000_000_000_000, content);

    await expect(collectHeartbeatTaskMigrationFindings(fixture.cfg, fixture.env)).resolves.toEqual(
      [],
    );
    await expect(
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });

    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toEqual([]);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe(content);
  });

  it("keeps a multiline comment closed when its opener shares a migrated task line", async () => {
    const content = `tasks:
  - name: active
    interval: 1h
    prompt: Run the active check <!--
tasks:
  - name: disabled
    interval: 5m
    prompt: This must remain disabled
-->
# Keep this scratch
`;
    const fixture = await createFixture(2_000_000_000_000, content);

    const migrated = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(migrated.warnings).toEqual([]);
    const jobs = (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob);
    expect(jobs.map((job) => job.name)).toEqual(["active"]);
    const scratch = readCronJobScratchState(fixture.storePath, fixture.monitor.id, {
      env: fixture.env,
    }).scratch?.content;
    expect(scratch).toContain(`<!--
tasks:
  - name: disabled
    interval: 5m
    prompt: This must remain disabled
-->`);
    await expect(
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs + 10_000,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });
  });

  it("preserves indented non-task prose and its line endings byte-for-byte", async () => {
    const content =
      "# Operations\r\n" +
      "tasks:\r\n" +
      "  - name: inbox\r\n" +
      "    interval: 1h\r\n" +
      "    prompt: Check urgent inbox items\r\n" +
      "  Keep this indented note exactly.  \r\n" +
      "# Keep alerts concise\r\n";
    const fixture = await createFixture(2_000_000_000_000, content);

    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(result.warnings).toEqual([]);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe("# Operations\r\n  Keep this indented note exactly.  \r\n# Keep alerts concise\r\n");
  });

  it("uses the supplied environment for legacy session timing and cleanup", async () => {
    const fixture = await createFixture(2_000_000_000_000);
    const suppliedHome = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-heartbeat-task-migration-supplied-home-"),
    );
    tempDirs.push(suppliedHome);
    fixture.cfg.session = {
      store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    };
    const suppliedEnv = { ...fixture.env, HOME: suppliedHome };
    const suppliedSession = resolveHeartbeatSession(
      fixture.cfg,
      "main",
      fixture.cfg.agents?.defaults?.heartbeat,
      undefined,
      suppliedEnv,
    );
    await replaceSessionEntry(
      {
        storePath: suppliedSession.storePath,
        sessionKey: suppliedSession.sessionKey,
        env: suppliedEnv,
      },
      {
        sessionId: "supplied-heartbeat-main",
        updatedAt: fixture.nowMs,
        heartbeatTaskState: { inbox: fixture.nowMs - 30 * 60_000 },
      },
    );
    const ambientSession = resolveHeartbeatSession(
      fixture.cfg,
      "main",
      fixture.cfg.agents?.defaults?.heartbeat,
    );
    await replaceSessionEntry(
      {
        storePath: ambientSession.storePath,
        sessionKey: ambientSession.sessionKey,
      },
      {
        sessionId: "ambient-heartbeat-main",
        updatedAt: fixture.nowMs,
        heartbeatTaskState: {
          inbox: fixture.nowMs - 10 * 60_000,
          untouched: fixture.nowMs - 5_000,
        },
      },
    );

    const result = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: suppliedEnv,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(result.warnings).toEqual([]);
    const inbox = (await loadCronJobsStore(fixture.storePath)).jobs.find(
      (job) => isHeartbeatTaskCronJob(job) && job.name === "inbox",
    );
    expect(inbox?.schedule).toEqual({
      kind: "every",
      everyMs: 60 * 60_000,
      anchorMs: fixture.nowMs + 30 * 60_000,
    });
    expect(
      resolveHeartbeatSession(fixture.cfg, "main", undefined, undefined, suppliedEnv).entry
        ?.heartbeatTaskState,
    ).toBeUndefined();
    expect(resolveHeartbeatSession(fixture.cfg, "main").entry?.heartbeatTaskState).toEqual({
      inbox: fixture.nowMs - 10 * 60_000,
      untouched: fixture.nowMs - 5_000,
    });
  });

  it("removes consecutive task blocks in one idempotent migration", async () => {
    const content = `# Operations
tasks:
  - name: inbox
    interval: 1h
    prompt: Check urgent inbox items
tasks:
  - name: calendar
    interval: 2h
    prompt: Check the next meetings
# Keep alerts concise
`;
    const fixture = await createFixture(2_000_000_000_000, content);

    const migrated = await maybeMigrateHeartbeatTasksToCron({
      cfg: fixture.cfg,
      env: fixture.env,
      shouldRepair: true,
      nowMs: fixture.nowMs,
    });

    expect(migrated.warnings).toEqual([]);
    expect(
      readCronJobScratchState(fixture.storePath, fixture.monitor.id, { env: fixture.env }).scratch
        ?.content,
    ).toBe("# Operations\n# Keep alerts concise\n");
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toHaveLength(2);

    await expect(
      maybeMigrateHeartbeatTasksToCron({
        cfg: fixture.cfg,
        env: fixture.env,
        shouldRepair: true,
        nowMs: fixture.nowMs + 10_000,
      }),
    ).resolves.toEqual({ changes: [], warnings: [] });
    expect(
      (await loadCronJobsStore(fixture.storePath)).jobs.filter(isHeartbeatTaskCronJob),
    ).toHaveLength(2);
  });
});
