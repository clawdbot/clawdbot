import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  captureTargetDatabaseSchemaContext,
  checkTargetDatabaseSchemasForContexts,
} from "../cli/update-cli/schema-preflight.js";
import { resolveConfiguredAgentDatabaseCandidatePaths } from "../config/sessions/targets.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

// Exercise the production capture/union entry points, not a test-only export.
async function checkTargetDatabaseSchemas(
  versions: typeof supportedVersions,
  env: NodeJS.ProcessEnv,
  config?: OpenClawConfig,
) {
  const context = config ? { config, env } : await captureTargetDatabaseSchemaContext(env);
  return checkTargetDatabaseSchemasForContexts(versions, [context]);
}

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

function createFixture(storeDirectory?: string) {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-artifacts-") };
  const state = openOpenClawStateDatabase({ env });
  const main = openOpenClawAgentDatabase({
    agentId: "main",
    env,
    ...(storeDirectory ? { path: path.join(storeDirectory, "openclaw-agent.sqlite") } : {}),
  });
  const worker = openOpenClawAgentDatabase({
    agentId: "worker",
    env,
    ...(storeDirectory ? { path: path.join(storeDirectory, "openclaw-agent.worker.sqlite") } : {}),
  });
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
  it.each([OPENCLAW_AGENT_SCHEMA_VERSION, 999])(
    "includes configured partitions at schema %s without opening their source families",
    async (workerVersion) => {
      const directory = tempDirs.make("openclaw-configured-preflight-");
      const fixture = createFixture(directory);
      fixture.worker.db.exec(`PRAGMA user_version = ${workerVersion};`);
      for (const database of [fixture.main, fixture.worker]) {
        unregisterOpenClawAgentDatabase({
          agentId: database.agentId,
          path: database.path,
          env: fixture.env,
        });
      }
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const candidates = resolveConfiguredAgentDatabaseCandidatePaths(
        {
          agents: { list: [{ id: "main" }, { id: "worker" }] },
          session: { store: path.join(directory, "sessions.json") },
        },
        { env: fixture.env },
      );
      expect(candidates).toEqual([fixture.main.path, fixture.worker.path]);
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        configuredAgentDatabaseCandidatePaths: candidates,
      });
      expect(result.indeterminate).toEqual([]);
      expect(result.incompatible).toEqual(
        workerVersion > supportedVersions.agent
          ? [expect.objectContaining({ path: fixture.worker.path, foundVersion: workerVersion })]
          : [],
      );
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    },
  );

  it("checks configured stores and registered external stores without adopting migration ownership", async () => {
    const directory = tempDirs.make("openclaw-configured-preflight-");
    const fixture = createFixture(directory);
    for (const database of [fixture.main, fixture.worker]) {
      unregisterOpenClawAgentDatabase({
        agentId: database.agentId,
        path: database.path,
        env: fixture.env,
      });
    }
    const retired = openOpenClawAgentDatabase({
      agentId: "retired",
      env: fixture.env,
      path: path.join(tempDirs.make("openclaw-registered-preflight-"), "retired.sqlite"),
    });
    fs.writeFileSync(
      path.join(fixture.env.OPENCLAW_STATE_DIR, "openclaw.json"),
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: {}, worker: {} } },
        session: { store: path.join(directory, "sessions.json") },
      }),
    );
    fixture.close();
    const paths = [...fixture.paths, retired.path];
    const before = sourceArtifacts(paths);
    const result = await checkTargetDatabaseSchemas(
      { state: supportedVersions.state - 1, agent: supportedVersions.agent - 1 },
      fixture.env,
    );
    expect(result.indeterminate).toEqual([]);
    expect(result.incompatible.map((database) => database.path).toSorted()).toEqual(
      paths.toSorted(),
    );
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it.each([false, true])(
    "unions native locators and aliases without dropping distinct stores, reversed=%s",
    async (reversed) => {
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
      registerOpenClawAgentDatabase({ agentId: "worker", path: locator, env: fixture.env });
      fixture.close();
      const lexicalPath = path.resolve(locator);
      fs.mkdirSync(path.dirname(lexicalPath), { recursive: true });
      fs.copyFileSync(fixture.main.path, lexicalPath, fs.constants.COPYFILE_EXCL);
      expect(fs.realpathSync.native(locator)).toBe(fs.realpathSync.native(fixture.worker.path));
      expect(fs.realpathSync(locator)).toBe(fs.realpathSync.native(lexicalPath));
      const callerEnv = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-preflight-caller-") };
      const contexts = [
        { env: fixture.env, config: {} },
        { env: callerEnv, config: { session: { store: lexicalPath } } },
        { env: callerEnv, config: { session: { store: fixture.worker.path } } },
      ];
      const paths = [
        ...fixture.paths,
        lexicalPath,
        path.join(callerEnv.OPENCLAW_STATE_DIR, "absent.sqlite"),
      ];
      const before = sourceArtifacts(paths);
      const result = await checkTargetDatabaseSchemasForContexts(
        { ...supportedVersions, agent: supportedVersions.agent - 1 },
        reversed ? contexts.toReversed() : contexts,
      );
      expect(result.indeterminate).toEqual([]);
      expect(
        result.incompatible.map((database) => fs.realpathSync.native(database.path)).toSorted(),
      ).toEqual([fixture.main.path, fixture.worker.path, lexicalPath].toSorted());
      expect(
        result.incompatible.find(
          (database) => database.foundVersion === supportedVersions.agent + 10,
        )?.path,
      ).toBe(reversed ? fixture.worker.path : locator);
      expect(sourceArtifacts(paths)).toEqual(before);
    },
  );

  it("refuses unreadable config during capture and preserves metadata-free schema checks", async () => {
    const fixture = createFixture();
    const configPath = path.join(fixture.env.OPENCLAW_STATE_DIR, "openclaw.json");
    fs.writeFileSync(configPath, "{ invalid synthetic config");
    fixture.close();
    const paths = [...fixture.paths, configPath];
    const before = sourceArtifacts(paths);
    await expect(checkTargetDatabaseSchemas(supportedVersions, fixture.env)).rejects.toMatchObject({
      reason: "database-schema-preflight",
    });
    expect(
      await checkTargetDatabaseSchemasForContexts(undefined, [{ env: fixture.env, config: {} }]),
    ).toEqual({
      incompatible: [],
      indeterminate: [],
    });
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("uses config-derived state selection without changing caller env or overriding explicit selection", async () => {
    const fixture = createFixture();
    fixture.worker.db.exec("PRAGMA user_version = 999;");
    const explicitFixture = createFixture();
    const configPath = path.join(fixture.env.OPENCLAW_STATE_DIR, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ env: { vars: { OPENCLAW_STATE_DIR: fixture.env.OPENCLAW_STATE_DIR } } }),
    );
    fixture.close();
    const callerEnv = Object.freeze({
      OPENCLAW_HOME: tempDirs.make("openclaw-preflight-application-root-"),
      OPENCLAW_CONFIG_PATH: configPath,
    });
    const paths = [...fixture.paths, ...explicitFixture.paths, configPath];
    const before = sourceArtifacts(paths);
    const expected = {
      incompatible: [expect.objectContaining({ path: fixture.worker.path, foundVersion: 999 })],
      indeterminate: [],
    };
    expect(await checkTargetDatabaseSchemas(supportedVersions, callerEnv)).toEqual(expected);
    expect(
      await checkTargetDatabaseSchemas(supportedVersions, { ...callerEnv, ...fixture.env }),
    ).toEqual(expected);
    expect(
      await checkTargetDatabaseSchemas(supportedVersions, { ...callerEnv, ...explicitFixture.env }),
    ).toEqual({ incompatible: [], indeterminate: [] });
    expect(callerEnv).not.toHaveProperty("OPENCLAW_STATE_DIR");
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("classifies unavailable configured inventory as a pre-mutation refusal, but allows absent stores", async () => {
    const fixture = createFixture();
    const blockedDirectory = path.join(fixture.env.OPENCLAW_STATE_DIR, "not-a-directory");
    fs.writeFileSync(blockedDirectory, "inert regular file\n");
    fixture.close();
    const paths = [...fixture.paths, blockedDirectory];
    const before = sourceArtifacts(paths);
    await expect(
      checkTargetDatabaseSchemasForContexts(supportedVersions, [
        {
          env: fixture.env,
          config: { session: { store: path.join(blockedDirectory, "sessions.json") } },
        },
      ]),
    ).rejects.toMatchObject({
      name: "UpdatePreMutationError",
      reason: "database-schema-preflight",
      message: expect.stringContaining("ENOTDIR"),
    });
    expect(
      await checkTargetDatabaseSchemasForContexts(supportedVersions, [
        {
          env: fixture.env,
          config: {
            session: {
              store: path.join(fixture.env.OPENCLAW_STATE_DIR, "missing", "sessions.json"),
            },
          },
        },
      ]),
    ).toEqual({ incompatible: [], indeterminate: [] });
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it("refuses an unavailable direct SQLite locator without treating it as absent", async () => {
    const fixture = createFixture();
    const blockedDirectory = path.join(fixture.env.OPENCLAW_STATE_DIR, "not-a-directory");
    fs.writeFileSync(blockedDirectory, "inert regular file\n");
    fixture.close();
    const paths = [...fixture.paths, blockedDirectory];
    const before = sourceArtifacts(paths);
    const store = path.join(blockedDirectory, "agent.sqlite");
    expect(
      await checkTargetDatabaseSchemas(supportedVersions, fixture.env, { session: { store } }),
    ).toEqual({
      incompatible: [],
      indeterminate: [{ kind: "agent", path: store, reason: expect.stringContaining("ENOTDIR") }],
    });
    expect(sourceArtifacts(paths)).toEqual(before);
  });

  it.each(["compatible", "refusal"])("preserves closed WAL stores on %s", async (outcome) => {
    const fixture = createFixture();
    fixture.close();
    const before = sourceArtifacts(fixture.paths);
    const result = await checkTargetDatabaseSchemas(
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

  it("reads newer committed schema versions from live WAL without blocking or changing the family", async () => {
    const fixture = createFixture();
    fixture.state.db.exec(`PRAGMA user_version = ${supportedVersions.state + 10};`);
    fixture.main.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    fixture.worker.db.exec(`PRAGMA user_version = ${supportedVersions.agent + 10};`);
    const before = sourceArtifacts(fixture.paths);
    let eventLoopServiced = false;
    const immediate = setImmediate(() => {
      eventLoopServiced = true;
    });
    try {
      const result = await preflightOpenClawDatabaseSchemas({
        env: fixture.env,
        supportedVersions,
        verifyCurrentSchemaShape: true,
      });
      expect(eventLoopServiced).toBe(true);
      expect(result.indeterminate).toEqual([]);
      expect(
        result.incompatible.map(({ path: pathname, foundVersion }) => [pathname, foundVersion]),
      ).toEqual([
        [fixture.state.path, supportedVersions.state + 10],
        [fixture.main.path, supportedVersions.agent + 10],
        [fixture.worker.path, supportedVersions.agent + 10],
      ]);
      expect(sourceArtifacts(fixture.paths)).toEqual(before);
    } finally {
      clearImmediate(immediate);
    }
  });

  it("ignores uncommitted writer versions without ending the owning transactions", async () => {
    const fixture = createFixture();
    const databases = [fixture.state, fixture.main, fixture.worker];
    for (const opened of databases) {
      opened.db.exec("BEGIN IMMEDIATE; PRAGMA user_version = 999;");
    }
    try {
      const before = sourceArtifacts(fixture.paths);
      const locks =
        process.platform === "linux" ? fixture.paths.map(readMainDatabasePosixLocks) : [];
      expect(await checkTargetDatabaseSchemas(supportedVersions, fixture.env)).toEqual({
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

  it("preserves a candidate symlink locator and reads the physical database", async () => {
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
    const result = await preflightOpenClawDatabaseSchemas({
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
    async (kind) => {
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
      const result = await preflightOpenClawDatabaseSchemas({
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
    async (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocation;
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (pathname, options) => {
          if (pathname === fixture[kind].path) {
            throw new Error("inert snapshot admission failure");
          }
          return await prepare(pathname, options);
        },
      );
      const result = await checkTargetDatabaseSchemas(supportedVersions, fixture.env);
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
    async (kind) => {
      const fixture = createFixture();
      fixture.close();
      const before = sourceArtifacts(fixture.paths);
      const prepare = snapshots.prepareSqliteReadOnlyLocation;
      const cleanups: Array<{ location: string; cleanup: ReturnType<typeof vi.fn> }> = [];
      vi.spyOn(snapshots, "prepareSqliteReadOnlyLocation").mockImplementation(
        async (pathname, options) => {
          const prepared = await prepare(pathname, options);
          const cleanup = vi.fn(prepared.cleanup);
          cleanups.push({ location: prepared.location, cleanup });
          return {
            location:
              pathname === fixture[kind].path
                ? path.join(path.dirname(prepared.location), "missing.sqlite")
                : prepared.location,
            cleanup,
          };
        },
      );
      const result = await checkTargetDatabaseSchemas(supportedVersions, fixture.env);
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
