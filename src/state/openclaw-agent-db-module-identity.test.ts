import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";
import { spawnNodeEvalSync } from "../test-utils/node-process.js";

it("shares agent ownership, savepoints, and commit observers across transformed SDK modules", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-module-")));
  const repo = process.cwd();
  const dist = path.join(root, "dist");
  const source = (relativePath: string) => JSON.stringify(path.join(repo, relativePath));
  const ownerExports = `
    export {
      openOpenClawAgentDatabase, closeOpenClawAgentDatabaseByPath,
      closeOpenClawAgentDatabases, runOpenClawAgentWriteTransaction,
      deferOpenClawAgentPostCommitPublication,
      listOpenClawRegisteredAgentDatabases, readOpenClawAgentDatabaseRegistryToken,
    } from ${source("src/state/openclaw-agent-db.ts")};
    export { closeOpenClawStateDatabase } from ${source("src/state/openclaw-state-db.ts")};
  `;
  try {
    fs.mkdirSync(dist);
    fs.symlinkSync(path.join(repo, "node_modules"), path.join(root, "node_modules"), "junction");
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(root, "config.json"), "{}\n");
    fs.writeFileSync(
      path.join(root, "host.ts"),
      `${ownerExports}
       export { getCachedPluginModuleLoader } from ${source("src/plugins/plugin-module-loader-cache.ts")};`,
    );
    fs.writeFileSync(
      path.join(root, "sqlite-runtime.ts"),
      `${ownerExports}\nexport * from ${source("src/plugin-sdk/sqlite-runtime.ts")};`,
    );
    fs.writeFileSync(
      path.join(root, "plugin.ts"),
      'export * from "openclaw/plugin-sdk/sqlite-runtime";\n',
    );
    // A shared chunk models the packaged host/SDK graph; the supported plugin
    // transform then evaluates its own module graph within the same process.
    await build({
      absWorkingDir: repo,
      entryPoints: {
        host: path.join(root, "host.ts"),
        "sqlite-runtime": path.join(root, "sqlite-runtime.ts"),
      },
      bundle: true,
      splitting: true,
      packages: "external",
      platform: "node",
      format: "esm",
      outdir: dist,
      tsconfig: path.join(repo, "tsconfig.json"),
      logLevel: "silent",
    });
    for (const schema of ["openclaw-agent-schema.sql", "openclaw-state-schema.sql"]) {
      fs.copyFileSync(path.join(repo, "src/state", schema), path.join(dist, schema));
    }
    const result = spawnNodeEvalSync(
      String.raw`
        import assert from "node:assert/strict";
        import path from "node:path";
        import { createRequire, syncBuiltinESMExports } from "node:module";
        const root = ${JSON.stringify(root)};
        const agentPath = path.join(process.env.OPENCLAW_STATE_DIR, "agents", "main", "agent", "openclaw-agent.sqlite");
        const options = { agentId: "main", path: agentPath };
        const sqlite = createRequire(import.meta.url)("node:sqlite");
        const OriginalDatabase = sqlite.DatabaseSync;
        const opened = [];
        let physicalOpens = 0;
        let integrityScans = 0;
        sqlite.DatabaseSync = class extends OriginalDatabase {
          constructor(...args) {
            super(...args);
            const [location] = args;
            this.observedAgent = location === path.toNamespacedPath(agentPath);
            if (this.observedAgent) physicalOpens += 1;
            opened.push(this);
          }
          prepare(sql) {
            if (this.observedAgent) this.queryPrepares = (this.queryPrepares ?? 0) + 1;
            const statement = super.prepare(sql);
            if (this.observedAgent && /\b(?:integrity_check|quick_check)\b/i.test(sql)) {
              for (const operation of ["get", "all", "run", "iterate"]) {
                const original = statement[operation].bind(statement);
                statement[operation] = (...args) => {
                  integrityScans += 1;
                  return original(...args);
                };
              }
            }
            return statement;
          }
        };
        syncBuiltinESMExports();
        let host;
        let plugin;
        let borrowed;
        try {
          host = await import(${JSON.stringify(pathToFileURL(path.join(dist, "host.js")).href)});
          const nativeSdk = await import(${JSON.stringify(pathToFileURL(path.join(dist, "sqlite-runtime.js")).href)});
          const canonical = host.openOpenClawAgentDatabase(options);
          const nativeBorrow = nativeSdk.borrowOpenClawAgentDatabase(options);
          assert.equal(nativeBorrow.db === canonical.db, true, "native SDK control shares host owner");
          nativeBorrow.release();
          assert.equal(physicalOpens, 1);
          assert.equal(integrityScans, 1);
          const modulePath = path.join(root, "plugin.ts");
          plugin = host.getCachedPluginModuleLoader({
            modulePath, rootDir: root, importerUrl: import.meta.url, tryNative: false,
            transformOpenClawDependencies: true,
            aliasMap: { "openclaw/plugin-sdk/sqlite-runtime": path.join(root, "dist/sqlite-runtime.js") },
          })(modulePath);
          borrowed = plugin.borrowOpenClawAgentDatabase(options);
          assert.equal(physicalOpens, 1, "transformed borrowing must not physically reopen the agent database");
          assert.equal(integrityScans, 1, "transformed borrowing must not repeat integrity validation");
          assert.equal(borrowed.db === canonical.db, true, "transformed SDK shares the exact owner connection");
          assert.equal(nativeSdk.getNodeSqliteKysely(canonical.db) === plugin.getNodeSqliteKysely(canonical.db), true,
            "native and transformed queries share the connection cache lifecycle");

          const db = canonical.db;
          db.exec("CREATE TABLE module_identity_entries (id TEXT PRIMARY KEY)");
          const query = nativeSdk.getNodeSqliteKysely(db).selectFrom("module_identity_entries").select("id");
          const preparesBefore = db.queryPrepares;
          for (const sdk of [nativeSdk, nativeSdk, plugin, plugin]) {
            assert.deepEqual(sdk.executeSqliteQuerySync(db, query).rows, []);
          }
          assert.equal(db.queryPrepares - preparesBefore, 2,
            "transformed queries reuse the owner's admitted statement cache");
          const rows = () => db.prepare("SELECT id FROM module_identity_entries ORDER BY id").all().map(row => row.id);
          const insert = id => db.prepare("INSERT INTO module_identity_entries VALUES (?)").run(id);
          const publications = [];
          const publish = id => {
            assert.equal(db.isTransaction, false, "observers run after the outer commit");
            assert.deepEqual(rows(), ["committed", "outer"]);
            publications.push(id);
          };
          host.runOpenClawAgentWriteTransaction(() => {
            insert("outer");
            assert.equal(plugin.deferOpenClawAgentPostCommitPublication(canonical, () => publish("outer")), true);
            plugin.runOpenClawAgentWriteTransaction(() => {
              insert("committed");
              assert.equal(host.deferOpenClawAgentPostCommitPublication(canonical, () => publish("committed")), true);
              assert.throws(() => host.runOpenClawAgentWriteTransaction(() => {
                insert("discarded");
                assert.equal(plugin.deferOpenClawAgentPostCommitPublication(canonical, () => publish("discarded")), true);
                throw new Error("inner rollback");
              }, options), /inner rollback/);
            }, options);
            assert.deepEqual(publications, [], "successful savepoints do not publish early");
          }, options);
          assert.deepEqual(rows(), ["committed", "outer"]);
          assert.deepEqual(publications, ["outer", "committed"]);
          assert.throws(() => plugin.runOpenClawAgentWriteTransaction(() => {
            host.runOpenClawAgentWriteTransaction(() => {
              insert("rolled-back-outer");
              assert.equal(host.deferOpenClawAgentPostCommitPublication(canonical, () => publish("rolled-back-outer")), true);
            }, options);
            throw new Error("outer rollback");
          }, options), /outer rollback/);
          assert.deepEqual(rows(), ["committed", "outer"]);
          assert.deepEqual(publications, ["outer", "committed"]);

          assert.deepEqual(host.listOpenClawRegisteredAgentDatabases().map(entry => entry.agentId), ["main"]);
          const registryToken = host.readOpenClawAgentDatabaseRegistryToken();
          const hotOptions = {
            agentId: "hot-created",
            path: path.join(process.env.OPENCLAW_STATE_DIR, "agents", "hot-created", "agent", "openclaw-agent.sqlite"),
          };
          const hotBorrow = plugin.borrowOpenClawAgentDatabase(hotOptions);
          assert.equal(host.openOpenClawAgentDatabase(hotOptions).db === hotBorrow.db, true);
          hotBorrow.release();
          assert.notEqual(host.readOpenClawAgentDatabaseRegistryToken(), registryToken,
            "transformed registration invalidates native discovery");
          assert.deepEqual(host.listOpenClawRegisteredAgentDatabases().map(entry => entry.agentId), ["hot-created", "main"]);

          borrowed.release();
          assert.equal(db.isOpen, true, "borrow release leaves disposal with the host");
          borrowed = plugin.borrowOpenClawAgentDatabase(options);
          assert.equal(host.closeOpenClawAgentDatabaseByPath(agentPath), true);
          assert.equal(borrowed.db.isOpen, false, "explicit owner disposal revokes retained borrowers");
        } finally {
          borrowed?.release();
          plugin?.closeOpenClawAgentDatabases();
          host?.closeOpenClawAgentDatabases();
          plugin?.closeOpenClawStateDatabase();
          host?.closeOpenClawStateDatabase();
          for (const db of opened) if (db.isOpen) db.close();
          sqlite.DatabaseSync = OriginalDatabase;
          syncBuiltinESMExports();
        }
      `,
      {
        timeout: 30_000,
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: root,
          USERPROFILE: root,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
          XDG_CACHE_HOME: path.join(root, "cache"),
          JITI_FS_CACHE: "0",
        },
      },
    );
    expect(result.status, result.stderr || result.error?.message).toBe(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 45_000);
