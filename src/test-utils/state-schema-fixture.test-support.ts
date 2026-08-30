import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";

export async function writeStateSchemaFixture(
  stateDir: string,
  schemaVersion = OPENCLAW_STATE_SCHEMA_VERSION + 1,
): Promise<string> {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE preserved_state (value TEXT NOT NULL);
      INSERT INTO preserved_state VALUES ('keep this state');
      PRAGMA user_version = ${schemaVersion};
    `);
  } finally {
    database.close();
  }
  return databasePath;
}

export async function snapshotStateFixtureFiles(stateDir: string) {
  return await Promise.all(
    (await fs.readdir(stateDir, { recursive: true })).toSorted().map(async (relativePath) => {
      const pathname = path.join(stateDir, relativePath);
      const stat = await fs.stat(pathname);
      return {
        path: relativePath,
        mode: stat.mode & 0o777,
        contents: stat.isFile() ? await fs.readFile(pathname) : undefined,
      };
    }),
  );
}
