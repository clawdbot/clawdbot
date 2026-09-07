import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import { clearPluginLoaderCache, writePlugin } from "./loader.test-fixtures.js";
import {
  drainPluginRegistryResourceDisposals,
  PluginRegistryResourceScope,
} from "./registry-resources.js";

it.each(["help", "machine"] as const)(
  "keeps %s descriptors within their actual resource lifetime",
  async (mode) => {
    const state = await createOpenClawTestState({
      prefix: "openclaw-cli-descriptor-resources-",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const databasePath = state.path("descriptor.sqlite");
    const symbol = Symbol.for("openclaw.cliDescriptorResourcesTest");
    const registrations: Array<{ db: DatabaseSync; disposals: number }> = [];
    Reflect.set(globalThis, symbol, registrations);
    const resources = new PluginRegistryResourceScope();
    const nextResources = new PluginRegistryResourceScope();
    const session = createPluginCliLoadSession();
    try {
      const plugin = writePlugin({
        id: "resource-descriptor",
        dir: state.path("plugin"),
        body: `module.exports = { id: "resource-descriptor", register(api) {
          const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(databasePath)});
          db.exec("CREATE TABLE IF NOT EXISTS proof(value INTEGER PRIMARY KEY); INSERT OR IGNORE INTO proof VALUES (1)");
          const registration = { db, disposals: 0 };
          globalThis[Symbol.for("openclaw.cliDescriptorResourcesTest")].push(registration);
          api.lifecycle.registerRuntimeLifecycle({ id: "db", dispose() { registration.disposals++; db.close(); } });
          api.registerCli(() => {}, { descriptors: [{ name: "resource-descriptor", description: "Synthetic descriptor", hasSubcommands: false,
            machineOutput() { return db.prepare("SELECT value FROM proof").get().value === 1; }
          }] });
        }};`,
      });
      const config = {
        plugins: {
          allow: [plugin.id],
          load: { paths: [plugin.file] },
          entries: { [plugin.id]: { enabled: true } },
        },
      };
      const params = {
        cfg: config,
        env: state.env,
        primaryCommand: plugin.id,
        session,
      };
      if (mode === "help") {
        const descriptors = await getPluginCliCommandDescriptors(config, state.env);
        clearPluginLoaderCache();
        await drainPluginRegistryResourceDisposals();
        expect(descriptors).toEqual([
          { name: plugin.id, description: "Synthetic descriptor", hasSubcommands: false },
        ]);
        expect(registrations).toHaveLength(1);
        expect(registrations[0]?.db.isOpen).toBe(false);
      } else {
        // Ownership lookup returns IDs only; a later executable lookup must reload its source.
        expect(await resolvePluginCliRootOwnerIds(params)).toEqual([plugin.id]);
        await drainPluginRegistryResourceDisposals();
        expect(registrations[0]?.db.isOpen).toBe(false);
        const descriptors = await resources.run(() => loadPluginCliDescriptors(params));
        clearPluginLoaderCache();
        await drainPluginRegistryResourceDisposals();
        expect(registrations).toHaveLength(2);
        expect(registrations[1]?.db.isOpen).toBe(true);
        expect(descriptors[0]?.machineOutput?.({ argv: [], stdoutIsTTY: false })).toBe(true);
        resources.release();
        await resources.waitForDisposals();
        expect(registrations[1]?.db.isOpen).toBe(false);
        const next = await nextResources.run(() => loadPluginCliDescriptors(params));
        expect(registrations).toHaveLength(3);
        expect(next[0]?.machineOutput?.({ argv: [], stdoutIsTTY: false })).toBe(true);
      }
      resources.release();
      nextResources.release();
      clearPluginLoaderCache();
      await drainPluginRegistryResourceDisposals();
      expect(registrations.every(({ db, disposals }) => !db.isOpen && disposals === 1)).toBe(true);
      const reopened = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          reopened
            .prepare("SELECT value FROM proof")
            .all()
            .map((row) => row.value),
        ).toEqual([1]);
      } finally {
        reopened.close();
      }
    } finally {
      session.close();
      resources.release();
      nextResources.release();
      clearPluginLoaderCache();
      await drainPluginRegistryResourceDisposals();
      for (const { db } of registrations) {
        if (db.isOpen) {
          db.close();
        }
      }
      Reflect.deleteProperty(globalThis, symbol);
      await state.cleanup();
    }
  },
);
