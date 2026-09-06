import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import {
  createPluginStateKeyedStore,
  resetPluginStateStoreForTests,
} from "../plugin-state/plugin-state-store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { runLegacyMigrationPlans } from "./state-migrations.plugin-state.js";

describe("legacy migration plan failure isolation", () => {
  let state: OpenClawTestState;

  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "migration-plan-isolation" });
  });

  afterEach(async () => {
    resetPluginStateStoreForTests();
    await state.cleanup();
  });

  it.each(["throw", "reject"] as const)(
    "retains completed work, continues later plans, and retries a failed import (%s)",
    async (failure) => {
      const importStateDir = state.statePath("import-owner");
      const sourcePath = await state.writeText("legacy-import.json", "legacy source\n");
      const earlierPath = await state.writeText("earlier.txt", "earlier artifact\n");
      const laterPath = await state.writeText("later.txt", "later artifact\n");
      const env = { ...state.env, OPENCLAW_STATE_DIR: importStateDir };
      const store = createPluginStateKeyedStore<string>("migration-fixture", {
        namespace: "failure-isolation",
        maxEntries: 4,
        env,
      });
      await store.register("scope:conflict", "canonical");
      let shouldFail = true;
      const plans: ChannelLegacyStateMigrationPlan[] = [
        {
          kind: "move",
          label: "Earlier artifact",
          sourcePath: earlierPath,
          targetPath: `${earlierPath}.moved`,
        },
        {
          kind: "plugin-state-import",
          label: "Replacement import",
          sourcePath,
          targetPath: "plugin state:failure-isolation",
          pluginId: "migration-fixture",
          namespace: "failure-isolation",
          maxEntries: 4,
          scopeKey: "scope",
          stateDir: importStateDir,
          cleanupSource: "rename",
          readEntries: () => [{ key: "conflict", value: "incoming" }],
          shouldReplaceExistingEntry: () => {
            if (!shouldFail) {
              return true;
            }
            const error = new Error("synthetic callback failure");
            if (failure === "reject") {
              return Promise.reject(error);
            }
            throw error;
          },
        },
        {
          kind: "copy",
          label: "Later artifact",
          sourcePath: laterPath,
          targetPath: `${laterPath}.copied`,
        },
      ];
      const run = () =>
        runLegacyMigrationPlans(plans.filter((plan) => fs.existsSync(plan.sourcePath)));

      const failed = await run();

      expect(failed.changes).toEqual([
        expect.stringContaining("Moved Earlier artifact"),
        expect.stringContaining("Copied Later artifact"),
      ]);
      expect(failed.warnings).toEqual([
        expect.stringMatching(/Failed migrating Replacement import.*synthetic callback failure/),
      ]);
      expect(fs.readFileSync(`${earlierPath}.moved`, "utf8")).toBe("earlier artifact\n");
      expect(fs.readFileSync(`${laterPath}.copied`, "utf8")).toBe("later artifact\n");
      expect(fs.readFileSync(sourcePath, "utf8")).toBe("legacy source\n");
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
      expect(await store.lookup("scope:conflict")).toBe("canonical");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);

      shouldFail = false;
      const repaired = await run();

      expect(repaired.warnings).toEqual([]);
      expect(repaired.changes).toContainEqual(
        expect.stringContaining("Migrated 1 Replacement import entry"),
      );
      expect(await store.lookup("scope:conflict")).toBe("incoming");
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe("legacy source\n");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      await expect(run()).resolves.toEqual({ changes: [], warnings: [] });
    },
  );

  it.each([
    { failure: "predicate", cleanupFirst: false },
    { failure: "reader", cleanupFirst: false },
    { failure: "capacity", cleanupFirst: false },
    { failure: "predicate", cleanupFirst: true },
    { failure: "empty", cleanupFirst: false },
  ] as const)(
    "retires a shared source only after every consumer completes ($failure, cleanup first: $cleanupFirst)",
    async ({ failure, cleanupFirst }) => {
      // iMessage derives a durable short-id counter and an expiring cache from one JSONL file.
      const original = `${JSON.stringify({ shortId: failure === "empty" ? "0" : "9000", timestamp: 0 })}\n`;
      const sourcePath = await state.writeText("reply-cache.jsonl", original);
      const unrelatedPath = await state.writeText("unrelated.txt", "independent artifact\n");
      const importStateDir = state.statePath("shared-source-owner");
      const env = { ...state.env, OPENCLAW_STATE_DIR: importStateDir };
      const counter = createPluginStateKeyedStore<{ counter: number }>("migration-fixture", {
        namespace: "shared-counter",
        maxEntries: 1,
        env,
      });
      await counter.register(failure === "capacity" ? "occupied" : "counter", { counter: 1 });
      let shouldFail = true;
      const counterObservedMove: boolean[] = [];
      const counterPlan: ChannelLegacyStateMigrationPlan = {
        kind: "plugin-state-import",
        label: "Reply counter",
        sourcePath,
        targetPath: "plugin state:shared-counter",
        pluginId: "migration-fixture",
        namespace: "shared-counter",
        maxEntries: 1,
        scopeKey: "",
        stateDir: importStateDir,
        readEntries: () => {
          counterObservedMove.push(fs.existsSync(`${unrelatedPath}.moved`));
          if (failure === "reader" && shouldFail) {
            throw new Error("synthetic counter read failure");
          }
          const entry = JSON.parse(fs.readFileSync(sourcePath, "utf8")) as { shortId: string };
          const value = Number.parseInt(entry.shortId, 10);
          return value > 0 ? [{ key: "counter", value: { counter: value } }] : [];
        },
        shouldReplaceExistingEntry: () => {
          if (failure === "predicate" && shouldFail) {
            throw new Error("synthetic counter callback failure");
          }
          return true;
        },
      };
      const cachePlan: ChannelLegacyStateMigrationPlan = {
        kind: "plugin-state-import",
        label: "Expired reply cache",
        sourcePath,
        targetPath: "plugin state:shared-cache",
        pluginId: "migration-fixture",
        namespace: "shared-cache",
        maxEntries: 4,
        scopeKey: "",
        stateDir: importStateDir,
        cleanupSource: "rename",
        cleanupWhenEmpty: true,
        readEntries: () => [],
      };
      const unrelatedPlan: ChannelLegacyStateMigrationPlan = {
        kind: "move",
        label: "Unrelated artifact",
        sourcePath: unrelatedPath,
        targetPath: `${unrelatedPath}.moved`,
      };
      const plans = cleanupFirst
        ? [cachePlan, unrelatedPlan, counterPlan]
        : [counterPlan, cachePlan, unrelatedPlan];
      const run = () =>
        runLegacyMigrationPlans(plans.filter((plan) => fs.existsSync(plan.sourcePath)));

      const first = await run();

      expect(counterObservedMove).toEqual([cleanupFirst]);
      expect(fs.readFileSync(`${unrelatedPath}.moved`, "utf8")).toBe("independent artifact\n");
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(await counter.lookup("counter")).toEqual(
        failure === "capacity" ? undefined : { counter: 1 },
      );
      if (failure === "empty") {
        expect(first.warnings).toEqual([]);
        expect(fs.existsSync(sourcePath)).toBe(false);
        expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe(original);
        await expect(run()).resolves.toEqual({ changes: [], warnings: [] });
        return;
      }

      expect(fs.existsSync(sourcePath), "the incomplete counter still needs its source").toBe(true);
      expect(fs.readFileSync(sourcePath, "utf8")).toBe(original);
      expect(fs.existsSync(`${sourcePath}.migrated`)).toBe(false);
      expect(first.warnings).toContainEqual(expect.stringContaining("Reply counter"));
      expect(first.changes).not.toContainEqual(expect.stringContaining("Archived"));

      shouldFail = false;
      if (failure === "capacity") {
        await counter.delete("occupied");
      }
      const repaired = await run();

      expect(repaired.warnings).toEqual([]);
      expect(await counter.lookup("counter")).toEqual({ counter: 9000 });
      expect(fs.existsSync(sourcePath)).toBe(false);
      expect(fs.readFileSync(`${sourcePath}.migrated`, "utf8")).toBe(original);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      await expect(run()).resolves.toEqual({ changes: [], warnings: [] });
    },
  );

  it.each([false, true])(
    "keeps source cleanup scoped and before unrelated imports (cleanup throws: %s)",
    async (cleanupThrows) => {
      const importStateDir = state.statePath("cleanup-owner");
      const env = { ...state.env, OPENCLAW_STATE_DIR: importStateDir };
      const storeOptions = { namespace: "old-rows", maxEntries: 4 };
      const ambient = createPluginStateKeyedStore<string>("migration-fixture", {
        ...storeOptions,
        env: state.env,
      });
      const owner = createPluginStateKeyedStore<string>("migration-fixture", {
        ...storeOptions,
        env,
      });
      await ambient.register("legacy", "ambient");
      await owner.register("legacy", "owner");
      const cleanupScopes: Array<string | undefined> = [];
      const laterObservedCleanup: boolean[] = [];
      const plans: ChannelLegacyStateMigrationPlan[] = [
        {
          kind: "plugin-state-import",
          label: "Scoped rows",
          sourcePath: "plugin state:old-rows",
          targetPath: "plugin state:first-import",
          pluginId: "migration-fixture",
          namespace: "first-import",
          maxEntries: 4,
          scopeKey: "",
          stateDir: importStateDir,
          readEntries: () => [{ key: "first", value: "imported" }],
          removeSource: async () => {
            cleanupScopes.push(process.env.OPENCLAW_STATE_DIR);
            if (cleanupThrows) {
              throw new Error("synthetic cleanup failure");
            }
            const scopedStore = createPluginStateKeyedStore("migration-fixture", storeOptions);
            await scopedStore.delete("legacy");
          },
        },
        {
          kind: "plugin-state-import",
          label: "Later rows",
          sourcePath: "plugin state:unrelated-rows",
          targetPath: "plugin state:later-import",
          pluginId: "migration-fixture",
          namespace: "later-import",
          maxEntries: 4,
          scopeKey: "",
          stateDir: importStateDir,
          readEntries: async () => {
            const scopedStore = createPluginStateKeyedStore("migration-fixture", storeOptions);
            laterObservedCleanup.push((await scopedStore.lookup("legacy")) === undefined);
            return [{ key: "later", value: "completed" }];
          },
        },
      ];

      const result = await runLegacyMigrationPlans(plans);

      expect(cleanupScopes).toEqual([importStateDir]);
      expect(laterObservedCleanup).toEqual([!cleanupThrows]);
      expect(await ambient.lookup("legacy")).toBe("ambient");
      expect(await owner.lookup("legacy")).toBe(cleanupThrows ? "owner" : undefined);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(state.stateDir);
      expect(result.changes).toContainEqual(expect.stringContaining("Migrated 1 Later rows entry"));
      expect(result.warnings).toEqual(
        cleanupThrows ? [expect.stringContaining("synthetic cleanup failure")] : [],
      );
    },
  );
});
