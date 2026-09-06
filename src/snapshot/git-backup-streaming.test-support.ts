import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { requireGitCommand } from "../infra/git-exec.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { createGitBackup, restoreGitBackupRef, verifyGitBackupRef } from "./git-backup.js";

// A real Git round trip must fit a heap smaller than its serialized table.
const root = process.argv[2];
assert.ok(root);
const stateDir = path.join(root, "state");
const sourcePath = path.join(stateDir, "source.sqlite");
const repositoryPath = path.join(root, "repository");
const targetPath = path.join(root, "restored.sqlite");
const identity = { role: "global" } as const;
const rowCount = 4096;
const body = "x".repeat(64 * 1024);
await fs.mkdir(stateDir, { recursive: true });
const database = openOpenClawStateDatabase({ path: sourcePath }).db;
database.exec("CREATE TABLE content (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
const insert = database.prepare("INSERT INTO content VALUES (?, ?)");
const expectedHash = createHash("sha256");
database.exec("BEGIN");
for (let id = 0; id < rowCount; id += 1) {
  insert.run(id, body);
  expectedHash.update(`${JSON.stringify({ id, body })}\n`);
}
database.exec("COMMIT");
closeOpenClawStateDatabaseForTest();
const expected = { rows: rowCount, sha256: expectedHash.digest("hex") };
const created = await createGitBackup({
  repositoryPath,
  stateDir,
  databases: [{ path: sourcePath, identity }],
});
assert.ok(created.commit);
assert.deepEqual(created.manifests[0]?.tables.content, expected);
const restored = await restoreGitBackupRef({ repositoryPath, identity, targetPath });
assert.ok(restored.tables.every((table) => table.ok));
assert.deepEqual(restored.manifest.tables.content, expected);
const restoredDatabase = new DatabaseSync(targetPath, { readOnly: true });
try {
  let seen = 0;
  for (const row of restoredDatabase
    .prepare("SELECT id, body FROM content ORDER BY id")
    .iterate()) {
    assert.equal(row.id, seen);
    assert.equal(row.body, body);
    seen += 1;
  }
  assert.equal(seen, rowCount);
} finally {
  restoredDatabase.close();
}
const verified = await verifyGitBackupRef({ repositoryPath, identity });
assert.ok(verified.tables.every((table) => table.ok));
assert.deepEqual(verified.manifest.tables.content, expected);

// A missing Git blob must fail materialization without exposing a partial restore.
const blob = await requireGitCommand(repositoryPath, [
  "rev-parse",
  `${created.commit}:global/tables/content.jsonl`,
]);
await fs.unlink(path.join(repositoryPath, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
const failedTarget = path.join(root, "failed.sqlite");
await assert.rejects(restoreGitBackupRef({ repositoryPath, identity, targetPath: failedTarget }));
await assert.rejects(fs.lstat(failedTarget), { code: "ENOENT" });
console.log(
  JSON.stringify({
    rows: rowCount,
    logicalBytes: rowCount * body.length,
    sha256: expected.sha256,
    restored: true,
    verified: true,
    gitFailureCleaned: true,
    maxRssKiB: process.resourceUsage().maxRSS,
  }),
);
