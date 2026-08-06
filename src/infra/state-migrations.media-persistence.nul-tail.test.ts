import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  encodeSessionArchiveContent,
  readSessionArchiveContentSync,
  SESSION_ARCHIVE_ZSTD_SUFFIX,
} from "../config/sessions/archive-compression.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { migrateLegacyMediaPersistence } from "./state-migrations.media-persistence.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTempDirs(tempDirs);
  tempDirs.length = 0;
});

describe("legacy media persistence terminal NUL-tail recovery", () => {
  it("recovers only a terminal NUL-only logical JSONL suffix", () => {
    const stateDir = makeTempDir(tempDirs, "media-persistence-nul-tail-");
    const env = { OPENCLAW_STATE_DIR: stateDir };
    openOpenClawAgentDatabase({ agentId: "main", env });
    closeOpenClawAgentDatabasesForTest();
    const archiveDir = path.join(stateDir, "agents", "main", "sessions");
    const plainPath = path.join(archiveDir, "nul-tail.jsonl.deleted.2026-08-06T01-02-03.000Z");
    const plainContent =
      '{"type":"message", "id":"event-1", "parentId":null, "timestamp":1000, "message":{"role":"user", "content":"hello\\u0021"}}\r\n';
    const nulTail = Buffer.alloc(284);
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(plainPath, Buffer.concat([Buffer.from(plainContent), nulTail]));

    const compressedPath = `${path.join(
      archiveDir,
      "nul-tail-zstd.jsonl.deleted.2026-08-06T01-02-04.000Z",
    )}${SESSION_ARCHIVE_ZSTD_SUFFIX}`;
    const compressedContent =
      '{"type":"message","id":"event-zstd","parentId":null,"timestamp":1001,"message":{"role":"assistant","content":"zstd"}}';
    const encoded = encodeSessionArchiveContent(`${compressedContent}\0\0`);
    if (encoded.suffix !== SESSION_ARCHIVE_ZSTD_SUFFIX) {
      throw new Error("test runtime does not support zstd");
    }
    fs.writeFileSync(compressedPath, encoded.bytes);

    const corruptions = new Map<string, Buffer>([
      [
        path.join(archiveDir, "blank.jsonl.deleted.2026-08-06T01-02-05.000Z"),
        Buffer.from(`${plainContent}\n`),
      ],
      [
        path.join(archiveDir, "interior-nul.jsonl.deleted.2026-08-06T01-02-06.000Z"),
        Buffer.from(`${plainContent}\0\n`),
      ],
      [
        path.join(archiveDir, "terminal-garbage.jsonl.deleted.2026-08-06T01-02-07.000Z"),
        Buffer.from(`${plainContent}garbage`),
      ],
      [
        path.join(archiveDir, "truncated.jsonl.deleted.2026-08-06T01-02-08.000Z"),
        Buffer.from(`${plainContent}{"type":"message"`),
      ],
      [path.join(archiveDir, "all-nul.jsonl.deleted.2026-08-06T01-02-09.000Z"), Buffer.alloc(284)],
    ]);
    for (const [filePath, bytes] of corruptions) {
      fs.writeFileSync(filePath, bytes);
    }

    const result = migrateLegacyMediaPersistence({ env });

    expect(result.changes).toEqual(
      expect.arrayContaining([
        `Migrated archived transcript media in ${plainPath}.`,
        `Migrated archived transcript media in ${compressedPath}.`,
      ]),
    );
    expect(result.warnings).toHaveLength(corruptions.size);
    expect(fs.readFileSync(plainPath)).toEqual(Buffer.from(plainContent));
    expect(readSessionArchiveContentSync(compressedPath)).toBe(compressedContent);
    for (const [filePath, bytes] of corruptions) {
      expect(result.warnings.join("\n")).toContain(filePath);
      expect(fs.readFileSync(filePath)).toEqual(bytes);
    }

    const rerun = migrateLegacyMediaPersistence({ env });
    expect(rerun.changes).toEqual([]);
    expect(rerun.warnings).toHaveLength(corruptions.size);
    expect(fs.readFileSync(plainPath)).toEqual(Buffer.from(plainContent));
    expect(readSessionArchiveContentSync(compressedPath)).toBe(compressedContent);
  });
});
