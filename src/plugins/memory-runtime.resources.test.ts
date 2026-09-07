import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { clearPluginRegistryLoadCache } from "./loader.js";
import { writePlugin } from "./loader.test-fixtures.js";
import { drainPluginRegistryResourceDisposals } from "./registry-resources.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";

type Registration = {
  db: DatabaseSync;
  closed: number;
  disposed: number;
  closeGate?: Promise<void>;
};

it.each(["copies", "replacement", "close failure"] as const)(
  "preserves standalone Memory resource ownership across %s",
  async (scenario) => {
    const state = await createOpenClawTestState({
      prefix: "openclaw-memory-module-ownership-",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    const registrations: Registration[] = [];
    const key = Symbol.for("openclaw.test.memory-module-resources");
    const globals = globalThis as Record<PropertyKey, unknown>;
    globals[key] = registrations;
    const plugin = writePlugin({
      id: "memory-resource-proof",
      dir: state.path("plugin"),
      body: `module.exports = {
        id: "memory-resource-proof", kind: "memory",
        register(api) {
          const db = new (require("node:sqlite").DatabaseSync)(":memory:");
          db.exec("CREATE TABLE proof (value TEXT); INSERT INTO proof VALUES ('retained')");
          const entry = { db, closed: 0, disposed: 0 };
          globalThis[Symbol.for("openclaw.test.memory-module-resources")].push(entry);
          api.lifecycle.registerRuntimeLifecycle({
            id: "sqlite", dispose() { db.close(); entry.disposed++; }
          });
          api.registerMemoryCapability({ runtime: {
            getMemorySearchManager: async () => ({ manager: {
              search: async () => db.prepare("SELECT value FROM proof").all(),
              readFile: async () => ({ status: "ok", text: "retained", path: "memory.md" })
            } }),
            resolveMemoryBackendConfig: () => ({ backend: "builtin" }),
            closeAllMemorySearchManagers: async () => {
              await entry.closeGate;
              db.prepare("SELECT value FROM proof").get();
              entry.closed++;
            }
          } });
        }
      };`,
    });
    fs.writeFileSync(
      state.path("plugin", "openclaw.plugin.json"),
      JSON.stringify({
        id: plugin.id,
        kind: "memory",
        configSchema: { type: "object", properties: {} },
      }),
    );
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          first: { workspace: state.workspaceDir },
          second: { workspace: state.path("second") },
        },
      },
      plugins: {
        enabled: true,
        allow: [plugin.id],
        load: { paths: [plugin.file] },
        slots: { memory: plugin.id },
      },
    };
    const first = await import("./memory-runtime.js");
    const firstTestApi = globals[Symbol.for("openclaw.memoryRuntimeTestApi")] as {
      resetStandaloneMemoryRegistrySlot(): void;
    };
    const gate = createDeferredCore();
    let draining: Promise<void> | undefined;
    try {
      resetPluginRuntimeStateForTest();
      const initial = await first.getActiveMemorySearchManagerCore({ cfg, agentId: "first" });
      expect(initial.manager).not.toBeNull();
      const original = registrations[0]!;
      expect(original.db.isOpen).toBe(true);
      vi.resetModules();
      const second = await import("./memory-runtime.js");
      const memoryState = await import("./memory-state.js");
      expect(second.getActiveMemorySearchManagerCore).not.toBe(
        first.getActiveMemorySearchManagerCore,
      );
      expect.soft(memoryState.hasMemoryRuntime()).toBe(true);
      await second.getActiveMemorySearchManagerCore({ cfg, agentId: "first" });
      expect(registrations).toHaveLength(1);
      original.closeGate = gate.promise;
      clearPluginRegistryLoadCache();
      draining = drainGlobalSingletonLifecycleState("restart");
      expect(original.db.isOpen).toBe(true);
      if (scenario === "replacement") {
        const replacement = await second.getActiveMemorySearchManagerCore({
          cfg,
          agentId: "second",
        });
        expect(replacement.manager).not.toBeNull();
        clearPluginRegistryLoadCache();
        gate.resolve();
        await draining;
        await drainPluginRegistryResourceDisposals();
        expect(memoryState.hasMemoryRuntime()).toBe(true);
        await expect(replacement.manager!.search("proof")).resolves.toEqual([
          { value: "retained" },
        ]);
      } else if (scenario === "close failure") {
        gate.reject(new Error("manager close failed"));
        await expect(draining).rejects.toThrow("Failed to reset global singleton lifecycle state");
        expect(original.db.isOpen).toBe(true);
        expect(memoryState.hasMemoryRuntime()).toBe(true);
        original.closeGate = undefined;
      } else {
        gate.resolve();
        await draining;
        await drainPluginRegistryResourceDisposals();
        expect.soft(original.closed).toBe(1);
        expect.soft(original.db.isOpen).toBe(false);
      }
      await drainGlobalSingletonLifecycleState("restart");
      await drainPluginRegistryResourceDisposals();
      expect(memoryState.hasMemoryRuntime()).toBe(false);
      for (const entry of registrations) {
        expect(entry.db.isOpen).toBe(false);
        expect(entry.disposed).toBe(1);
      }
    } finally {
      gate.resolve();
      await draining?.catch(() => undefined);
      for (const entry of registrations) {
        entry.closeGate = undefined;
      }
      firstTestApi.resetStandaloneMemoryRegistrySlot();
      const latest = globals[Symbol.for("openclaw.memoryRuntimeTestApi")] as typeof firstTestApi;
      latest.resetStandaloneMemoryRegistrySlot();
      clearPluginRegistryLoadCache();
      await drainPluginRegistryResourceDisposals();
      delete globals[key];
      await state.cleanup();
    }
  },
);
