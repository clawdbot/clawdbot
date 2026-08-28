import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import {
  defineLegacyJsonStateMigration,
  definePluginDoctorMigrationFromPlans,
  type PluginDoctorStateMigrationContext,
} from "./runtime-doctor-migrations.js";

const runLegacyMigrationPlans = vi.hoisted(() => vi.fn());
const executorModuleLoads = vi.hoisted(() => vi.fn());

vi.mock("../infra/state-migrations.plugin-state.js", () => {
  executorModuleLoads();
  return { runLegacyMigrationPlans };
});

describe("defineLegacyJsonStateMigration retention", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let context: PluginDoctorStateMigrationContext;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-json-migration-"));
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    context = {
      openPluginStateKeyedStore: (options) =>
        createPluginStateKeyedStore("migration-fixture", { ...options, env }),
    };
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it.each(["imported", "pre-existing"])(
    "preserves the source and warns when a row is evicted (%s)",
    async (evicted) => {
      const sourcePath = path.join(stateDir, "legacy.json");
      const rows = ["first", "second", ...(evicted === "imported" ? ["third"] : [])].map((key) => ({
        key,
        value: key,
      }));
      const source = JSON.stringify(rows);
      await fs.writeFile(sourcePath, source);
      const store = context.openPluginStateKeyedStore({ namespace: "entries", maxEntries: 2 });
      if (evicted === "pre-existing") {
        await store.register("existing", "canonical");
      }
      const migration = defineLegacyJsonStateMigration({
        id: "retention-fixture",
        label: "Fixture entries",
        resolvePath: () => sourcePath,
        parse: (value) => value as typeof rows,
        namespace: "entries",
        maxEntries: 2,
        describeEntries: () => ({
          preview: ["legacy entries"],
          change: ({ imported }) => `Migrated ${imported} entries`,
        }),
        toRows: (entries) => entries,
      });
      const params = { config: {}, env, stateDir, oauthDir: stateDir, context };

      const result = await migration.migrateLegacyState(params);

      expect(await store.entries()).toHaveLength(2);
      expect(result).toEqual({
        changes: [],
        warnings: [expect.stringContaining("failed to retain every required entry (1 missing)")],
      });
      await expect(fs.readFile(sourcePath, "utf8")).resolves.toBe(source);
      await expect(fs.access(`${sourcePath}.migrated`)).rejects.toThrow();
      await expect(migration.detectLegacyState(params)).resolves.not.toBeNull();
    },
  );
});

const migrationInput = {
  config: {},
  env: {},
  stateDir: "/state",
  oauthDir: "/oauth",
  context: { openPluginStateKeyedStore: vi.fn() } as never,
};

describe("definePluginDoctorMigrationFromPlans", () => {
  it("maps previews and delegates normalized plans to the existing executor", async () => {
    const plans: ChannelLegacyStateMigrationPlan[] = [
      {
        kind: "plugin-state-import",
        label: "Cache",
        sourcePath: "/state/cache.json",
        targetPath: "plugin state:cache",
        pluginId: "demo",
        namespace: "cache",
        maxEntries: 10,
        scopeKey: "",
        readEntries: () => [],
      },
      {
        kind: "move",
        label: "Credentials",
        sourcePath: "/oauth/creds.json",
        targetPath: "/oauth/demo/creds.json",
      },
      {
        kind: "copy",
        label: "Backup",
        sourcePath: "/state/backup.json",
        targetPath: "/state/demo/backup.json",
      },
    ];
    const migration = definePluginDoctorMigrationFromPlans({
      id: "demo-state",
      label: "Demo state",
      resolvePlans: () => plans,
    });

    await expect(migration.detectLegacyState(migrationInput)).resolves.toEqual({
      preview: [
        "- Cache: /state/cache.json",
        "- Credentials: /oauth/creds.json → /oauth/demo/creds.json",
        "- Backup: /state/backup.json → /state/demo/backup.json",
      ],
    });
    expect(executorModuleLoads).not.toHaveBeenCalled();

    runLegacyMigrationPlans.mockResolvedValueOnce({
      changes: ["migrated"],
      warnings: ["warning"],
    });
    await expect(migration.migrateLegacyState(migrationInput)).resolves.toEqual({
      changes: ["migrated"],
      warnings: ["warning"],
    });
    expect(executorModuleLoads).toHaveBeenCalledTimes(1);
    expect(runLegacyMigrationPlans).toHaveBeenCalledTimes(1);
    expect(runLegacyMigrationPlans.mock.calls[0]?.[0]).toEqual([
      { ...plans[0], stateDir: "/state" },
      plans[1],
      plans[2],
    ]);
  });

  it("returns null when no legacy plans resolve", async () => {
    const migration = definePluginDoctorMigrationFromPlans({
      id: "empty-state",
      label: "Empty state",
      resolvePlans: () => [],
    });

    await expect(migration.detectLegacyState(migrationInput)).resolves.toBeNull();
  });
});
