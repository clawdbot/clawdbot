import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { registerContextEngineInRegistry } from "../../../context-engine/registry.js";
import type { ContextEngine, ContextEngineHostCapability } from "../../../context-engine/types.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
  requirePluginRegistryResourceScope,
} from "../../../plugins/registry-resources.js";
import {
  captureActivePluginRegistrySnapshot,
  getActivePluginRegistry,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { collectContextEngineHostCompatibilityWarnings } from "./context-engine-host-compat.js";

const loadRegistry = vi.hoisted(() =>
  vi.fn<typeof import("../../../plugins/loader.js").loadPluginRegistryHandle>(),
);
vi.mock("../../../plugins/loader.js", () => ({ loadPluginRegistryHandle: loadRegistry }));
vi.mock("../../../agents/cli-backends.js", () => ({
  resolveCliBackendConfig: (runtimeId: string) => ({ id: runtimeId }),
}));
vi.mock("../../../agents/harness/policy.js", () => ({
  resolveAgentHarnessPolicy: () => ({ runtime: "fixture-cli" }),
}));
vi.mock("../../../agents/harness/registry.js", () => ({
  getRegisteredAgentHarness: () => undefined,
}));

describe("Doctor context-engine factory resource ownership", () => {
  it.each(["active", "acquired"] as const)(
    "inspects lazy native requirements from the %s registry without a CLI owner",
    async (placement) => {
      await withOpenClawTestState(
        { label: "doctor-engine-resources", scenario: "minimal" },
        async () => {
          const previous = captureActivePluginRegistrySnapshot();
          const active = createEmptyPluginRegistry();
          setActivePluginRegistry(active);
          const registry = placement === "active" ? active : createEmptyPluginRegistry();
          const engineId = `native-engine-${randomUUID()}`;
          const nativeRegistry = createEmptyPluginRegistry();
          const nativeHandle = createPluginRegistryResourceOwner(nativeRegistry, "scoped");
          const registryHandle = createPluginRegistryResourceOwner(registry, "scoped");
          const db = new DatabaseSync(":memory:");
          db.exec("CREATE TABLE requirements (capability TEXT)");
          db.prepare("INSERT INTO requirements VALUES (?)").run("assemble-before-prompt");
          const dispose = vi.fn(() => db.close());
          registerPluginRegistryResourceDisposer(nativeRegistry, "native-data", {
            id: "requirements",
            dispose,
          });
          let factoryFailure: unknown;
          let reads = 0;
          const readRequirements = () => {
            const row = db.prepare("SELECT capability FROM requirements").get();
            reads += 1;
            const requiredCapabilities: ContextEngineHostCapability[] = [];
            if (row?.capability === "assemble-before-prompt") {
              requiredCapabilities.push(row.capability);
            }
            return requiredCapabilities;
          };
          registerContextEngineInRegistry(
            registry,
            engineId,
            async (): Promise<ContextEngine> => {
              try {
                // A factory can discover an additional registration lazily, after initial plugin loading.
                requirePluginRegistryResourceScope().adopt({
                  registry: nativeRegistry,
                  release: nativeHandle.release,
                });
                readRequirements();
                await Promise.resolve();
                return {
                  info: {
                    id: engineId,
                    name: "Native requirements",
                    hostRequirements: {
                      "agent-run": { requiredCapabilities: readRequirements() },
                    },
                  },
                  async ingest() {
                    return { ingested: true };
                  },
                  async assemble({ messages }) {
                    return { messages, estimatedTokens: 0 };
                  },
                  async compact() {
                    return { ok: true, compacted: false };
                  },
                };
              } catch (error) {
                factoryFailure = error;
                throw error;
              }
            },
            "plugin:native-engine",
            { lifecycle: "runtime" },
          );
          loadRegistry.mockImplementation(() => {
            // Keep the actual core fallback that Doctor initialized before loading its private registry.
            for (const [id, registration] of getActivePluginRegistry()?.contextEngines ?? []) {
              if (!registry.contextEngines.has(id)) {
                registry.contextEngines.set(id, registration);
              }
            }
            return { registry, release: registryHandle.release };
          });
          const cfg: OpenClawConfig = {
            agents: { entries: { main: {} }, defaults: { model: "fixture/model" } },
            plugins: { slots: { contextEngine: engineId } },
          };
          try {
            const warnings = await collectContextEngineHostCompatibilityWarnings({
              cfg,
              doctorFixCommand: "openclaw doctor --fix",
            });
            expect(factoryFailure).toBeUndefined();
            expect(warnings.join("\n")).toContain(engineId);
            expect(warnings.join("\n")).toContain("assemble-before-prompt");
            expect(reads).toBe(2);
            await drainPluginRegistryResourceDisposals();
            expect(dispose).toHaveBeenCalledOnce();
            expect(db.isOpen).toBe(false);
          } finally {
            nativeHandle.release();
            registryHandle.release();
            await drainPluginRegistryResourceDisposals();
            restoreActivePluginRegistrySnapshot(previous);
            loadRegistry.mockReset();
          }
        },
      );
    },
  );
});
