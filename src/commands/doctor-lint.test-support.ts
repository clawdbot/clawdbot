// SQLite fixtures for Doctor lint read-only state checks.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function createDoctorLintSemanticIndex(stateDir: string): string {
  const databasePath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(
    "CREATE TABLE memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
  );
  database
    .prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)")
    .run("memory_index_meta_v1", JSON.stringify({ model: "embeddinggemma-300m", vectorDims: 768 }));
  database.close();
  return databasePath;
}

export function snapshotDoctorLintSqliteFamily(databasePath: string): Array<{
  path: string;
  sha256: string;
}> {
  return ["", "-journal", "-shm", "-wal"]
    .map((suffix) => `${databasePath}${suffix}`)
    .filter((candidate) => fs.existsSync(candidate))
    .map((candidate) => ({
      path: candidate,
      sha256: createHash("sha256").update(fs.readFileSync(candidate)).digest("hex"),
    }));
}
