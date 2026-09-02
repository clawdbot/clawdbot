import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { cleanupManagedOutgoingMediaRecords } from "./managed-image-attachments.js";
import {
  insertManagedImageRecord,
  MANAGED_OUTGOING_ORIGINALS_SUBDIR,
  readManagedImageRecord,
} from "./managed-image-record-store.js";

// End-to-end, real-SQLite regression for the global media GC fail-safe:
// when the session store cannot be read (here: session_nodes dropped), the
// sweep must keep every managed record and its bytes instead of concluding
// the owning messages are gone.

let stateDir: string;

function seedManagedRecord(attachmentId: string) {
  const filename = `${attachmentId}-cat-full.png`;
  const originalPath = path.join(stateDir, "media", MANAGED_OUTGOING_ORIGINALS_SUBDIR, filename);
  fs.mkdirSync(path.dirname(originalPath), { recursive: true });
  fs.writeFileSync(originalPath, "original-image");
  insertManagedImageRecord(
    {
      attachmentId,
      sessionKey: "agent:main:main",
      agentId: "main",
      messageId: "msg-1",
      createdAt: new Date().toISOString(),
      alt: "Cat",
      original: {
        mediaRoot: path.join(stateDir, "media"),
        mediaId: filename,
        mediaSubdir: MANAGED_OUTGOING_ORIGINALS_SUBDIR,
        contentType: "image/png",
        width: 1024,
        height: 768,
        sizeBytes: "original-image".length,
        filename: "cat.png",
      },
    },
    stateDir,
  );
  return originalPath;
}

function dropSessionNodes() {
  const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
  const databasePath = openOpenClawAgentDatabase(options).path;
  closeOpenClawAgentDatabasesForTest();
  const { DatabaseSync } = requireNodeSqlite();
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE session_nodes;");
  database.close();
}

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "gc-availability-"));
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

describe("cleanupManagedOutgoingMediaRecords availability fail-safe", () => {
  it("keeps records and bytes when session_nodes is missing", async () => {
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawAgentDatabase(options);
    const originalPath = seedManagedRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    dropSessionNodes();

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingMediaRecords({ stateDir }),
    );

    expect(result.deletedRecordCount).toBe(0);
    expect(readManagedImageRecord("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", stateDir)).not.toBeNull();
    expect(fs.existsSync(originalPath)).toBe(true);
  });

  it("still deletes dereferenced records when the store is healthy", async () => {
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: stateDir } };
    openOpenClawAgentDatabase(options);
    const originalPath = seedManagedRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    const result = await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, () =>
      cleanupManagedOutgoingMediaRecords({ stateDir }),
    );

    expect(result.deletedRecordCount).toBe(1);
    expect(readManagedImageRecord("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", stateDir)).toBeNull();
    expect(fs.existsSync(originalPath)).toBe(false);
  });
});
