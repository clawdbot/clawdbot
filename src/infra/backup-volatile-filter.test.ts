// Tests volatile path filtering for backup operations.
import { describe, expect, it } from "vitest";
import { isTransientSqliteBackupPath, isVolatileBackupPath } from "./backup-volatile-filter.js";

const stateDir = "/opt/openclaw/state";
const plan = { stateDirs: [stateDir] };

describe("isVolatileBackupPath", () => {
  it.each([
    // volatile: session transcripts
    [`${stateDir}/sessions/s-abc/transcript.jsonl`, true],
    [`${stateDir}/sessions/s-abc/run.log`, true],
    [`${stateDir}/agents/main/sessions/transcript.jsonl`, true],
    [`${stateDir}/agents/ops/sessions/run.log`, true],
    // volatile: cron run logs
    [`${stateDir}/cron/runs/2026-01-01/job.log`, true],
    [`${stateDir}/cron/runs/nightly.jsonl`, true],
    // volatile: generic state logs
    [`${stateDir}/logs/gateway.jsonl`, true],
    [`${stateDir}/logs/nested/gateway.log`, true],
    // volatile: sockets/pids/tmp under state
    [`${stateDir}/ipc/gateway.sock`, true],
    [`${stateDir}/gateway.pid`, true],
    [`${stateDir}/tmp/pending.tmp`, true],
    [`${stateDir}/audit/system-agent.jsonl.migrated.raw`, false],
    [`${stateDir}/audit/system-agent.jsonl.migrated.2.raw`, false],
    [`${stateDir}/audit/system-agent.jsonl.migrated.10.raw`, false],
    [`${stateDir}/audit/system-agent.jsonl.migrated.raw.doctor-scrub-restore`, false],
    [`${stateDir}/logs/config-audit.jsonl.migrated.raw.doctor-scrub-staging`, false],
    [`${stateDir}/logs/config-audit.jsonl.migrated.raw.doctor-scrub-progress`, false],
    [`${stateDir}/delivery-queue/pending.tmp`, true],
    [`${stateDir}/session-delivery-queue/pending.tmp`, true],
    [`${stateDir}/browser/openclaw/user-data/SingletonCookie`, true],
    [`${stateDir}/browser/openclaw/user-data/SingletonLock`, true],
    [`${stateDir}/browser/openclaw/user-data/SingletonSocket`, true],
    [`${stateDir}/sandbox/skills-workspaces/workspace-main`, true],
    [`${stateDir}/sandbox/skills-workspaces/workspace-main/skills/demo`, true],

    // non-volatile: session config, not jsonl/log
    [`${stateDir}/sessions/s-abc/meta.json`, false],
    [`${stateDir}/agents/main/sessions/sessions.json`, false],
    // non-volatile: cron definitions
    [`${stateDir}/cron/jobs.json`, false],
    // non-volatile: cron runs but wrong extension
    [`${stateDir}/cron/runs/2026-01-01/job.json`, false],
    [`${stateDir}/browser/openclaw/user-data/Preferences`, false],
    [`${stateDir}/browser/openclaw/user-data/nested/SingletonSocket`, false],
    [`${stateDir}/browser/openclaw/SingletonSocket`, false],
    [`${stateDir}/sandbox/registry.json`, false],
    [`${stateDir}/sandbox/workspaces/workspace-main/README.md`, false],
    // non-volatile: plain config
    [`${stateDir}/config.json`, false],
    // non-volatile: workspace files outside state
    ["/home/user/project/README.md", false],
    ["/home/user/project/Cargo.lock", false],
    ["/home/user/project/pending.tmp", false],
    ["/home/user/project/config.jsonl.doctor-scrub-restore", false],
    // non-volatile: log-like name outside scope
    ["/home/user/notes/daily.log", false],
  ])("classifies %s as volatile=%s", (p, expected) => {
    expect(isVolatileBackupPath(p, plan)).toBe(expected);
  });

  it("returns false when no state dirs are provided", () => {
    expect(
      isVolatileBackupPath(`${stateDir}/sessions/s-abc/transcript.jsonl`, { stateDirs: [] }),
    ).toBe(false);
  });

  it("does not skip transient extensions without a state anchor", () => {
    expect(isVolatileBackupPath("/any/path/daemon.sock", { stateDirs: [] })).toBe(false);
    expect(isVolatileBackupPath("/any/path/daemon.pid", { stateDirs: [] })).toBe(false);
    expect(isVolatileBackupPath("/any/path/Cargo.lock", { stateDirs: [] })).toBe(false);
  });

  it("does not match paths that escape the anchor via `..`", () => {
    // `/opt/openclaw/state/sessions/../config.jsonl` resolves to
    // `/opt/openclaw/state/config.jsonl`, which is NOT inside sessions/.
    expect(isVolatileBackupPath(`${stateDir}/sessions/../config.jsonl`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/cron/runs/../jobs.log`, plan)).toBe(false);
    expect(isVolatileBackupPath(`${stateDir}/logs/../notes.jsonl`, plan)).toBe(false);
  });

  it("treats delivery-queue json files under stateDir as volatile", () => {
    expect(
      isVolatileBackupPath(
        `${stateDir}/delivery-queue/3fac5e46-42dc-4230-a725-51c203830b4f.json`,
        plan,
      ),
    ).toBe(true);
  });

  it("treats nested delivery-queue json files under stateDir as volatile", () => {
    expect(
      isVolatileBackupPath(
        `${stateDir}/delivery-queue/subdir/3fac5e46-42dc-4230-a725-51c203830b4f.json`,
        plan,
      ),
    ).toBe(true);
  });

  it("does not treat non-json delivery-queue files as volatile", () => {
    expect(isVolatileBackupPath(`${stateDir}/delivery-queue/README.md`, plan)).toBe(false);
  });

  it("does not treat delivery-queue json outside stateDir as volatile", () => {
    expect(isVolatileBackupPath(`/tmp/delivery-queue/file.json`, plan)).toBe(false);
  });

  it("normalizes Windows-style separators before anchor checks", () => {
    const winStateDir = "C:\\openclaw\\state";
    const winPlan = { stateDirs: [winStateDir] };
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\s-abc\\transcript.jsonl`, winPlan)).toBe(
      true,
    );
    expect(isVolatileBackupPath(`${winStateDir}\\agents\\main\\sessions\\s.jsonl`, winPlan)).toBe(
      true,
    );
    expect(isVolatileBackupPath(`${winStateDir}\\cron\\runs\\2026\\job.jsonl`, winPlan)).toBe(true);
    expect(
      isVolatileBackupPath(`${winStateDir}\\browser\\openclaw\\user-data\\SingletonLock`, winPlan),
    ).toBe(true);
    expect(
      isVolatileBackupPath(`${winStateDir}\\sandbox\\skills-workspaces\\workspace-main`, winPlan),
    ).toBe(true);
    // `..` escape via backslashes must also be rejected.
    expect(isVolatileBackupPath(`${winStateDir}\\sessions\\..\\config.jsonl`, winPlan)).toBe(false);
  });

  it("matches tar filter paths when node-tar omits the leading slash", () => {
    expect(
      isVolatileBackupPath("opt/openclaw/state/agents/main/sessions/transcript.jsonl", plan),
    ).toBe(true);
  });

  it("treats session-delivery-queue json files under stateDir as volatile", () => {
    expect(
      isVolatileBackupPath(
        `${stateDir}/session-delivery-queue/3fac5e46-42dc-4230-a725-51c203830b4f.json`,
        plan,
      ),
    ).toBe(true);
  });
});

describe("isTransientSqliteBackupPath", () => {
  it.each([
    "memory/main.sqlite.reindex-lock.sqlite",
    "memory/main.sqlite.reindex-lock.sqlite-shm",
    "memory/main.sqlite.tmp-11111111-2222-3333-4444-555555555555",
  ])("classifies transient reindex state: %s", (filePath) => {
    expect(isTransientSqliteBackupPath(filePath)).toBe(true);
  });

  it.each([
    "tmp/openclaw-502/gateway.state.lock.sqlite",
    "tmp/openclaw-502/gateway.12345678.lock.sqlite-wal",
    "tmp/openclaw-502/device-identity.12345678.lock.sqlite-journal",
    "tmp/openclaw-502/retained.sqlite",
    "plugins/dedicated/durable.sqlite",
    "plugins/dedicated/cache.lock.sqlite",
    "plugins/dedicated/durable.locked.sqlite",
    "plugins/dedicated/lock.sqlite",
  ])("preserves durable SQLite state: %s", (filePath) => {
    expect(isTransientSqliteBackupPath(filePath)).toBe(false);
  });
});
