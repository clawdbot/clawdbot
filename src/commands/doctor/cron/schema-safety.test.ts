import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { isSqliteSchemaVersionError } from "../../../infra/sqlite-user-version.js";
import {
  closeOpenClawStateDatabaseForTest,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";
import {
  applyLegacyCronStoreRepair,
  collectCronCodexRuntimePolicyTargetsReadOnly,
  loadLegacyCronRepairState,
  repairCronCodexModelRefsAfterConfigWrite,
  repairLegacyCronStoreWithoutPrompt,
} from "./legacy-repair.js";

type FutureSchemaFixture = {
  cfg: OpenClawConfig;
  databasePath: string;
  storePath: string;
};

let tempRoot: string | undefined;
let fixtureDatabase: DatabaseSync | undefined;

afterEach(async () => {
  fixtureDatabase?.close();
  fixtureDatabase = undefined;
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

async function writeFutureSchema(databasePath: string): Promise<void> {
  await fs.mkdir(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE preserved_sentinel (value TEXT NOT NULL) STRICT;
      INSERT INTO preserved_sentinel (value) VALUES ('keep-me');
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
    `);
  } finally {
    database.close();
  }
}

async function createFixture(options: { futureSchema: boolean }): Promise<FutureSchemaFixture> {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-schema-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [] }), "utf8");

  const databasePath = resolveOpenClawStateSqlitePath();
  if (options.futureSchema) {
    await writeFutureSchema(databasePath);
  }

  return {
    cfg: { cron: { store: storePath } } as OpenClawConfig,
    databasePath,
    storePath,
  };
}

async function snapshotFixture(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versionRow = database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    const sentinelRow = database.prepare("SELECT value FROM preserved_sentinel").get() as {
      value: string;
    };
    const bytes = await fs.readFile(databasePath);
    const artifactNames = (await fs.readdir(path.dirname(databasePath))).toSorted();
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      schemaVersion: versionRow.user_version,
      sentinel: sentinelRow.value,
      artifacts: Object.fromEntries(
        await Promise.all(
          artifactNames.map(async (name) => [
            name,
            createHash("sha256")
              .update(await fs.readFile(path.join(path.dirname(databasePath), name)))
              .digest("hex"),
          ]),
        ),
      ),
    };
  } finally {
    database.close();
  }
}

async function expectSchemaRefusalWithoutMutation(
  fixture: FutureSchemaFixture,
  operation: () => Promise<unknown>,
): Promise<void> {
  const before = await snapshotFixture(fixture.databasePath);
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(isSqliteSchemaVersionError(error)).toBe(true);
  await expect(snapshotFixture(fixture.databasePath)).resolves.toEqual(before);
}

describe("future shared-state schema safety", () => {
  const entrypoints: Array<[string, (fixture: FutureSchemaFixture) => Promise<unknown>]> = [
    [
      "legacy cron health collection",
      async ({ cfg }) => await collectLegacyCronStoreHealthFindings({ cfg }),
    ],
    [
      "interactive legacy cron repair",
      async ({ cfg }) =>
        await maybeRepairLegacyCronStore({
          cfg,
          options: {},
          prompter: { confirm: vi.fn() },
        }),
    ],
    [
      "non-interactive legacy cron repair",
      async ({ cfg }) => await repairLegacyCronStoreWithoutPrompt({ cfg }),
    ],
    [
      "Codex cron migration planning",
      async ({ cfg }) => await collectCronCodexRuntimePolicyTargetsReadOnly({ cfg }),
    ],
    [
      "Codex cron migration commit",
      async ({ cfg }) => await repairCronCodexModelRefsAfterConfigWrite({ cfg }),
    ],
  ];

  it.each(entrypoints)("fails closed without mutation during %s", async (_name, operation) => {
    const fixture = await createFixture({ futureSchema: true });
    await expectSchemaRefusalWithoutMutation(fixture, () => operation(fixture));
  });

  it("fails closed in non-interactive repair when no legacy files remain", async () => {
    const fixture = await createFixture({ futureSchema: true });
    await fs.rm(fixture.storePath);

    await expectSchemaRefusalWithoutMutation(fixture, async () => {
      await repairLegacyCronStoreWithoutPrompt({ cfg: fixture.cfg });
    });
  });

  it("preserves active WAL artifacts while rejecting the future schema", async () => {
    const fixture = await createFixture({ futureSchema: false });
    await fs.mkdir(path.dirname(fixture.databasePath), { recursive: true });
    fixtureDatabase = new DatabaseSync(fixture.databasePath);
    fixtureDatabase.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE preserved_sentinel (value TEXT NOT NULL) STRICT;
      INSERT INTO preserved_sentinel (value) VALUES ('keep-me');
      PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION + 1};
    `);

    await expectSchemaRefusalWithoutMutation(fixture, async () => {
      await maybeRepairLegacyCronStore({
        cfg: fixture.cfg,
        options: {},
        prompter: { confirm: vi.fn() },
      });
    });
  });

  it("fails closed if the schema advances between inspection and repair", async () => {
    const fixture = await createFixture({ futureSchema: false });
    const state = await loadLegacyCronRepairState({ cfg: fixture.cfg });
    expect(state).not.toBeNull();
    closeOpenClawStateDatabaseForTest();
    await writeFutureSchema(fixture.databasePath);

    await expectSchemaRefusalWithoutMutation(fixture, async () => {
      await applyLegacyCronStoreRepair({ cfg: fixture.cfg, state: state! });
    });
  });
});
