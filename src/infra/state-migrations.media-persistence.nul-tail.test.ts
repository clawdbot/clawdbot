import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

function createArchiveFixture(bytes: Uint8Array): {
  archivePath: string;
  env: NodeJS.ProcessEnv;
} {
  const stateDir = fs.realpathSync(makeTempDir(tempDirs, "media-persistence-archive-"));
  const env = { OPENCLAW_STATE_DIR: stateDir };
  openOpenClawAgentDatabase({ agentId: "main", env });
  closeOpenClawAgentDatabasesForTest();
  const archivePath = path.join(
    stateDir,
    "agents",
    "main",
    "sessions",
    "fixture.jsonl.deleted.2026-07-24T01-02-03.000Z",
  );
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, bytes);
  return { archivePath, env };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
});

describe("legacy media persistence NUL-tail recovery", () => {
  it("atomically removes a terminal NUL suffix from an otherwise valid archive", () => {
    const valid = Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n`);
    const { archivePath, env } = createArchiveFixture(Buffer.concat([valid, Buffer.alloc(284)]));
    let replacements = 0;

    const result = migrateLegacyMediaPersistence({
      env,
      hooks: { beforeArchiveReplace: () => (replacements += 1) },
    });

    expect(result.warnings).toEqual([]);
    expect(result.changes).toContain(`Migrated archived transcript media in ${archivePath}.`);
    expect(replacements).toBe(1);
    expect(fs.readFileSync(archivePath)).toEqual(valid);
  });

  it.each([
    {
      name: "an interior NUL",
      bytes: Buffer.concat([
        Buffer.from(JSON.stringify({ type: "event", id: "event-1" })),
        Buffer.from([0]),
        Buffer.from(`\n${JSON.stringify({ type: "event", id: "event-2" })}\n`),
      ]),
    },
    { name: "an all-NUL file", bytes: Buffer.alloc(284) },
    {
      name: "a truncated JSON tail before terminal NULs",
      bytes: Buffer.concat([
        Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n{"type":`),
        Buffer.alloc(32),
      ]),
    },
    {
      name: "a blank record",
      bytes: Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n\n`),
    },
  ])("rejects and preserves $name", ({ bytes }) => {
    const { archivePath, env } = createArchiveFixture(bytes);
    let replacements = 0;

    const result = migrateLegacyMediaPersistence({
      env,
      hooks: { beforeArchiveReplace: () => (replacements += 1) },
    });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Skipped archived transcript media migration");
    expect(replacements).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
  });

  it.each([
    { name: "an empty file", bytes: Buffer.alloc(0) },
    {
      name: "a valid archive without a NUL tail",
      bytes: Buffer.from(`${JSON.stringify({ type: "event", id: "event-1" })}\n`),
    },
  ])("does not rewrite $name", ({ bytes }) => {
    const { archivePath, env } = createArchiveFixture(bytes);
    const before = fs.lstatSync(archivePath);
    let replacements = 0;

    const result = migrateLegacyMediaPersistence({
      env,
      hooks: { beforeArchiveReplace: () => (replacements += 1) },
    });

    const after = fs.lstatSync(archivePath);
    expect(result).toEqual({ changes: [], warnings: [] });
    expect(replacements).toBe(0);
    expect(fs.readFileSync(archivePath)).toEqual(bytes);
    expect({ dev: after.dev, ino: after.ino, mtimeMs: after.mtimeMs, size: after.size }).toEqual({
      dev: before.dev,
      ino: before.ino,
      mtimeMs: before.mtimeMs,
      size: before.size,
    });
  });
});
