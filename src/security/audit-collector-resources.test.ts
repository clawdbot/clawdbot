import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  associatePluginRegistryResourceAlias,
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
  requirePluginRegistryResourceScope,
  retainPluginRegistryResources,
} from "../plugins/registry-resources.js";
import {
  captureActivePluginRegistrySnapshot,
  getPluginRegistryForContext,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runSecurityAuditCore } from "./audit.js";
import type { SecurityAuditFinding } from "./audit.types.js";

const loadSnapshot = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/runtime/metadata-registry-loader.js").loadPluginMetadataRegistrySnapshot
  >(),
);
vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: loadSnapshot,
}));
vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config: OpenClawConfig }) => ({
    config,
    changes: [],
    autoEnabledReasons: {},
  }),
}));

const config: OpenClawConfig = {
  agents: { entries: { main: {} } },
  plugins: { allow: ["fixture-audit", "fixture-failure"] },
};

function createNativeCollectorSource() {
  const registry = createEmptyPluginRegistry();
  const hostClaim = createPluginRegistryResourceOwner(registry, "scoped");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE audit_fixture (value TEXT)");
  db.prepare("INSERT INTO audit_fixture VALUES (?)").run("original generation");
  const dispose = vi.fn(() => db.close());
  registerPluginRegistryResourceDisposer(registry, "fixture-audit", {
    id: "native-audit",
    dispose,
  });
  return { registry, hostClaim, db, dispose };
}

describe("plugin audit collector resources", () => {
  it.each(["active", "snapshot"] as const)(
    "keeps the %s collector's native source and selection through replacement",
    async (placement) => {
      await withOpenClawTestState(
        { label: "audit-collector-resources", scenario: "minimal" },
        async (state) => {
          const previous = captureActivePluginRegistrySnapshot();
          const native = createNativeCollectorSource();
          // A publication can contain registrations borrowed from a scoped source.
          // Its host claim ends at replacement; in-flight diagnostics need their own claim.
          const selectedRegistry =
            placement === "active"
              ? associatePluginRegistryResourceAlias({ ...native.registry }, native.registry)
              : native.registry;
          const replacement = createEmptyPluginRegistry();
          const entered = createDeferredCore();
          const release = createDeferredCore();
          const selections: Array<ReturnType<typeof getPluginRegistryForContext>> = [];
          const collector = vi.fn(async (): Promise<SecurityAuditFinding[]> => {
            selections.push(getPluginRegistryForContext());
            entered.resolve();
            await release.promise;
            selections.push(getPluginRegistryForContext());
            // Lazy registry consumers admit their native source in the current finite operation.
            const selected = getPluginRegistryForContext();
            if (selected !== selectedRegistry) {
              throw new Error("Collector resolved another registry generation");
            }
            requirePluginRegistryResourceScope().retain(selected);
            const row = native.db.prepare("SELECT value FROM audit_fixture").get();
            return [
              {
                checkId: "plugins.fixture-audit.synthetic",
                severity: "info",
                title: "Synthetic diagnostic",
                detail: typeof row?.value === "string" ? row.value : "missing native row",
              },
            ];
          });
          selectedRegistry.securityAuditCollectors.push(
            {
              pluginId: "fixture-audit",
              pluginName: "Fixture audit",
              collector,
              source: "synthetic",
              rootDir: state.root,
            },
            {
              pluginId: "fixture-failure",
              pluginName: "Fixture failure",
              collector: async () => {
                throw new Error("Synthetic collector unavailable");
              },
              source: "synthetic",
              rootDir: state.root,
            },
          );
          setActivePluginRegistry(placement === "active" ? selectedRegistry : replacement);
          loadSnapshot.mockImplementation(() => ({
            registry: selectedRegistry,
            ...retainPluginRegistryResources(selectedRegistry),
          }));
          const audit = runSecurityAuditCore({
            config,
            sourceConfig: config,
            env: state.env,
            stateDir: state.stateDir,
            configPath: state.configPath,
            includeFilesystem: false,
            includeChannelSecurity: false,
            deep: false,
            loadPluginSecurityCollectors: true,
          });
          try {
            await Promise.race([
              entered.promise,
              audit.then(() => {
                throw new Error("Audit completed without invoking its collector");
              }),
            ]);
            setActivePluginRegistry(replacement);
            native.hostClaim.release();
            // Last-user disposal is queued synchronously; observe it before allowing the callback to finish.
            await Promise.resolve();
            const openWhileHeld = native.db.isOpen;
            release.resolve();
            const report = await audit;
            expect(openWhileHeld).toBe(true);
            expect(selections).toEqual([selectedRegistry, selectedRegistry]);
            expect(report.findings).toContainEqual({
              checkId: "plugins.fixture-audit.synthetic",
              severity: "info",
              title: "Synthetic diagnostic",
              detail: "original generation",
            });
            expect(report.findings).toContainEqual({
              checkId: "plugins.fixture-failure.security_audit_failed",
              severity: "warn",
              title: "Plugin security audit collector failed",
              detail: "fixture-failure: Error: Synthetic collector unavailable",
            });
            expect(collector).toHaveBeenCalledOnce();
            await drainPluginRegistryResourceDisposals();
            expect(native.dispose).toHaveBeenCalledOnce();
            expect(native.db.isOpen).toBe(false);
          } finally {
            release.resolve();
            await audit.catch(() => undefined);
            native.hostClaim.release();
            await drainPluginRegistryResourceDisposals();
            restoreActivePluginRegistrySnapshot(previous);
            loadSnapshot.mockReset();
          }
        },
      );
    },
  );

  it("keeps disabled collector discovery cold", async () => {
    await withOpenClawTestState(
      { label: "audit-collectors-disabled", scenario: "minimal" },
      async (state) => {
        const previous = captureActivePluginRegistrySnapshot();
        const registry = createEmptyPluginRegistry();
        const collector = vi.fn(async () => []);
        registry.securityAuditCollectors.push({
          pluginId: "fixture-audit",
          pluginName: "Fixture audit",
          collector,
          source: "synthetic",
          rootDir: state.root,
        });
        setActivePluginRegistry(registry);
        try {
          await runSecurityAuditCore({
            config,
            sourceConfig: config,
            env: state.env,
            stateDir: state.stateDir,
            configPath: state.configPath,
            includeFilesystem: false,
            includeChannelSecurity: false,
            deep: false,
            loadPluginSecurityCollectors: false,
          });
          expect(collector).not.toHaveBeenCalled();
          expect(loadSnapshot).not.toHaveBeenCalled();
        } finally {
          restoreActivePluginRegistrySnapshot(previous);
          loadSnapshot.mockReset();
        }
      },
    );
  });
});
