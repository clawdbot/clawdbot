import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createColdPluginFixture } from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const registryLoads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../plugins/plugin-registry-snapshot.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-registry-snapshot.js")>();
  return {
    ...actual,
    loadPluginRegistrySnapshotWithMetadata: (
      ...args: Parameters<typeof actual.loadPluginRegistrySnapshotWithMetadata>
    ) => {
      registryLoads.count += 1;
      return actual.loadPluginRegistrySnapshotWithMetadata(...args);
    },
  };
});

vi.mock("./status.scan.bootstrap-shared.js", () => ({
  createStatusScanCoreBootstrap: async () => ({
    tailscaleMode: "off",
    tailscaleDnsPromise: Promise.resolve(null),
    updatePromise: Promise.resolve({ installKind: "unknown" }),
    agentStatusPromise: Promise.resolve({
      defaultId: "main",
      agents: [],
      totalSessions: 0,
      bootstrapPendingCount: 0,
    }),
    gatewayProbePromise: Promise.resolve({ gatewayReachable: false }),
    resolveTailscaleHttpsUrl: async () => null,
    skipColdStartNetworkChecks: false,
  }),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async () => {
    throw new Error("gateway unavailable in status snapshot test");
  }),
}));

const { collectStatusScanOverview } = await import("./status.scan-overview.js");

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

it("builds plugin metadata once for a status scan", async () => {
  await withOpenClawTestState(
    {
      prefix: "openclaw-status-plugin-metadata-",
      layout: "split",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    },
    async (state) => {
      const pluginDir = state.path("cold-plugin");
      fs.mkdirSync(pluginDir, { recursive: true });
      createColdPluginFixture({ rootDir: pluginDir, pluginId: "cold-plugin" });
      await state.writeConfig({
        memory: {
          search: {
            remote: { apiKey: "${OPENCLAW_STATUS_PLUGIN_METADATA_KEY}" },
          },
        },
        plugins: {
          load: { paths: [pluginDir] },
          entries: { "cold-plugin": { enabled: true } },
        },
      });
      clearPluginMetadataLifecycleCaches();
      registryLoads.count = 0;

      const overview = await collectStatusScanOverview({
        commandName: "status --json",
        opts: {},
        showSecrets: false,
        includeChannelsData: false,
        skipUpdateCheck: true,
        resolveHasConfiguredChannels: () => false,
      });

      expect(overview.cfg.plugins?.entries?.["cold-plugin"]?.enabled).toBe(true);
      expect(registryLoads.count).toBe(1);
    },
  );
});
