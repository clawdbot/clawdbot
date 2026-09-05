import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { checkTargetDatabaseSchemas } from "../cli/update-cli/schema-preflight.js";
import { readMainDatabasePosixLocks } from "../infra/sqlite-posix-locks.test-support.js";
import * as snapshots from "../infra/sqlite-readonly-location.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import {
  registerOpenClawAgentDatabase,
  unregisterOpenClawAgentDatabase,
} from "./openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "./openclaw-state-db.js";

const supportedVersions = {
  state: OPENCLAW_STATE_SCHEMA_VERSION,
  agent: OPENCLAW_AGENT_SCHEMA_VERSION,
};
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

beforeEach(() => {
  vi.stubEnv("XDG_CACHE_HOME", tempDirs.make("openclaw-preflight-snapshots-"));
});

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-artifacts-") };
  const state = openOpenClawStateDatabase({ env });
  const main = openOpenClawAgentDatabase({ agentId: "main", env });
  const worker = openOpenClawAgentDatabase({ agentId: "worker", env });
  return {
    env,
    state,
    main,
    worker,
    paths: [state.path, main.path, worker.path],
    close() {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    },
  };
}

function sourceArtifacts(paths: string[]): unknown {
  // Observe in a child too: opening/closing these in the writer's process can
  // itself release POSIX locks and would invalidate the writer-isolation probe.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
       const record = file => {
         const s = fs.statSync(file, { bigint: true });
         return { file, mode: String(s.mode), dev: String(s.dev), ino: String(s.ino),
           size: String(s.size), mtime: String(s.mtimeNs), ctime: String(s.ctimeNs),
           ...(s.isFile() ? { hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
             : { entries: fs.readdirSync(file).sort() }) };
       };
       console.log(JSON.stringify(process.argv.slice(1).map(file => ({
         directory: record(path.dirname(file)),
         family: ['', '-wal', '-shm', '-journal'].map(suffix => file + suffix)
           .filter(fs.existsSync).map(record)
       }))));`,
      ...paths,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("schema preflight source artifacts", () => {
  it.each(["compatible", "refusal"])("preserves closed WAL stores on %s", (outcome) => {
    const fixture = createFixture();
    fixture.close();
    const before = sourceArtifacts(fixture.paths);
    const result = checkTargetDatabaseSchemas(
      outcome === "compatible"
        ? supportedVersions
        : { state: supportedVersions.state - 1, agent: supportedVersions.agent - 1 },
      fixture.env,
    );
    expect(result.indeterminate).toEqual([]);
    expect(result.incompatible.map((database) => database.path)).toEqual(
      outcome === "compatible" ? [] : fixture.paths,
    );
    expect(sourceArtifacts(fixture.paths)).toEqual(before);
  });

  it("reads newer committed schema versions from live WAL without changing the family", () => {
    const fixture = createFixture();
    fixture.state.db.exec(`PRAGMA user_version = ${supportedVersions.state + 10};`);
    fixture.main.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    const before = sourceArtifacts(fixture.paths);
    const result = preflightOpenClawDatabaseSchemas({
      env: fixture.env,
      supportedVersions,
      verifyCurrentSchemaShape: true,
    });
    expect(result.indeterminate).toEqual([]);
    expect(
      result.incompatible.map(({ path: pathname, foundVersion }) => [pathname, foundVersion]),
    ).toEqual([
      [fixture.state.path, supportedVersions.state + 10],
      [fixture.main.path, supportedVersions.agent + 10],
      [fixture.worker.path, supportedVersions.agent + 10],
    ]);
    expect(sourceArtifacts(fixture.paths)).toEqual(before);
  });

  it("ignores uncommitted writer versions without ending the owning transactions", () => {
    const fixture = createFixture();
    const databases = [fixture.state, fixture.main, fixture.worker];
    for (const opened of databases) {
      opened.db.exec("BEGIN IMMEDIATE; PRAGMA user_version = 999;");
    }
    try {
      const before = sourceArtifacts(fixture.paths);
      const locks =
        process.platform === "linux" ? fixture.paths.map(readMainDatabasePosixLocks) : [];
      expect(checkTargetDatabaseSchemas(supportedVersions, fixture.env)).toEqual({
        incompatible: [],
        indeterminate: [],
      });
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
      for (const opened of databases) {
        expect(opened.db.isTransaction).toBe(true);
        expect(opened.db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 999 });
      }
      if (process.platform === "linux") {
        expect(locks.every((held) => held.length > 0)).toBe(true);
        expect(fixture.paths.map(readMainDatabasePosixLocks)).toEqual(locks);
      }
    } finally {
      for (const opened of databases) {
        opened.db.exec("ROLLBACK");
      }
    }
  });

  it("preserves a candidate symlink locator and reads the physical database", () => {
    const fixture = createFixture();
    unregisterOpenClawAgentDatabase({
      agentId: "worker",
      path: fixture.worker.path,
      env: fixture.env,
    });
    fixture.close();
    const alias = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-alias.sqlite");
    fs.symlinkSync(fixture.worker.path, alias);
    const before = sourceArtifacts([...fixture.paths, alias]);
    const result = preflightOpenClawDatabaseSchemas({
      env: fixture.env,
      supportedVersions: { ...supportedVersions, agent: supportedVersions.agent - 1 },
      configuredAgentDatabaseCandidatePaths: [alias],
    });
    expect(result.indeterminate).toEqual([]);
    expect(result.incompatible.map((database) => database.path)).toEqual([
      fixture.main.path,
      alias,
    ]);
    expect(sourceArtifacts([...fixture.paths, alias])).toEqual(before);
  });

  it.each(["registered", "candidate"] as const)(
    "preserves native traversal and deduplication for a %s dot-dot locator",
    (kind) => {
      const fixture = createFixture();
      fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
      unregisterOpenClawAgentDatabase({
        agentId: "worker",
        path: fixture.worker.path,
        env: fixture.env,
      });
      const link = path.join(fixture.env.OPENCLAW_STATE_DIR, "worker-link");
      fs.symlinkSync(path.dirname(fixture.worker.path), link, "dir");
      const locator = `${link}${path.sep}..${path.sep}agent${path.sep}openclaw-agent.sqlite`;
      if (kind === "registered") {
        registerOpenClawAgentDatabase({ agentId: "worker", path: locator, env: fixture.env });
      }
      fixture.close();
      const lexicalPath = path.resolve(locator);
      fs.mkdirSync(path.dirname(lexicalPath), { recursive: true });
      fs.copyFileSync(fixture.main.path, lexicalPath, fs.constants.COPYFILE_EXCL);
      expect(fs.realpathSync.native(locator)).toBe(fs.realpathSync.native(fixture.worker.path));
      expect(fs.realpathSync(locator)).toBe(fs.realpathSync.native(lexicalPath));
      const paths = [...fixture.paths, lexicalPath];
      const before = sourceArtifacts(paths);
      const result = preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        configuredAgentDatabaseCandidatePaths:
          kind === "candidate"
            ? [locator, fixture.worker.path, lexicalPath]
            : [fixture.worker.path, lexicalPath],
      });
      expect(result.indeterminate).toEqual([]);
      expect(result.incompatible).toEqual([
        expect.objectContaining({
          path: locator,
          foundVersion: supportedVersions.agent + 10,
        }),
      ]);
      expect(sourceArtifacts(paths)).toEqual(before);
    },
  );

  it.each(["state", "main"] as const)(
    "fails closed when the %s snapshot cannot be prepared",
    (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocationSync;
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync").mockImplementation((pathname) => {
        if (pathname === fixture[kind].path) {
          throw new Error("inert snapshot admission failure");
        }
        return prepare(pathname);
      });
      const result = checkTargetDatabaseSchemas(supportedVersions, fixture.env);
      expect(result.incompatible).toEqual([]);
      expect(result.indeterminate).toEqual([
        {
          kind: kind === "state" ? "state" : "agent",
          path: fixture[kind].path,
          reason: "inert snapshot admission failure",
        },
      ]);
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );

  it.each(["state", "main"] as const)(
    "cleans the %s snapshot when its private open fails",
    (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocationSync;
      const cleanups: Array<{ location: string; cleanup: ReturnType<typeof vi.fn> }> = [];
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocationSync").mockImplementation((pathname) => {
        const prepared = prepare(pathname);
        const cleanup = vi.fn(prepared.cleanup);
        cleanups.push({ location: prepared.location, cleanup });
        return {
          location:
            pathname === fixture[kind].path
              ? path.join(path.dirname(prepared.location), "missing.sqlite")
              : prepared.location,
          cleanup,
        };
      });
      const result = checkTargetDatabaseSchemas(supportedVersions, fixture.env);
      expect(result.indeterminate).toEqual([
        expect.objectContaining({
          kind: kind === "state" ? "state" : "agent",
          path: fixture[kind].path,
        }),
      ]);
      expect(cleanups.length).toBe(kind === "state" ? 1 : 3);
      for (const { location, cleanup } of cleanups) {
        expect(cleanup).toHaveBeenCalledOnce();
        expect(fs.existsSync(path.dirname(location))).toBe(false);
      }
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );
});
