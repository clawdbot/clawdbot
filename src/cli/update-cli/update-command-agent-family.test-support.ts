import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { expect } from "vitest";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { loadUpdateRecovery } from "../../infra/update-run-recovery.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { UpdateCommandFinalizedRecoveryFailure } from "./update-command-result.js";

export async function seedReplayAgentDatabase(env: NodeJS.ProcessEnv) {
  const owner = openOpenClawAgentDatabase({ agentId: "main", env });
  try {
    owner.db.exec(`INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
      VALUES ('replay-fixture','baseline','{"retained":true}',NULL,1)`);
  } finally {
    await closeOpenClawAgentDatabasesAsync();
  }
}

export async function interruptReplayAgentFamily(params: {
  env: NodeJS.ProcessEnv;
  mode: string;
  runId: string;
  invoke: () => Promise<unknown>;
}) {
  const file = resolveOpenClawAgentSqlitePath({ agentId: "main", env: params.env });
  // A real exited SQLite writer leaves committed WAL frames, not fake sidecars.
  execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import {DatabaseSync} from 'node:sqlite';
     const db = new DatabaseSync(process.argv[1]);
     db.exec(\`PRAGMA journal_mode=WAL;
       INSERT INTO cache_entries (scope,key,value_json,expires_at,updated_at)
       VALUES ('replay-fixture','unrelated','{"committed":true}',NULL,2)\`);
     if (process.argv[2] === "empty") db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
     process.exit(0);`,
    file,
    params.mode === "replay-package-gap-agent-empty-wal" ? "empty" : "frames",
  ]);
  const size = (await fs.stat(file + "-wal")).size;
  if (params.mode === "replay-package-gap-agent-empty-wal") {
    expect(size).toBe(0);
  } else {
    expect(size).toBeGreaterThan(0);
  }
  expect((await fs.stat(file + "-shm")).size).toBeGreaterThan(0);
  if (
    ["replay-package-gap-agent-reader", "replay-package-gap-agent-writer"].includes(params.mode)
  ) {
    const writer = params.mode === "replay-package-gap-agent-writer";
    const reader = openNodeSqliteDatabase(file, { readOnly: !writer });
    try {
      reader.exec(writer ? "BEGIN IMMEDIATE" : "BEGIN");
      expect(
        reader.prepare("SELECT key FROM cache_entries WHERE scope='replay-fixture'").all(),
      ).toHaveLength(2);
      const hashes = () =>
        Promise.all(
          ["", "-wal", "-shm"].map(async (suffix) =>
            createHash("sha256")
              .update(await fs.readFile(file + suffix))
              .digest("hex"),
          ),
        );
      const before = await hashes();
      const refused = await params.invoke();
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(UpdateCommandFinalizedRecoveryFailure);
      expect(formatErrorMessage(refused)).toContain("database is locked");
      expect(await hashes()).toEqual(before);
      const pending = loadUpdateRecovery(params.runId, { env: params.env })!;
      expect(pending.effects.at(-1)).toMatchObject({ kind: "checkpoint-restore", state: "intent" });
      expect(pending.restore).toBeFalsy();
      expect(pending.terminal).toBeFalsy();
      expect(resolveGatewayService().start).not.toHaveBeenCalled();
    } finally {
      reader.close();
    }
  }
  const outcome = await params.invoke();
  const verify = openNodeSqliteDatabase(file, { readOnly: true });
  try {
    expect(
      verify
        .prepare(
          "SELECT key, value_json FROM cache_entries WHERE scope='replay-fixture' ORDER BY key",
        )
        .all(),
    ).toEqual([
      { key: "baseline", value_json: '{"retained":true}' },
      { key: "unrelated", value_json: '{"committed":true}' },
    ]);
  } finally {
    verify.close();
  }
  return outcome;
}
