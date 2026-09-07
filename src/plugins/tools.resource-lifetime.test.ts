import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { expect, it } from "vitest";
import { wrapToolWithAbortSignal } from "../agents/agent-tools.abort.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearPluginLoaderCache, writePlugin } from "./loader.test-fixtures.js";
import { PluginRegistryResourceScope } from "./registry-resources.js";
import { resolvePluginTools } from "./tools.js";

it("retains actual plugin SQLite execution after the caller's abort wrapper settles", async () => {
  const state = await createOpenClawTestState({
    prefix: "openclaw-plugin-tool-source-lifetime-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const databasePath = state.path("plugin.sqlite");
  const resources = new PluginRegistryResourceScope();
  const started = createDeferredCore();
  const finish = createDeferredCore();
  let disposed = false;
  let disposedAfterAbort: boolean | undefined;
  let persistedRows: unknown;
  try {
    const plugin = writePlugin({
      id: "sqlite-tool-lifetime",
      dir: state.path("plugin"),
      body: `module.exports = {
        id: "sqlite-tool-lifetime",
        register(api) {
          if (api.registrationMode !== "tool-discovery") return;
          const db = new (require("node:sqlite").DatabaseSync)(${JSON.stringify(databasePath)});
          db.exec("CREATE TABLE IF NOT EXISTS proof (value INTEGER)");
          let control;
          api.lifecycle.registerRuntimeLifecycle({
            id: "database",
            dispose() { db.close(); control?.disposed(); }
          });
          api.registerTool({
            name: "hold_sqlite", label: "Hold SQLite", description: "Synthetic source lifetime proof",
            parameters: { type: "object", properties: {} },
            async execute(_id, params) {
              control = params;
              control.started();
              await control.finish;
              db.prepare("INSERT INTO proof VALUES (?)").run(1);
              return { content: [], details: { written: true } };
            }
          }, { names: ["hold_sqlite"] });
        }
      };`,
    });
    fs.writeFileSync(
      state.path("plugin", "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        configSchema: { type: "object", properties: {} },
        contracts: { tools: ["hold_sqlite"] },
      }),
    );
    const [tool] = resources.run(() =>
      resolvePluginTools({
        context: {
          workspaceDir: state.workspaceDir,
          config: {
            plugins: {
              enabled: true,
              allow: [plugin.id],
              load: { paths: [plugin.file] },
              slots: { memory: "none" },
            },
          },
        },
        toolAllowlist: ["hold_sqlite"],
      }),
    );
    if (!tool) {
      throw new Error("Synthetic SQLite plugin tool was not loaded");
    }
    const abort = new AbortController();
    const execution = wrapToolWithAbortSignal(tool, abort.signal).execute("held", {
      started: () => started.resolve(),
      finish: finish.promise,
      disposed: () => {
        disposed = true;
      },
    });
    const cancelled = expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await started.promise;
    abort.abort();
    await cancelled;
    clearPluginLoaderCache();
    resources.release();
    await setImmediate();
    disposedAfterAbort = disposed;
  } finally {
    finish.resolve();
    clearPluginLoaderCache();
    resources.release();
    await resources.waitForDisposals();
    try {
      const reopened = new DatabaseSync(databasePath, { readOnly: true });
      try {
        persistedRows = reopened.prepare("SELECT value FROM proof").all();
      } finally {
        reopened.close();
      }
    } finally {
      await state.cleanup();
    }
  }
  expect(disposedAfterAbort).toBe(false);
  expect(persistedRows).toEqual([{ value: 1 }]);
  expect(disposed).toBe(true);
});
