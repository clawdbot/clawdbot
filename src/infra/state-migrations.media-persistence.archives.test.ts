import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";
import {
  cleanupMediaPersistenceFixtures,
  createEvent,
  createLegacyDatabaseFixture,
  writeArchive,
} from "./state-migrations.media-persistence.test-support.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupMediaPersistenceFixtures(tempDirs);
});

describe("legacy media persistence archive doctor migration", () => {
  it("rejects ambiguous sparse arrays and ignores stale interrupted temp files", async () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-sparse-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    createLegacyDatabaseFixture({ env, eventsBySession: {} });
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const archivePath = path.join(archiveDir, "sparse.jsonl.bak.2026-07-24T01-02-03.000Z");
    const event = createEvent({
      id: "event-1",
      parentId: null,
      timestamp: 1000,
      message: {
        role: "user",
        MediaPaths: ["", "/media/b.png"],
        MediaTypes: ["image/png"],
      },
    });
    writeArchive(archivePath, [event], false);
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "ambiguous sparse positional alignment",
    );
    fs.unlinkSync(archivePath);

    const corruptArchivePath = path.join(
      archiveDir,
      "corrupt.jsonl.deleted.2026-07-24T01-02-04.000Z",
    );
    fs.writeFileSync(corruptArchivePath, "{broken\n");
    expect((await migrateLegacyMediaPersistence({ env })).warnings.join("\n")).toContain(
      "invalid transcript JSON",
    );
    expect(fs.readFileSync(corruptArchivePath, "utf8")).toBe("{broken\n");
    fs.unlinkSync(corruptArchivePath);

    writeArchive(
      archivePath,
      [
        createEvent({
          id: "event-1",
          parentId: null,
          timestamp: 1000,
          message: { role: "user", MediaPath: "/media/a.png", MediaType: "image/png" },
        }),
      ],
      false,
    );
    fs.writeFileSync(`${archivePath}.media-retirement.999.interrupted.tmp`, "partial");
    expect((await migrateLegacyMediaPersistence({ env })).changes.join("\n")).toContain(
      "Migrated archived transcript media",
    );
    expect(readSessionArchiveContentSync(archivePath)).toContain('"__openclaw"');
  });
});
