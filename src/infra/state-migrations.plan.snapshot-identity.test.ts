import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  registerSealedRuntimeProcessEntrypoint,
  resolveRuntimeProcessEntrypointUrl,
} from "./runtime-process-url.js";
import { planLegacyStateMigrationsReadOnly } from "./state-migrations.doctor.js";
import {
  captureLegacyStateSnapshotIdentity,
  readLegacyStateMigrationPlanConfig,
} from "./state-migrations.plan.js";
import { captureLegacyStateSnapshotIdentityInProcess } from "./state-migrations.snapshot.worker.js";

const tempDirs = createTrackedTempDirs();

async function makeFixture() {
  const root = await tempDirs.make("openclaw-migration-snapshot-identity-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "copied-state");
  const configPath = path.join(root, "copied-openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath, "{}\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  return { root, homeDir, stateDir, configPath, env };
}

async function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>) {
  return planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root: fixture.root, version: "test" },
    snapshot: {
      homeDir: fixture.homeDir,
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
    },
    env: fixture.env,
  });
}

afterEach(async () => {
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration snapshot identity", () => {
  it("captures accepted config include identities larger than OS argument limits", async () => {
    const fixture = await makeFixture();
    const includeDir = path.join(fixture.root, "a".repeat(180), "b".repeat(180), "c".repeat(180));
    fs.mkdirSync(includeDir, { recursive: true });
    const paths = Array.from({ length: 2300 }, (_, index) =>
      path.join(includeDir, `${index}.json`),
    );
    for (const pathname of paths) {
      fs.writeFileSync(pathname, "{}\n");
    }
    fs.writeFileSync(
      fixture.configPath,
      JSON.stringify({ $include: paths.map((pathname) => path.relative(fixture.root, pathname)) }),
    );
    const config = await readLegacyStateMigrationPlanConfig(fixture);
    expect(config.warnings).toEqual([]);
    expect(config.configInputHashes?.includes).toHaveLength(paths.length);
    const params = {
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
      configInputHashes: config.configInputHashes,
    };
    expect(Buffer.byteLength(JSON.stringify(params))).toBeGreaterThan(1024 * 1024);

    const identity = await captureLegacyStateSnapshotIdentity(params);

    expect(identity.warnings).toEqual([]);
    expect(identity.configDigest).toBe(config.rootDigest);
    expect(identity.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    fs.writeFileSync(
      path.join(includeDir, "0.json"),
      '{"agents":{"defaults":{"workspace":"./changed"}}}\n',
    );
    const changed = await captureLegacyStateSnapshotIdentity(params);
    expect(changed.configDigest).toBeUndefined();
    expect(changed.warnings).toEqual([
      expect.stringContaining("Snapshot config input changed while planning:"),
    ]);
  });

  it("refuses unavailable snapshot workers without falling back to caller-process hashing", async () => {
    const fixture = await makeFixture();
    const original = resolveRuntimeProcessEntrypointUrl("stateMigrationSnapshot");
    registerSealedRuntimeProcessEntrypoint(
      "stateMigrationSnapshot",
      pathToFileURL(path.join(fixture.root, "missing-worker.js")),
    );
    try {
      const refused = await planFixture(fixture);
      expect(refused.refusal?.code).toBe("snapshot-identity-unavailable");
      expect(refused.snapshot.stateDigest).toBeUndefined();
      expect(refused.steps).toEqual([]);
      expect(refused.warnings).toEqual([
        expect.stringContaining("Could not bind copied snapshot:"),
      ]);
    } finally {
      registerSealedRuntimeProcessEntrypoint("stateMigrationSnapshot", original);
    }
    const restored = await planFixture(fixture);
    expect(restored.refusal?.code).toBe("candidate-artifact-digest-required");
    expect(restored.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it.each([
    "file-content",
    "file-replacement",
    "nested-entry",
    "unchanged",
    "config-content",
    "config-replacement",
    "included-config",
    "included-unchanged",
  ] as const)(
    "revalidates earlier entries at the snapshot worker's final traversal: %s",
    async (mutation) => {
      const fixture = await makeFixture();
      const earlyDirectory = path.join(fixture.stateDir, "a-directory");
      const earlyFile = path.join(earlyDirectory, "probe.json");
      const lateFile = path.join(fixture.stateDir, "z-probe.json");
      fs.mkdirSync(earlyDirectory);
      fs.writeFileSync(earlyFile, '{"value":"original"}\n');
      fs.writeFileSync(lateFile, "{}\n");
      const includedPath = path.join(fixture.root, "planner-input.json");
      if (mutation === "included-config" || mutation === "included-unchanged") {
        fs.writeFileSync(fixture.configPath, '{"$include":"./planner-input.json"}\n');
        fs.writeFileSync(includedPath, "{}\n");
      }
      const config = await readLegacyStateMigrationPlanConfig(fixture);
      expect(config.configInputHashes).toBeDefined();
      const realOpen = fs.promises.open.bind(fs.promises);
      let finalCaptureReached = false;
      vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
        const handle = await realOpen(...args);
        if (path.resolve(String(args[0])) === lateFile) {
          finalCaptureReached = true;
          if (mutation === "file-content") {
            fs.writeFileSync(earlyFile, '{"value":"changed"}\n');
          } else if (mutation === "file-replacement") {
            fs.unlinkSync(earlyFile);
            fs.writeFileSync(earlyFile, '{"value":"replacement"}\n');
          } else if (mutation === "nested-entry") {
            fs.writeFileSync(path.join(earlyDirectory, "added.json"), "{}\n");
          } else if (mutation === "config-content" || mutation === "config-replacement") {
            if (mutation === "config-replacement") {
              fs.unlinkSync(fixture.configPath);
            }
            fs.writeFileSync(
              fixture.configPath,
              '{"agents":{"defaults":{"workspace":"./changed"}}}\n',
            );
          } else if (mutation === "included-config") {
            fs.writeFileSync(includedPath, '{"agents":{"defaults":{"workspace":"./changed"}}}\n');
          }
        }
        return handle;
      });

      const identity = await captureLegacyStateSnapshotIdentityInProcess({
        ...fixture,
        configInputHashes: config.configInputHashes,
      });

      expect(finalCaptureReached).toBe(true);
      if (mutation === "unchanged" || mutation === "included-unchanged") {
        expect(identity.warnings).toEqual([]);
        expect(identity.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(fs.readFileSync(earlyFile, "utf8")).toBe('{"value":"original"}\n');
      } else {
        expect(identity.configDigest).toBeUndefined();
        expect(identity.stateDigest).toBeUndefined();
        if (mutation === "nested-entry") {
          // A child addition can leave directory metadata unchanged at the
          // filesystem's observed precision; the final child-list check still refuses it.
          expect(identity.warnings).toHaveLength(1);
          expect([
            `Could not bind copied snapshot: Snapshot entry changed while hashing: ${earlyDirectory}`,
            `Could not bind copied snapshot: Snapshot directory changed while hashing: ${earlyDirectory}`,
          ]).toContain(identity.warnings[0]);
        } else {
          expect(identity.warnings).toEqual([
            expect.stringContaining("Snapshot entry changed while hashing:"),
          ]);
        }
      }
    },
  );

  it("refuses an ordinary file replaced between tree inspection and open", async () => {
    const fixture = await makeFixture();
    const probePath = path.join(fixture.stateDir, "identity-probe.json");
    const originalPath = `${probePath}.original`;
    fs.writeFileSync(probePath, '{"value":"original"}\n');
    const realOpen = fs.promises.open.bind(fs.promises);
    let replacementTriggered = false;
    vi.spyOn(fs.promises, "open").mockImplementation(async (...args) => {
      if (!replacementTriggered && path.resolve(String(args[0])) === probePath) {
        replacementTriggered = true;
        fs.renameSync(probePath, originalPath);
        fs.writeFileSync(probePath, '{"value":"replacement"}\n');
      }
      return realOpen(...args);
    });

    try {
      const identity = await captureLegacyStateSnapshotIdentityInProcess(fixture);
      expect(replacementTriggered).toBe(true);
      expect(identity.stateDigest).toBeUndefined();
      expect(identity.warnings).toEqual([
        expect.stringContaining(`Snapshot file changed while opening: ${probePath}`),
      ]);
    } finally {
      if (replacementTriggered) {
        fs.unlinkSync(probePath);
        fs.renameSync(originalPath, probePath);
      }
    }
  });

  it.each([
    ["DELETE", "held.sqlite"],
    ["WAL", "held.sqlite"],
    ["DELETE", "state/openclaw.sqlite"],
    ["WAL", "state/openclaw.sqlite"],
  ])(
    "preserves a caller-held %s read transaction on %s through the complete planner",
    async (journalMode, relativePath) => {
      const fixture = await makeFixture();
      const databasePath = path.join(fixture.stateDir, relativePath);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      const database = new DatabaseSync(databasePath);
      const compete = () => {
        const child = spawnSync(
          process.execPath,
          [
            "-e",
            `const { DatabaseSync } = require('node:sqlite');
             const database = new DatabaseSync(process.argv[1]);
             try {
               database.exec('PRAGMA busy_timeout=0;');
               if (process.argv[2] === 'WAL') {
                 console.log(JSON.stringify({ blocked: database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy === 1 }));
               } else {
                 database.exec('BEGIN EXCLUSIVE; ROLLBACK;');
                 console.log(JSON.stringify({ blocked: false }));
               }
             } catch (error) {
               if (error.errcode !== 5) throw error;
               console.log(JSON.stringify({ blocked: true }));
             } finally { database.close(); }`,
            databasePath,
            journalMode,
          ],
          { encoding: "utf8" },
        );
        expect(child.error).toBeUndefined();
        expect(child.signal).toBeNull();
        expect(child.status, child.stderr).toBe(0);
        return JSON.parse(child.stdout);
      };
      try {
        database.exec(
          `PRAGMA journal_mode=${journalMode}; PRAGMA wal_autocheckpoint=0;
           CREATE TABLE held(value TEXT); INSERT INTO held VALUES ('original'); BEGIN;`,
        );
        expect(database.prepare("SELECT value FROM held").all()).toEqual([{ value: "original" }]);
        if (journalMode === "WAL") {
          const writer = new DatabaseSync(databasePath);
          try {
            writer.exec("INSERT INTO held VALUES ('later');");
          } finally {
            writer.close();
          }
        }
        expect(compete()).toEqual({ blocked: true });

        const plan = await planFixture(fixture);

        expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
        expect(plan.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(compete()).toEqual({ blocked: true });
        expect(database.prepare("SELECT value FROM held").all()).toEqual([{ value: "original" }]);
      } finally {
        database.close();
      }
      expect(compete()).toEqual({ blocked: false });
    },
  );

  it("binds in-snapshot hard-link topology", async () => {
    const fixture = await makeFixture();
    const firstPath = path.join(fixture.stateDir, "first.json");
    const secondPath = path.join(fixture.stateDir, "second.json");
    fs.writeFileSync(firstPath, '{"value":"same"}\n');
    fs.writeFileSync(secondPath, '{"value":"same"}\n');
    const independent = await planFixture(fixture);

    fs.unlinkSync(secondPath);
    fs.linkSync(firstPath, secondPath);
    const linked = await planFixture(fixture);

    expect(independent.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(linked.snapshot.stateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(linked.snapshot.stateDigest).not.toBe(independent.snapshot.stateDigest);
  });

  it("refuses a snapshot file with an unbound external hard link", async () => {
    const fixture = await makeFixture();
    const externalPath = path.join(fixture.root, "external.json");
    const linkedPath = path.join(fixture.stateDir, "linked.json");
    fs.writeFileSync(externalPath, '{"value":"shared"}\n');
    fs.linkSync(externalPath, linkedPath);

    const plan = await planFixture(fixture);

    expect(plan.snapshot.stateDigest).toBeUndefined();
    expect(plan.warnings).toEqual([
      expect.stringContaining(`Snapshot file has links outside copied state: ${linkedPath}`),
    ]);
  });
});
