import { createHash } from "node:crypto";
import fs from "node:fs";
import { endianness } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createAppliedLegacyProposal } from "../commands/doctor-skill-workshop-sqlite.test-support.js";
import { importLegacySkillProposal } from "../skills/workshop/store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { planLegacyStateMigrationsReadOnly } from "./state-migrations.doctor.js";
import { captureLegacyStateSnapshotIdentity } from "./state-migrations.plan.js";

const tempDirs = createTrackedTempDirs();

function sha256(value: string | Buffer): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeWalIndexHeaderChecksum(header: Buffer): void {
  const readUint32 = (offset: number) =>
    endianness() === "LE" ? header.readUInt32LE(offset) : header.readUInt32BE(offset);
  let first = 0;
  let second = 0;
  for (let offset = 0; offset < 40; offset += 8) {
    first = (first + readUint32(offset) + second) >>> 0;
    second = (second + readUint32(offset + 4) + first) >>> 0;
  }
  if (endianness() === "LE") {
    header.writeUInt32LE(first, 40);
    header.writeUInt32LE(second, 44);
  } else {
    header.writeUInt32BE(first, 40);
    header.writeUInt32BE(second, 44);
  }
}

async function makeFixture() {
  const root = await tempDirs.make("openclaw-migration-plan-identity-");
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

async function planFixture(fixture: Awaited<ReturnType<typeof makeFixture>>, stateDigest?: string) {
  return planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: { root: fixture.root, version: "test" },
    snapshot: {
      homeDir: fixture.homeDir,
      configPath: fixture.configPath,
      stateDir: fixture.stateDir,
      ...(stateDigest ? { stateDigest } : {}),
    },
    env: fixture.env,
  });
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("legacy state migration plan identity", () => {
  it("defers the Workshop owner without adopting its external recorded targets", async () => {
    const fixture = await makeFixture();
    const skillDir = path.join(fixture.root, "external-workspace", "skills", "retained");
    const content = "---\nname: retained\ndescription: Retained skill\n---\n\n# Retained\n";
    const record = createAppliedLegacyProposal({
      id: "retained-workshop-20260905-1234567890",
      title: "Retained skill",
      description: "Retained skill",
      content,
      target: { skillKey: "retained", skillDir },
    });
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(record.target.skillFile, content);
    importLegacySkillProposal({ record, ownerAgentId: "main", store: { env: fixture.env } });
    closeOpenClawStateDatabaseForTest();
    const before = await captureLegacyStateSnapshotIdentity(fixture);

    const plan = await planFixture(fixture);

    expect(plan.steps.find((step) => step.id === "skill-workshop")).toMatchObject({
      phase: "final",
      source: [
        { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
        { kind: "path", path: path.join(fixture.stateDir, "skill-workshop") },
        { kind: "owner", id: "core:skill-workshop" },
      ],
      target: [
        { kind: "sqlite", path: resolveOpenClawStateSqlitePath(fixture.env) },
        { kind: "owner", id: "core:skill-workshop" },
      ],
      requiredness: "conditional",
      outcome: "deferred",
      refusal: { code: "skill-workshop-planning-deferred" },
    });
    expect(await captureLegacyStateSnapshotIdentity(fixture)).toEqual(before);
    expect(fs.readFileSync(record.target.skillFile, "utf8")).toBe(content);
  });

  it("does not treat SQLite shared-memory coordination as a copied-state mutation", async () => {
    const fixture = await makeFixture();
    const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO planner_probe(value) VALUES ('copied-state');
    `);
    const durableBefore = {
      database: sha256(fs.readFileSync(databasePath)),
      wal: sha256(fs.readFileSync(`${databasePath}-wal`)),
    };
    const sharedMemoryBefore = sha256(fs.readFileSync(`${databasePath}-shm`));

    try {
      const plan = await planFixture(fixture);

      expect({
        database: sha256(fs.readFileSync(databasePath)),
        wal: sha256(fs.readFileSync(`${databasePath}-wal`)),
      }).toEqual(durableBefore);
      expect(sha256(fs.readFileSync(`${databasePath}-shm`))).toBe(sharedMemoryBefore);
      expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");

      const stateDigest = plan.snapshot.stateDigest;
      if (!stateDigest) {
        throw new Error("expected the copied state to have a bound digest");
      }
      database.exec("INSERT INTO planner_probe(value) VALUES ('durable-change');");
      const stale = await planFixture(fixture, stateDigest);
      expect(stale.refusal?.code).toBe("snapshot-identity-mismatch");
    } finally {
      database.close();
    }
  });

  it("does not create missing SQLite shared-memory state while planning", async () => {
    const fixture = await makeFixture();
    const sourcePath = path.join(fixture.root, "wal-source.sqlite");
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO planner_probe(value) VALUES ('copied-state');
      `);
      const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.copyFileSync(sourcePath, databasePath);
      fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
      const durableBefore = {
        database: sha256(fs.readFileSync(databasePath)),
        wal: sha256(fs.readFileSync(`${databasePath}-wal`)),
      };

      const plan = await planFixture(fixture);

      expect(plan.refusal?.code).toBe("candidate-artifact-digest-required");
      expect(fs.existsSync(`${databasePath}-shm`)).toBe(false);
      expect({
        database: sha256(fs.readFileSync(databasePath)),
        wal: sha256(fs.readFileSync(`${databasePath}-wal`)),
      }).toEqual(durableBefore);
    } finally {
      source.close();
    }
  });

  it("continues binding ordinary copied-state files whose names end in -shm", async () => {
    const fixture = await makeFixture();
    const pairedPath = path.join(fixture.stateDir, "operator-notes");
    const similarlyNamedPath = `${pairedPath}-shm`;
    fs.writeFileSync(pairedPath, "not a SQLite database\n");
    fs.writeFileSync(similarlyNamedPath, "first\n");

    const first = await planFixture(fixture);
    const stateDigest = first.snapshot.stateDigest;
    if (!stateDigest) {
      throw new Error("expected the copied state to have a bound digest");
    }

    fs.writeFileSync(similarlyNamedPath, "second\n");
    const stale = await planFixture(fixture, stateDigest);
    expect(stale.refusal?.code).toBe("snapshot-identity-mismatch");
  });

  it("binds fake files and directories at a SQLite shared-memory path", async () => {
    const fixture = await makeFixture();
    const databasePath = resolveOpenClawStateSqlitePath(fixture.env);
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE planner_probe (id INTEGER PRIMARY KEY);");
    database.close();
    const sharedMemoryPath = `${databasePath}-shm`;

    fs.writeFileSync(sharedMemoryPath, "not a wal-index\n");
    const fileBefore = await captureLegacyStateSnapshotIdentity(fixture);
    fs.writeFileSync(sharedMemoryPath, "changed durable bytes\n");
    const fileAfter = await captureLegacyStateSnapshotIdentity(fixture);
    expect(fileAfter.stateDigest).not.toBe(fileBefore.stateDigest);

    fs.rmSync(sharedMemoryPath);
    fs.mkdirSync(sharedMemoryPath);
    const nestedPath = path.join(sharedMemoryPath, "operator-state");
    fs.writeFileSync(nestedPath, "first\n");
    const directoryBefore = await captureLegacyStateSnapshotIdentity(fixture);
    fs.writeFileSync(nestedPath, "second\n");
    const directoryAfter = await captureLegacyStateSnapshotIdentity(fixture);
    expect(directoryAfter.stateDigest).not.toBe(directoryBefore.stateDigest);
  });

  it("binds an authentic associated wal-index body outside volatile read marks", async () => {
    const fixture = await makeFixture();
    const sourcePath = path.join(fixture.root, "wal-index-source.sqlite");
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO planner_probe(value) VALUES ('copied-state');
      `);
      const authenticHeader = fs.readFileSync(`${sourcePath}-shm`).subarray(0, 48);
      const databasePath = path.join(fixture.stateDir, "copied.sqlite");
      fs.copyFileSync(sourcePath, databasePath);
      fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
      const fakeSharedMemory = Buffer.alloc(32_768, 0x5a);
      authenticHeader.copy(fakeSharedMemory, 0);
      authenticHeader.copy(fakeSharedMemory, 48);
      const sharedMemoryPath = `${databasePath}-shm`;
      fs.writeFileSync(sharedMemoryPath, fakeSharedMemory);

      const before = await captureLegacyStateSnapshotIdentity(fixture);
      fakeSharedMemory.writeUInt8(fakeSharedMemory.readUInt8(200) ^ 0xff, 200);
      fs.writeFileSync(sharedMemoryPath, fakeSharedMemory);
      const after = await captureLegacyStateSnapshotIdentity(fixture);

      expect(after.stateDigest).not.toBe(before.stateDigest);
    } finally {
      source.close();
    }
  });

  it("binds forged wal-index structural fields despite valid checksums and WAL salts", async () => {
    const fixture = await makeFixture();
    const sourcePath = path.join(fixture.root, "wal-index-structure-source.sqlite");
    const source = new DatabaseSync(sourcePath);
    try {
      source.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA wal_autocheckpoint = 0;
        CREATE TABLE planner_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO planner_probe(value) VALUES ('copied-state');
      `);
      const databasePath = path.join(fixture.stateDir, "copied.sqlite");
      fs.copyFileSync(sourcePath, databasePath);
      fs.copyFileSync(`${sourcePath}-wal`, `${databasePath}-wal`);
      const forged = Buffer.alloc(32_768, 0x5a);
      fs.readFileSync(`${sourcePath}-shm`).copy(forged, 0, 0, 48);
      forged.writeUInt8(forged.readUInt8(13) ^ 1, 13);
      if (endianness() === "LE") {
        forged.writeUInt16LE(1, 14);
        forged.writeUInt32LE(0xffff_ffff, 16);
      } else {
        forged.writeUInt16BE(1, 14);
        forged.writeUInt32BE(0xffff_ffff, 16);
      }
      writeWalIndexHeaderChecksum(forged);
      forged.copy(forged, 48, 0, 48);
      const sharedMemoryPath = `${databasePath}-shm`;
      fs.writeFileSync(sharedMemoryPath, forged);
      const before = await captureLegacyStateSnapshotIdentity(fixture);

      if (endianness() === "LE") {
        forged.writeUInt32LE(0xffff_fffe, 16);
      } else {
        forged.writeUInt32BE(0xffff_fffe, 16);
      }
      writeWalIndexHeaderChecksum(forged);
      forged.copy(forged, 48, 0, 48);
      fs.writeFileSync(sharedMemoryPath, forged);
      const after = await captureLegacyStateSnapshotIdentity(fixture);

      expect(after.stateDigest).not.toBe(before.stateDigest);

      forged.writeUInt8(forged.readUInt8(120) ^ 0xff, 120);
      forged.writeUInt8(forged.readUInt8(132) ^ 0xff, 132);
      fs.writeFileSync(sharedMemoryPath, forged);
      const nonVolatileCheckpointChange = await captureLegacyStateSnapshotIdentity(fixture);
      expect(nonVolatileCheckpointChange.stateDigest).not.toBe(after.stateDigest);
    } finally {
      source.close();
    }
  });
});
