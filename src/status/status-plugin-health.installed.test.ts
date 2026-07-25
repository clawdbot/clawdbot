// Installed plugin health snapshot tests cover should-run drift wiring: the eager
// startup plan is read, deferred channel plugins are excluded, and the not-loaded
// remainder surfaces as drift in detailed status.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveGatewayStartupPluginActivationConfig } from "../gateway/plugin-activation-runtime-config.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import {
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
  loadGatewayStartupPluginPlan,
} from "../plugins/gateway-startup-plugin-ids.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { formatDetailedPluginHealth } from "./status-plugin-health.js";
import { collectInstalledPluginHealthSnapshot } from "./status-plugin-health.runtime.js";

vi.mock("../channels/plugins/read-only.js", () => ({
  resolveReadOnlyChannelPluginsForConfig: vi.fn(),
}));
// Keep the installed disk-scan report empty and deterministic so the snapshot's
// plugin records come only from the seeded runtime registry.
vi.mock("../plugins/status.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/status.js")>();
  const emptyReport = { plugins: [], diagnostics: [] } as unknown as ReturnType<
    typeof actual.buildPluginSnapshotReport
  >;
  return {
    ...actual,
    buildPluginSnapshotReport: vi.fn(() => emptyReport),
    buildPluginCompatibilityNotices: vi.fn(() => []),
  } as typeof actual;
});
// Override only the startup-plan resolver; preserve every other real export so any
// eager importer in the graph keeps working.
vi.mock("../plugins/gateway-startup-plugin-ids.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/gateway-startup-plugin-ids.js")>();
  return {
    ...actual,
    loadGatewayStartupPluginPlan: vi.fn(),
    // Default to no unregistered providers so the should-run tests are unaffected; the
    // memory-provider tests below override per case. collectRegisteredEmbeddingProviderIds
    // stays real (it just reads the seeded registry + core embedding registry).
    collectUnregisteredConfiguredMemoryEmbeddingProviders: vi.fn(() => []),
  } as typeof actual;
});
// The startup-plan activation assembly is the gateway's own shared helper; mock it to
// identity (return the runtime config) so the status wiring stays deterministic. The helper's
// real auto-enable + merge behavior is covered by its own unit test and the gateway startup tests.
vi.mock("../gateway/plugin-activation-runtime-config.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../gateway/plugin-activation-runtime-config.js")>();
  return {
    ...actual,
    resolveGatewayStartupPluginActivationConfig: vi.fn(
      (params: { runtimeConfig: unknown }) =>
        params.runtimeConfig as ReturnType<
          typeof actual.resolveGatewayStartupPluginActivationConfig
        >,
    ),
  } as typeof actual;
});

const resolveReadOnlyChannelPluginsForConfigMock = vi.mocked(
  resolveReadOnlyChannelPluginsForConfig,
);
const loadGatewayStartupPluginPlanMock = vi.mocked(loadGatewayStartupPluginPlan);
const resolveGatewayStartupPluginActivationConfigMock = vi.mocked(
  resolveGatewayStartupPluginActivationConfig,
);
const collectUnregisteredConfiguredMemoryEmbeddingProvidersMock = vi.mocked(
  collectUnregisteredConfiguredMemoryEmbeddingProviders,
);

afterEach(() => {
  resolveReadOnlyChannelPluginsForConfigMock.mockReset();
  loadGatewayStartupPluginPlanMock.mockReset();
  resolveGatewayStartupPluginActivationConfigMock.mockClear();
  collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReset();
  // Re-establish the empty default so the next test starts with no unregistered providers.
  collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReturnValue([]);
  clearRuntimeConfigSnapshot();
  resetPluginRuntimeStateForTest();
  resetPluginStateStoreForTests();
});

describe("installed plugin health should-run drift", () => {
  it("excludes deferred channel plugins and flags the not-loaded remainder as drift", async () => {
    await withStateDirEnv("openclaw-status-should-run-drift-", async () => {
      resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
        loadFailures: [],
        missingConfiguredChannelIds: [],
      } as never);
      loadGatewayStartupPluginPlanMock.mockReturnValue({
        channelPluginIds: [],
        // deferred-chan finishes loading only after listen, so it must not count as drift.
        configuredDeferredChannelPluginIds: ["deferred-chan"],
        pluginIds: ["deferred-chan", "planned-missing", "runtime-ok"],
      });

      const registry = createEmptyPluginRegistry();
      registry.plugins.push({ id: "runtime-ok", status: "loaded", enabled: true } as never);
      setActivePluginRegistry(registry, "runtime-ok", "default", "/tmp/ws");

      const rawConfig = {} as never;
      const snapshot = await collectInstalledPluginHealthSnapshot({
        config: rawConfig,
        workspaceDir: "/tmp/ws",
      });

      // Plan resolved from the auto-enabled effective config with the raw config as the
      // activation source — matching gateway boot, so auto-enabled plugins are not missed.
      expect(loadGatewayStartupPluginPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: rawConfig, activationSourceConfig: rawConfig }),
      );
      // Deferred channel plugin dropped from the eager should-run set.
      expect(snapshot.shouldRunPluginIds).toEqual(["planned-missing", "runtime-ok"]);

      const text = formatDetailedPluginHealth(snapshot);
      expect(text).toContain("Loaded: 1 (runtime-ok)");
      expect(text).toContain("Configured to run but not loaded: 1 (planned-missing)");
      expect(text).not.toContain("deferred-chan");
    });
  });

  it("builds the plan via the shared gateway helper using source + runtime config", async () => {
    await withStateDirEnv("openclaw-status-should-run-source-cfg-", async () => {
      resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
        loadFailures: [],
        missingConfiguredChannelIds: [],
      } as never);
      loadGatewayStartupPluginPlanMock.mockReturnValue({
        channelPluginIds: [],
        configuredDeferredChannelPluginIds: [],
        pluginIds: [],
      });
      // /status passes the live runtime config; the activation source must be the original
      // operator source config, and the effective config must be assembled from the runtime
      // config (so runtime/defaulted fields survive) — via the shared gateway-boot helper.
      const sourceConfig = { plugins: { entries: {} } } as never;
      const runtimeConfig = { plugins: { entries: { extra: { enabled: true } } } } as never;
      setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      await collectInstalledPluginHealthSnapshot({
        config: runtimeConfig,
        workspaceDir: "/tmp/ws",
      });

      // The shared gateway-boot helper assembles the effective config from the runtime config
      // with the operator source config as the activation source (not the runtime snapshot).
      expect(resolveGatewayStartupPluginActivationConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({ runtimeConfig, activationSourceConfig: sourceConfig }),
      );
      // The plan is resolved from that effective config (here the helper's identity output =
      // runtimeConfig) with the operator source config as the activation source.
      expect(loadGatewayStartupPluginPlanMock).toHaveBeenCalledWith(
        expect.objectContaining({ config: runtimeConfig, activationSourceConfig: sourceConfig }),
      );
    });
  });

  it("omits the should-run set entirely when no config is provided", async () => {
    await withStateDirEnv("openclaw-status-should-run-no-config-", async () => {
      resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
        loadFailures: [],
        missingConfiguredChannelIds: [],
      } as never);
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      const snapshot = await collectInstalledPluginHealthSnapshot({ workspaceDir: "/tmp/ws" });

      expect(snapshot.shouldRunPluginIds).toBeUndefined();
      expect(loadGatewayStartupPluginPlanMock).not.toHaveBeenCalled();
      expect(formatDetailedPluginHealth(snapshot)).not.toContain(
        "Configured to run but not loaded:",
      );
    });
  });
});

describe("installed plugin health unregistered memory embedding providers", () => {
  it("surfaces configured memory embedding providers the runtime registry does not register", async () => {
    await withStateDirEnv("openclaw-status-memory-embed-", async () => {
      resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
        loadFailures: [],
        missingConfiguredChannelIds: [],
      } as never);
      loadGatewayStartupPluginPlanMock.mockReturnValue({
        channelPluginIds: [],
        configuredDeferredChannelPluginIds: [],
        pluginIds: [],
      });
      collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReturnValue([
        { configuredId: "custom-embed", source: "provider" },
      ]);
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      const snapshot = await collectInstalledPluginHealthSnapshot({
        config: {} as never,
        workspaceDir: "/tmp/ws",
      });

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toEqual([
        { configuredId: "custom-embed", source: "provider" },
      ]);
      // The mismatch is checked against the live registry's embedding providers (collected
      // into a Set), so a CLI/empty-registry process can never false-report "unregistered".
      expect(collectUnregisteredConfiguredMemoryEmbeddingProvidersMock).toHaveBeenCalledWith(
        expect.objectContaining({ registeredProviderIds: expect.any(Set) }),
      );
      expect(formatDetailedPluginHealth(snapshot)).toContain(
        "Configured memory provider not registered: 1 (custom-embed (memorySearch.provider))",
      );
    });
  });

  it("skips the check and renders no line when no runtime registry is active", async () => {
    await withStateDirEnv("openclaw-status-memory-embed-no-registry-", async () => {
      // No active runtime registry (a fresh CLI process that never started a gateway).
      resetPluginRuntimeStateForTest();
      resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
        loadFailures: [],
        missingConfiguredChannelIds: [],
      } as never);
      loadGatewayStartupPluginPlanMock.mockReturnValue({
        channelPluginIds: [],
        configuredDeferredChannelPluginIds: [],
        pluginIds: [],
      });
      // Even if the resolver would report something, the null-registry guard must skip it
      // (a CLI/empty-registry process must never false-report "unregistered").
      collectUnregisteredConfiguredMemoryEmbeddingProvidersMock.mockReturnValue([
        { configuredId: "custom-embed", source: "provider" },
      ]);

      const snapshot = await collectInstalledPluginHealthSnapshot({
        config: {} as never,
        workspaceDir: "/tmp/ws",
      });

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toBeUndefined();
      expect(collectUnregisteredConfiguredMemoryEmbeddingProvidersMock).not.toHaveBeenCalled();
      expect(formatDetailedPluginHealth(snapshot)).not.toContain(
        "Configured memory provider not registered:",
      );
    });
  });

  it("omits the check when no config is provided", async () => {
    await withStateDirEnv("openclaw-status-memory-embed-no-config-", async () => {
      resolveReadOnlyChannelPluginsForConfigMock.mockReturnValue({
        loadFailures: [],
        missingConfiguredChannelIds: [],
      } as never);
      setActivePluginRegistry(createEmptyPluginRegistry(), "empty", "default", "/tmp/ws");

      const snapshot = await collectInstalledPluginHealthSnapshot({ workspaceDir: "/tmp/ws" });

      expect(snapshot.unregisteredMemoryEmbeddingProviders).toBeUndefined();
      expect(collectUnregisteredConfiguredMemoryEmbeddingProvidersMock).not.toHaveBeenCalled();
    });
  });
});
