import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runCommandBuffered } from "../process/exec.js";
import { getFileLockProcessStartTime } from "../shared/pid-alive.js";
import { withAgentDatabaseMaintenanceLease } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { hasNodeErrorCode } from "./path-guards.js";
import { runtimeProcessEntrypoints } from "./runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import { projectUpdateCandidatePlugins } from "./update-candidate-plugins.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import {
  readUpdateStateSchemaVersions,
  type snapshotUpdateCandidateState,
  updateStateSchemaVersionsMatch,
  UpdateCandidateStateSnapshotSchema,
} from "./update-candidate-state.js";

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "candidate-state-")));
});
afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await fs.rm(root, { recursive: true, force: true });
});

async function createDatabase(file: string, sql = ""): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const db = openNodeSqliteDatabase(file);
  try {
    db.exec(
      `PRAGMA user_version = 3; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('preserved'); ${sql}`,
    );
  } finally {
    db.close();
  }
}

async function runSnapshotWorker(
  input: Omit<Parameters<typeof snapshotUpdateCandidateState>[0], "candidateRoot">,
) {
  // Backup/VACUUM cannot be cancelled in-process; use the canary's worker before fixture cleanup.
  const result = await runCommandBuffered(
    [
      process.execPath,
      ...resolveRuntimeWorkerArgv(
        resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.updateCandidateState),
      ),
    ],
    {
      input: JSON.stringify({
        ...input,
        candidateRoot: path.join(root, "candidate-host"),
        mode: "snapshot",
      }),
      timeoutMs: 30_000,
      killGraceMs: 500,
      maxOutputBytes: { stdout: 1024 * 1024, stderr: 20_000 },
    },
  );
  expect(result.code, result.stderr.toString("utf8")).toBe(0);
  return UpdateCandidateStateSnapshotSchema.parse(JSON.parse(result.stdout.toString("utf8")))
    .versions;
}

it.each(["DELETE", "WAL"])(
  "copies registered databases in %s mode without source process leases or source artifact changes",
  async (journalMode) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const canonical = path.join(source, "agents", "main", "agent", "openclaw-agent.sqlite");
    const external = path.join(root, "external", "openclaw-agent.sqlite");
    await createDatabase(canonical);
    await createDatabase(external);
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    const insert = registry.prepare(
      "INSERT INTO agent_databases (agent_id, path, schema_version, last_seen_at) VALUES (?, ?, 3, 0)",
    );
    insert.run("external", external);
    insert.run("main", canonical);
    insert.run("main", path.relative(source, canonical));
    const now = Date.now();
    registry
      .prepare("INSERT INTO agent_database_leases VALUES (?, ?, ?, ?, ?, ?)")
      .run(
        "live-main",
        "main",
        canonical,
        process.pid,
        getFileLockProcessStartTime(process.pid),
        now,
      );
    registry
      .prepare("INSERT INTO state_leases VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        "core:agent-database-maintenance",
        "global",
        "live-source-owner",
        now + 60_000,
        now,
        null,
        now,
        now,
      );
    closeOpenClawStateDatabaseByPath(shared);
    const sources = [shared, canonical, external];
    for (const file of sources) {
      const database = openNodeSqliteDatabase(file);
      database.exec(`PRAGMA journal_mode = ${journalMode};`);
      database.close();
    }
    const artifacts = async () =>
      Promise.all(
        sources.map(async (file) => ({
          bytes: await fs.readFile(file),
          entries: (await fs.readdir(path.dirname(file))).toSorted(),
        })),
      );
    const before = await artifacts();
    const inspected = await readUpdateStateSchemaVersions({ stateDir: source, config: {} });
    expect(inspected.filter((entry) => entry.userVersion === 3)).toHaveLength(2);
    expect(await artifacts()).toEqual(before);
    const versions = await runSnapshotWorker({
      stateDir: source,
      targetStateDir: target,
      config: {},
    });
    expect(versions).toEqual(inspected);
    await expect(
      withAgentDatabaseMaintenanceLease(
        {
          env: {
            OPENCLAW_STATE_DIR: target,
            OPENCLAW_CONFIG_PATH: path.join(target, "openclaw.json"),
          },
        },
        async (maintenance) => maintenance.assertOwned(),
      ),
    ).resolves.toBeUndefined();
    expect(await artifacts()).toEqual(before);
    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    expect(copiedRegistry.prepare("SELECT * FROM agent_database_leases").all()).toEqual([]);
    expect(copiedRegistry.prepare("SELECT * FROM state_leases").all()).toEqual([]);
    expect(
      copiedRegistry
        .prepare("SELECT count(*) AS count FROM agent_databases WHERE agent_id = 'main'")
        .get(),
    ).toMatchObject({ count: 1 });
    const rebound = copiedRegistry
      .prepare("SELECT path FROM agent_databases WHERE agent_id = 'external'")
      .get() as {
      path: string;
    };
    copiedRegistry.close();
    expect(path.isAbsolute(rebound.path)).toBe(false);
    expect(rebound.path).toMatch(/^candidate-external/);
    for (const file of [
      path.join(target, rebound.path),
      path.join(target, "agents", "main", "agent", "openclaw-agent.sqlite"),
    ]) {
      const copied = openNodeSqliteDatabase(file);
      expect(copied.prepare("SELECT value FROM evidence").get()).toMatchObject({
        value: "preserved",
      });
      copied.close();
    }
  },
);

it("retains deferred content in both inspection and rehearsal snapshots", async () => {
  const stateDir = path.join(root, "deferred");
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  await createDatabase(
    file,
    `
    PRAGMA user_version = 15;
    CREATE TABLE config_machine_state (state_key TEXT PRIMARY KEY, value_json TEXT, updated_at_ms INTEGER);
    INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '16', 0);
  `,
  );
  const inspected = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(inspected.find((entry) => entry.path === file)).toEqual({
    path: file,
    userVersion: 15,
    contentVersion: 16,
  });
  expect(
    await runSnapshotWorker({
      stateDir,
      targetStateDir: path.join(root, "rehearsal"),
      config: {},
    }),
  ).toEqual(inspected);
});

it("reads committed WAL schemas without ending the live writer's transaction", async () => {
  const stateDir = path.join(root, "live");
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  await createDatabase(file, "PRAGMA journal_mode = WAL;");
  const writer = openNodeSqliteDatabase(file);
  try {
    writer.exec("PRAGMA user_version = 4; BEGIN IMMEDIATE; PRAGMA user_version = 5;");
    const versions = await readUpdateStateSchemaVersions({ stateDir, config: {} });
    expect(versions.find((entry) => entry.path === file)?.userVersion).toBe(4);
    expect(writer.isTransaction).toBe(true);
    expect(writer.prepare("PRAGMA user_version").get()).toEqual({ user_version: 5 });
  } finally {
    writer.exec("ROLLBACK");
    writer.close();
  }
});

it("keeps absent stores explicit and observes newly created databases for rollback fencing", async () => {
  const stateDir = path.join(root, "state-owner");
  const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(before.every((entry) => entry.userVersion === null)).toBe(true);
  const main = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  await createDatabase(main);
  const after = await readUpdateStateSchemaVersions({ stateDir, config: {} });
  expect(after.find((entry) => entry.path === main)?.userVersion).toBe(3);
  const sharedPath = path.join(stateDir, "state", "openclaw.sqlite");
  expect(updateStateSchemaVersionsMatch(before, after, { sharedPath })).toBe(false);
  const candidate = { sharedPath, candidateSchemaVersions: { state: 7, agent: 3 } };
  expect(updateStateSchemaVersionsMatch(before, after, candidate)).toBe(true);
  expect(
    updateStateSchemaVersionsMatch(before, after, {
      sharedPath,
      candidateSchemaVersions: { state: 3, agent: 4 },
    }),
  ).toBe(false);
  expect(updateStateSchemaVersionsMatch(after, before, candidate)).toBe(false);
  expect(updateStateSchemaVersionsMatch(after, after.toReversed(), candidate)).toBe(true);
});

it("inspects with the installed candidate and selected Node after the old package is removed", async () => {
  const stateDir = path.join(root, "state-owner");
  await createDatabase(path.join(stateDir, "state", "openclaw.sqlite"));
  const previousRoot = path.join(root, "previous-package");
  const candidateRoot = path.join(root, "candidate-package");
  const worker = `
    import path from "node:path";
    import { DatabaseSync } from "node:sqlite";
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const file = path.join(JSON.parse(input).stateDir, "state", "openclaw.sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      console.log(JSON.stringify([{ path: file, userVersion: db.prepare("PRAGMA user_version").get().user_version }]));
    } finally {
      db.close();
    }
  `;
  for (const packageRoot of [previousRoot, candidateRoot]) {
    const file = path.join(packageRoot, "dist/infra/update-candidate-state.worker.js");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}');
    await fs.writeFile(file, worker);
  }
  const entrypoint = runtimeProcessEntrypoints.updateCandidateState;
  const originalModuleUrl = entrypoint.currentModuleUrl;
  Object.assign(entrypoint, {
    currentModuleUrl: pathToFileURL(path.join(previousRoot, "dist/old-updater.js")).href,
  });
  try {
    const before = await readUpdateStateSchemaVersions({ stateDir, config: {} });
    expect(before).toEqual([
      { path: path.join(stateDir, "state", "openclaw.sqlite"), userVersion: 3 },
    ]);
    await fs.rm(previousRoot, { recursive: true });
    const selectedNodeMarker = path.join(root, "selected-node-ran");
    let nodeRunner = process.execPath;
    if (process.platform !== "win32") {
      nodeRunner = path.join(root, "selected-node");
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await fs.writeFile(
        nodeRunner,
        `#!/bin/sh\nprintf selected > ${quote(selectedNodeMarker)}\nexec ${quote(process.execPath)} "$@"\n`,
        { mode: 0o755 },
      );
    }
    const after = await readUpdateStateSchemaVersions({
      stateDir,
      config: {},
      root: candidateRoot,
      nodeRunner,
    });
    expect(after).toEqual(before);
    if (process.platform !== "win32") {
      expect(await fs.readFile(selectedNodeMarker, "utf8")).toBe("selected");
    }
  } finally {
    Object.assign(entrypoint, { currentModuleUrl: originalModuleUrl });
  }
});

it.runIf(process.platform !== "win32")(
  "preserves distinct registered databases reached through symlink parent traversal",
  async () => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const shared = path.join(source, "state", "openclaw.sqlite");
    const symlinkTarget = path.join(source, "external", "subdir");
    await fs.mkdir(symlinkTarget, { recursive: true });
    await fs.symlink(symlinkTarget, path.join(source, "link"), "dir");
    const filesystemPath = path.join(source, "external", "x", "openclaw-agent.sqlite");
    const lexicalPath = path.join(source, "x", "openclaw-agent.sqlite");
    await createDatabase(filesystemPath, "UPDATE evidence SET value = 'filesystem';");
    await createDatabase(lexicalPath, "UPDATE evidence SET value = 'lexical';");
    await createDatabase(
      shared,
      "CREATE TABLE agent_databases(agent_id TEXT, path TEXT, PRIMARY KEY(agent_id,path));",
    );
    const registry = openNodeSqliteDatabase(shared);
    const insert = registry.prepare("INSERT INTO agent_databases VALUES (?, ?)");
    insert.run("filesystem", `link${path.sep}..${path.sep}x${path.sep}openclaw-agent.sqlite`);
    insert.run("lexical", lexicalPath);
    registry.close();

    await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });

    const copiedRegistry = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    try {
      for (const owner of ["filesystem", "lexical"]) {
        const row = copiedRegistry
          .prepare("SELECT path FROM agent_databases WHERE agent_id = ?")
          .get(owner) as { path: string };
        const copied = openNodeSqliteDatabase(path.join(target, row.path));
        try {
          expect(copied.prepare("SELECT value FROM evidence").get()).toEqual({ value: owner });
        } finally {
          copied.close();
        }
      }
    } finally {
      copiedRegistry.close();
    }
  },
);

it.each([
  { source: "npm", relative: "extensions/demo" },
  { source: "clawhub", relative: "extensions/demo" },
  { source: "npm", relative: "npm/projects/demo/node_modules/demo" },
  { source: "npm", relative: "npm/node_modules/demo" },
])(
  "projects $source plugin at $relative without touching live files or host links",
  async ({ source: installSource, relative }) => {
    const source = path.join(root, "source");
    const target = path.join(root, "copy");
    const packageDir = path.join(source, relative);
    const liveHost = path.join(root, "live-host");
    const candidateHost = path.join(root, "candidate-host");
    const dependency = path.join(root, "external-dependency");
    const modulesDir = relative.includes("npm/")
      ? path.dirname(packageDir)
      : path.join(packageDir, "node_modules");
    await fs.mkdir(path.join(packageDir, "node_modules"), { recursive: true });
    for (const [directory, name, value] of [
      [liveHost, "openclaw", "live"],
      [candidateHost, "openclaw", "candidate"],
      [dependency, "dependency", "preserved"],
    ]) {
      await fs.mkdir(directory!);
      await fs.writeFile(
        path.join(directory!, "package.json"),
        JSON.stringify({ name, type: "module", exports: "./index.js" }),
      );
      await fs.writeFile(
        path.join(directory!, "index.js"),
        `export default ${JSON.stringify(value)};`,
      );
    }
    await fs.symlink(dependency, path.join(modulesDir, "dependency"), "junction");
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        type: "module",
        peerDependencies: { openclaw: "*" },
      }),
    );
    await fs.writeFile(
      path.join(packageDir, "index.js"),
      'import host from "openclaw"; import dependency from "dependency"; export default {host, dependency};',
    );
    await fs.symlink(liveHost, path.join(packageDir, "node_modules", "openclaw"), "junction");
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    registry
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(
        "plugins.installedIndex",
        JSON.stringify({
          revision: 1,
          index: {
            plugins: [{ source: packageDir }],
            installRecords: {
              demo: { source: installSource, installPath: packageDir, version: "1.0.0" },
            },
          },
        }),
        1,
      );
    const shared = path.join(source, "state", "openclaw.sqlite");
    closeOpenClawStateDatabaseByPath(shared);
    const before = await fs.readFile(shared);
    await runSnapshotWorker({ stateDir: source, targetStateDir: target, config: {} });
    expect(await fs.readFile(shared)).toEqual(before);
    expect(await fs.realpath(path.join(packageDir, "node_modules", "openclaw"))).toBe(liveHost);
    const copied = openNodeSqliteDatabase(path.join(target, "state", "openclaw.sqlite"));
    try {
      const row = copied
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'plugins.installedIndex'",
        )
        .get() as { value_json: string };
      const record = JSON.parse(row.value_json).index.installRecords.demo;
      expect(record.installPath).toBe(path.join(target, relative));
      expect(await fs.realpath(path.join(record.installPath, "node_modules", "openclaw"))).toBe(
        candidateHost,
      );
      const result = await runCommandBuffered(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `console.log(JSON.stringify((await import(${JSON.stringify(pathToFileURL(path.join(record.installPath, "index.js")).href)})).default))`,
        ],
        { timeoutMs: 10_000 },
      );
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({
        host: "candidate",
        dependency: "preserved",
      });
      const copiedDependency = path.join(
        target,
        path.relative(source, modulesDir),
        "dependency",
        "index.js",
      );
      await fs.writeFile(copiedDependency, "changed in rehearsal");
      expect(await fs.readFile(path.join(dependency, "index.js"), "utf8")).toContain("preserved");
      expect(await fs.readFile(shared)).toEqual(before);
    } finally {
      copied.close();
    }
  },
);

it.each([
  { extension: "js", linked: false },
  { extension: "ts", linked: false },
  { extension: "js", linked: true },
  { extension: "js", linked: false, directoryAlias: true },
])(
  "preserves external .$extension entry imports and path identity (linked=$linked, directoryAlias=$directoryAlias)",
  async ({ extension, linked, directoryAlias = false }) => {
    const source = path.join(root, "source-state");
    const external = path.join(root, "external-plugin");
    const install = path.join(root, "installed-plugin");
    const sourcePackage = path.join(root, "source-plugin");
    for (const directory of [external, install, ...(linked ? [] : [sourcePackage])]) {
      await fs.mkdir(directory);
    }
    await fs.writeFile(path.join(external, "package.json"), '{"type":"module"}');
    await fs.writeFile(path.join(external, "adjacent.js"), 'export default "adjacent survived";');
    const dependency = path.join(external, "node_modules", "dependency");
    await fs.mkdir(dependency, { recursive: true });
    await fs.writeFile(
      path.join(dependency, "package.json"),
      '{"type":"module","exports":"./index.js"}',
    );
    await fs.writeFile(path.join(dependency, "index.js"), 'export default "dependency survived";');
    await fs.mkdir(path.join(external, "dist"));
    const realEntry = path.join(external, "dist", `plugin.${extension}`);
    let entry = realEntry;
    await fs.writeFile(
      realEntry,
      'import adjacent from "../adjacent.js"; import dependency from "dependency"; export default `${adjacent}:${dependency}`;',
    );
    await fs.writeFile(path.join(install, "marker"), "installed payload");
    if (linked) {
      await fs.symlink(install, sourcePackage, "junction");
      const aliasDirectory = path.join(root, "external-alias");
      if (process.platform === "win32") {
        await fs.symlink(path.dirname(realEntry), aliasDirectory, "junction");
        entry = path.join(aliasDirectory, path.basename(realEntry));
      } else {
        await fs.mkdir(aliasDirectory);
        entry = path.join(aliasDirectory, `public-name.${extension}`);
        await fs.symlink(realEntry, entry, "file");
      }
    } else {
      await fs.writeFile(path.join(sourcePackage, "marker"), "source payload");
    }
    if (directoryAlias) {
      const aliasDirectory = path.join(root, "directory-alias");
      await fs.symlink(path.dirname(realEntry), aliasDirectory, "junction");
      entry = path.join(aliasDirectory, path.basename(realEntry));
    }
    const registry = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: source } }).db;
    registry
      .prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?)",
      )
      .run(
        "plugins.installedIndex",
        JSON.stringify({ revision: 1, index: { installRecords: {} } }),
        1,
      );
    closeOpenClawStateDatabaseByPath(path.join(source, "state", "openclaw.sqlite"));
    const config: OpenClawConfig = {
      plugins: {
        load: { paths: [entry] },
        installs: { demo: { source: "path", installPath: install, sourcePath: sourcePackage } },
      },
    };
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config,
      stateDir: source,
      candidateRoot: root,
    });
    try {
      const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const copiedEntry = copied.plugins!.load!.paths![0]!;
      expect(path.basename(copiedEntry)).toBe(path.basename(entry));
      if (directoryAlias) {
        expect((await fs.lstat(copiedEntry)).isSymbolicLink()).toBe(false);
      }
      expect(copiedEntry.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
      const result = await runCommandBuffered(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `console.log((await import(${JSON.stringify(pathToFileURL(copiedEntry).href)})).default)`,
        ],
        { timeoutMs: 10_000 },
      );
      expect(result.code, result.stderr.toString()).toBe(0);
      expect(result.stdout.toString().trim()).toBe("adjacent survived:dependency survived");
      const record = copied.plugins!.installs!.demo!;
      expect(await fs.readFile(path.join(record.installPath!, "marker"), "utf8")).toBe(
        "installed payload",
      );
      expect(await fs.readFile(path.join(record.sourcePath!, "marker"), "utf8")).toBe(
        linked ? "installed payload" : "source payload",
      );
      expect(
        (await fs.realpath(record.installPath!)) === (await fs.realpath(record.sourcePath!)),
      ).toBe(linked);
      await fs.writeFile(path.join(record.sourcePath!, "marker"), "private change");
      expect(await fs.readFile(path.join(sourcePackage, "marker"), "utf8")).toBe(
        linked ? "installed payload" : "source payload",
      );
      expect(config.plugins!.load!.paths).toEqual([entry]);
      expect(config.plugins!.installs!.demo!.sourcePath).toBe(sourcePackage);
      expect(await rehearsal.changedConfigKeys()).toEqual([]);
    } finally {
      await rehearsal.cleanup();
    }
  },
);

it("preserves an existing copied file behind a case-equivalent entry name", async (context) => {
  const plugin = path.join(root, "case-plugin");
  await fs.mkdir(plugin);
  const lower = path.join(plugin, "entry.js");
  const upper = path.join(plugin, "ENTRY.js");
  const payload = 'export default "case alias survived";';
  await fs.writeFile(path.join(plugin, "package.json"), '{"type":"module"}');
  await fs.writeFile(lower, payload);
  const upperReal = await fs.realpath(upper).catch((error: unknown) => {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  if (upperReal !== (await fs.realpath(lower))) {
    context.skip("Requires a case-insensitive fixture volume with canonical filename casing");
  }
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: { plugins: { load: { paths: [upper] } } },
    stateDir: path.join(root, "source-state"),
    candidateRoot: root,
  });
  try {
    const copied: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
    const entry = copied.plugins!.load!.paths![0]!;
    expect(path.basename(entry)).toBe("ENTRY.js");
    const result = await runCommandBuffered(
      [
        process.execPath,
        "--input-type=module",
        "-e",
        `console.log((await import(${JSON.stringify(pathToFileURL(entry).href)})).default)`,
      ],
      { timeoutMs: 10_000 },
    );
    expect(result.code, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("case alias survived");
    expect((await fs.lstat(entry)).isFile()).toBe(true);
    expect(await fs.readFile(lower, "utf8")).toBe(payload);
    expect(await fs.readFile(upper, "utf8")).toBe(payload);
  } finally {
    await rehearsal.cleanup();
  }
});

it.each(["relative", "absolute", "external-store", "cycle"] as const)(
  "preserves pnpm transitive dependency topology in a private rehearsal (%s)",
  async (layout) => {
    const plugin = path.join(root, "local-plugin");
    const modules = path.join(plugin, "node_modules");
    const store =
      layout === "external-store" ? path.join(root, "virtual-store") : path.join(modules, ".pnpm");
    const foo = path.join(store, "foo@1.0.0", "node_modules", "foo");
    const bar = path.join(store, "bar@1.0.0", "node_modules", "bar");
    for (const [directory, name, code] of [
      [plugin, "plugin", 'import value from "foo"; export default value;'],
      [foo, "foo", 'import value from "bar"; export default `foo:${value}`;'],
      [bar, "bar", 'export default "bar";'],
    ]) {
      await fs.mkdir(directory!, { recursive: true });
      await fs.writeFile(
        path.join(directory!, "package.json"),
        JSON.stringify({ name, type: "module", exports: "./index.js" }),
      );
      await fs.writeFile(path.join(directory!, "index.js"), code!);
    }
    await fs.mkdir(modules, { recursive: true });
    if (layout === "external-store") {
      await fs.writeFile(
        path.join(modules, ".modules.yaml"),
        `virtualStoreDir: ${JSON.stringify(store)}\n`,
      );
    }
    const links = [
      [path.join(modules, "foo"), foo],
      [path.join(path.dirname(foo), "bar"), bar],
    ] as const;
    for (const [link, target] of links) {
      await fs.symlink(
        layout === "absolute" || process.platform === "win32"
          ? target
          : path.relative(path.dirname(link), target),
        link,
        "junction",
      );
    }
    if (layout === "cycle") {
      await fs.symlink(foo, path.join(path.dirname(bar), "foo"), "junction");
    }
    await fs.writeFile(
      path.join(foo, "cli.js"),
      'import value from "./index.js"; console.log(value);',
    );
    await fs.mkdir(path.join(modules, ".bin"));
    const launcher = path.join(modules, ".bin", "foo");
    await fs.writeFile(
      launcher,
      `#!/bin/sh\nbasedir=$(dirname "$0")\nexec "${process.execPath}" "$basedir/../foo/cli.js"\n`,
    );
    const originalLinks = await Promise.all(links.map(([link]) => fs.readlink(link)));
    const readPlugin = async (directory: string) => {
      const result = await runCommandBuffered(
        [
          process.execPath,
          "--input-type=module",
          "-e",
          `console.log((await import(${JSON.stringify(pathToFileURL(path.join(directory, "index.js")).href)})).default)`,
        ],
        { timeoutMs: 10_000 },
      );
      expect(result.code, result.stderr.toString()).toBe(0);
      return result.stdout.toString().trim();
    };
    expect(await readPlugin(plugin)).toBe("foo:bar");
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: { plugins: { load: { paths: [plugin] } } },
      stateDir: path.join(root, "source-state"),
      candidateRoot: root,
    });
    try {
      const config: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const copiedPlugin = config.plugins!.load!.paths![0]!;
      expect(await readPlugin(copiedPlugin)).toBe("foo:bar");
      if (process.platform !== "win32") {
        const result = await runCommandBuffered(
          ["/bin/sh", path.join(copiedPlugin, "node_modules", ".bin", "foo")],
          { timeoutMs: 10_000 },
        );
        expect(result.code, result.stderr.toString()).toBe(0);
        expect(result.stdout.toString().trim()).toBe("foo:bar");
      }
      const copiedFoo = await fs.realpath(path.join(copiedPlugin, "node_modules", "foo"));
      const copiedBar = await fs.realpath(path.join(path.dirname(copiedFoo), "bar"));
      expect(copiedBar.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
      await fs.writeFile(path.join(copiedBar, "index.js"), 'export default "changed";');
      expect(await readPlugin(copiedPlugin)).toBe("foo:changed");
      expect(await readPlugin(plugin)).toBe("foo:bar");
      expect(await Promise.all(links.map(([link]) => fs.readlink(link)))).toEqual(originalLinks);
    } finally {
      await rehearsal.cleanup();
    }
  },
);

it.skipIf(process.platform === "win32")(
  "copies an external file link without traversing unrelated siblings",
  async () => {
    const plugin = path.join(root, "plugin");
    const assets = path.join(root, "assets");
    await fs.mkdir(plugin);
    await fs.mkdir(assets);
    await fs.writeFile(path.join(plugin, "package.json"), '{"name":"plugin"}');
    const source = path.join(assets, "config.txt");
    await fs.writeFile(source, "preserved");
    await fs.symlink(path.join(root, "missing-unrelated-target"), path.join(assets, "unrelated"));
    await fs.symlink(source, path.join(plugin, "config.txt"));
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: { plugins: { load: { paths: [plugin] } } },
      stateDir: path.join(root, "source-state"),
      candidateRoot: root,
    });
    try {
      const config: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const copied = path.join(config.plugins!.load!.paths![0]!, "config.txt");
      expect(await fs.readFile(copied, "utf8")).toBe("preserved");
      await fs.writeFile(copied, "private");
      expect(await fs.readFile(source, "utf8")).toBe("preserved");
      expect(await fs.readlink(path.join(plugin, "config.txt"))).toBe(source);
    } finally {
      await rehearsal.cleanup();
    }
  },
);

it.each([
  { alias: false, shadow: false, linkedModules: false, sharedOrder: "none" },
  { alias: true, shadow: false, linkedModules: false, sharedOrder: "none" },
  { alias: false, shadow: true, linkedModules: false, sharedOrder: "none" },
  { alias: false, shadow: false, linkedModules: true, sharedOrder: "none" },
  { alias: false, shadow: false, linkedModules: false, sharedOrder: "owner-first" },
  { alias: false, shadow: false, linkedModules: false, sharedOrder: "owner-last" },
])(
  "preserves declared workspace hoists without copying repository files (alias=$alias, shadow=$shadow, linkedModules=$linkedModules, sharedOrder=$sharedOrder)",
  async ({ alias, shadow, linkedModules, sharedOrder }) => {
    const repo = path.join(root, "workspace");
    const plugin = path.join(repo, "packages", "demo");
    const shared = sharedOrder !== "none";
    const sharedOwner = path.join(repo, "packages", "owner");
    const modules = shared
      ? path.join(sharedOwner, "cache")
      : linkedModules
        ? path.join(root, "external-modules")
        : path.join(repo, "node_modules");
    const dependency = path.join(modules, "@demo", "dependency");
    const liveHost = shared ? path.join(modules, "openclaw") : path.join(root, "live-host");
    const sourceHostLink = path.join(shared ? plugin : repo, "node_modules", "openclaw");
    const candidateHost = path.join(root, "candidate-host");
    const expected = shadow ? "nearest" : "hoisted";
    await fs.mkdir(plugin, { recursive: true });
    await fs.mkdir(dependency, { recursive: true });
    if (shared) {
      await fs.symlink(modules, path.join(plugin, "node_modules"), "junction");
      await fs.writeFile(
        path.join(sharedOwner, "package.json"),
        '{"name":"owner","type":"module"}',
      );
      await fs.writeFile(
        path.join(sharedOwner, "index.js"),
        'console.log(JSON.stringify({value:"owner",host:"owner",dependency:import.meta.url}));',
      );
    } else if (linkedModules) {
      await fs.symlink(modules, path.join(repo, "node_modules"), "junction");
    }
    for (const [directory, value] of [
      [liveHost, "serving"],
      [candidateHost, "candidate"],
    ] as const) {
      await fs.mkdir(directory);
      await fs.writeFile(
        path.join(directory, "package.json"),
        JSON.stringify({ name: "openclaw", type: "module", exports: "./index.js" }),
      );
      await fs.writeFile(
        path.join(directory, "index.js"),
        `export default ${JSON.stringify(value)};`,
      );
    }
    if (!shared) {
      await fs.symlink(liveHost, sourceHostLink, "junction");
    }
    await fs.writeFile(
      path.join(repo, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    await fs.writeFile(path.join(repo, "unrelated.txt"), "do not copy repository files");
    await fs.writeFile(
      path.join(plugin, "package.json"),
      JSON.stringify({
        name: "demo",
        version: "1.0.0",
        type: "module",
        dependencies: { "@demo/dependency": "1.0.0" },
        optionalDependencies: { absent: "1.0.0" },
        peerDependencies: { openclaw: "*" },
      }),
    );
    await fs.writeFile(
      path.join(plugin, "index.js"),
      'import value from "@demo/dependency"; import host from "openclaw"; console.log(JSON.stringify({value, host, dependency: import.meta.resolve("@demo/dependency")}));',
    );
    await fs.writeFile(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "@demo/dependency",
        version: "1.0.0",
        type: "module",
        exports: "./index.js",
      }),
    );
    await fs.writeFile(path.join(dependency, "index.js"), 'export default "hoisted";');
    if (shadow) {
      const nearest = path.join(plugin, "node_modules", "@demo", "dependency");
      await fs.cp(dependency, nearest, { recursive: true });
      await fs.writeFile(path.join(nearest, "index.js"), 'export default "nearest";');
    }
    const locator = alias ? path.join(root, "linked-demo") : plugin;
    if (alias) {
      await fs.symlink(plugin, locator, "junction");
    }
    const readPlugin = async (directory: string) => {
      const result = await runCommandBuffered(
        [process.execPath, path.join(directory, "index.js")],
        { timeoutMs: 10_000 },
      );
      expect(result.code, result.stderr.toString()).toBe(0);
      return JSON.parse(result.stdout.toString()) as {
        value: string;
        dependency: string;
        host: string;
      };
    };
    expect(await readPlugin(locator)).toMatchObject({ value: expected, host: "serving" });
    const paths = !shared
      ? [locator]
      : sharedOrder === "owner-first"
        ? [sharedOwner, locator]
        : [locator, sharedOwner];
    if (shared) {
      expect((await readPlugin(sharedOwner)).value).toBe("owner");
    }
    const rehearsal = await prepareUpdateCandidateRehearsal({
      config: { plugins: { load: { paths } } },
      stateDir: path.join(root, "source-state"),
      candidateRoot: candidateHost,
    });
    try {
      const config: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
      const copied = config.plugins!.load!.paths![paths.indexOf(locator)]!;
      if (shared) {
        expect(
          (await readPlugin(config.plugins!.load!.paths![paths.indexOf(sharedOwner)]!)).value,
        ).toBe("owner");
      }
      expect(path.basename(copied)).toBe(path.basename(locator));
      const result = await readPlugin(copied);
      expect(result).toMatchObject({ value: expected, host: "candidate" });
      const copiedDependency = await fs.realpath(fileURLToPath(result.dependency));
      expect(copiedDependency.startsWith(rehearsal.stateDir + path.sep)).toBe(true);
      expect(
        (await fs.readdir(rehearsal.stateDir, { recursive: true })).some(
          (entry) => path.basename(entry) === "unrelated.txt",
        ),
      ).toBe(false);
      await fs.writeFile(copiedDependency, 'export default "private";');
      expect((await readPlugin(copied)).value).toBe("private");
      expect((await readPlugin(locator)).value).toBe(expected);
      expect(await fs.realpath(sourceHostLink)).toBe(liveHost);
      if (alias) {
        expect(await fs.realpath(locator)).toBe(plugin);
      }
    } finally {
      await rehearsal.cleanup();
    }
  },
);

it("projects through an aliased temporary state directory without changing source links", async () => {
  const source = path.join(root, "source");
  const plugin = path.join(source, "extensions", "demo");
  const dependency = path.join(root, "dependency");
  const physical = path.join(root, "physical-state");
  const alias = path.join(root, "state-alias");
  await fs.mkdir(path.join(plugin, "node_modules"), { recursive: true });
  await fs.mkdir(dependency);
  await fs.mkdir(physical);
  await fs.symlink(physical, alias, "junction");
  await fs.writeFile(path.join(plugin, "package.json"), '{"name":"demo"}');
  await fs.writeFile(path.join(dependency, "package.json"), '{"name":"dependency"}');
  await fs.writeFile(path.join(dependency, "value.txt"), "source");
  await fs.symlink(dependency, path.join(plugin, "node_modules", "dependency"), "junction");
  const paths = await projectUpdateCandidatePlugins({
    config: { plugins: { load: { paths: [plugin] } } },
    stateDir: source,
    targetStateDir: path.join(alias, "candidate"),
    candidateRoot: root,
  });
  const copied = path.join(paths[plugin]!, "node_modules", "dependency", "value.txt");
  expect((await fs.realpath(copied)).startsWith(physical + path.sep)).toBe(true);
  await fs.writeFile(copied, "private");
  expect(await fs.readFile(path.join(dependency, "value.txt"), "utf8")).toBe("source");
  expect(await fs.realpath(path.join(plugin, "node_modules", "dependency"))).toBe(dependency);
});

it("keeps an optional-only linked node_modules copy bounded to its module owner", async () => {
  const repo = path.join(root, "repository");
  const plugin = path.join(repo, "plugin");
  const modules = path.join(repo, "external-modules");
  await fs.mkdir(plugin, { recursive: true });
  await fs.mkdir(modules);
  await fs.writeFile(path.join(repo, "package.json"), '{"private":true}');
  await fs.writeFile(path.join(repo, "unrelated.txt"), "repository data");
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: "demo", type: "module", optionalDependencies: { missing: "1.0.0" } }),
  );
  await fs.writeFile(path.join(plugin, "index.js"), 'console.log("optional plugin ready");');
  await fs.writeFile(path.join(modules, "marker.txt"), "source");
  await fs.symlink(modules, path.join(plugin, "node_modules"), "junction");
  const readEntry = async (directory: string) => {
    const result = await runCommandBuffered([process.execPath, path.join(directory, "index.js")], {
      timeoutMs: 10_000,
    });
    expect(result.code, result.stderr.toString()).toBe(0);
    return result.stdout.toString().trim();
  };
  expect(await readEntry(plugin)).toBe("optional plugin ready");
  const rehearsal = await prepareUpdateCandidateRehearsal({
    config: { plugins: { load: { paths: [plugin] } } },
    stateDir: path.join(root, "source-state"),
    candidateRoot: root,
  });
  try {
    const config: OpenClawConfig = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8"));
    const copied = config.plugins!.load!.paths![0]!;
    expect(await readEntry(copied)).toBe("optional plugin ready");
    expect(
      (await fs.readdir(rehearsal.stateDir, { recursive: true })).some(
        (entry) => path.basename(entry) === "unrelated.txt",
      ),
    ).toBe(false);
    const marker = path.join(copied, "node_modules", "marker.txt");
    expect((await fs.realpath(marker)).startsWith(rehearsal.stateDir + path.sep)).toBe(true);
    await fs.writeFile(marker, "private");
    expect(await fs.readFile(path.join(modules, "marker.txt"), "utf8")).toBe("source");
    expect(await fs.realpath(path.join(plugin, "node_modules"))).toBe(modules);
  } finally {
    await rehearsal.cleanup();
  }
});

it("rejects an ordinary link that would repeatedly copy an immutable host package", async () => {
  const plugin = path.join(root, "plugin");
  const host = path.join(root, "live-host");
  const candidate = path.join(root, "candidate-host");
  await fs.mkdir(path.join(plugin, "node_modules"), { recursive: true });
  await fs.mkdir(path.join(host, "docs"), { recursive: true });
  await fs.mkdir(candidate);
  await fs.writeFile(
    path.join(plugin, "package.json"),
    JSON.stringify({ name: "demo", type: "module", peerDependencies: { openclaw: "*" } }),
  );
  await fs.writeFile(
    path.join(host, "package.json"),
    JSON.stringify({ name: "openclaw", type: "module", exports: "./index.js" }),
  );
  await fs.writeFile(path.join(host, "index.js"), 'export default "serving";');
  await fs.writeFile(
    path.join(plugin, "index.js"),
    'import host from "openclaw"; console.log(host);',
  );
  await fs.writeFile(path.join(host, "docs", "marker.txt"), "source");
  await fs.symlink(host, path.join(plugin, "node_modules", "openclaw"), "junction");
  await fs.symlink(path.join(host, "docs"), path.join(plugin, "manual"), "junction");
  const source = await runCommandBuffered([process.execPath, path.join(plugin, "index.js")], {
    timeoutMs: 10_000,
  });
  expect(source.code, source.stderr.toString()).toBe(0);
  expect(source.stdout.toString().trim()).toBe("serving");
  await expect(
    prepareUpdateCandidateRehearsal({
      config: { plugins: { load: { paths: [plugin] } } },
      stateDir: path.join(root, "source-state"),
      candidateRoot: candidate,
      timeoutMs: 10_000,
    }),
  ).rejects.toThrow("Cannot privately copy host-owned plugin link");
  expect(await fs.readFile(path.join(host, "docs", "marker.txt"), "utf8")).toBe("source");
  expect(await fs.realpath(path.join(plugin, "node_modules", "openclaw"))).toBe(host);
}, 20_000);
