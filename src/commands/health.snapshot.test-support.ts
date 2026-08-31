import { vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import type { collectGatewayHealthSnapshot } from "../gateway/health/collector.js";
import type { HealthSummary } from "../gateway/health/types.js";

export type LegacyHealthSnapshotParams = Partial<
  Omit<Parameters<typeof collectGatewayHealthSnapshot>[0], "audience">
> & {
  includeSensitive?: boolean;
};

function createLegacyHealthSnapshotCollector(collectSnapshot: typeof collectGatewayHealthSnapshot) {
  return (params: LegacyHealthSnapshotParams = {}): Promise<HealthSummary> => {
    const { includeSensitive, probe, ...rest } = params;
    return collectSnapshot({
      ...rest,
      audience: includeSensitive === false ? "public" : "admin",
      probe: probe !== false,
    });
  };
}

export type HealthTestPlugin = Pick<
  ChannelPlugin,
  "id" | "meta" | "capabilities" | "config" | "status"
>;

export async function loadFreshHealthModulesForTest(params: {
  getConfig: () => Record<string, unknown>;
  getSessionStorePath: () => string;
  getSessions: () => Record<string, { updatedAt?: number }>;
  getPlugins: () => HealthTestPlugin[];
  onSessionRead?: (scope: { agentId?: string; storePath?: string }) => void;
}) {
  vi.doMock("../config/config.js", () => ({
    getRuntimeConfig: params.getConfig,
    loadConfig: params.getConfig,
  }));
  vi.doMock("../config/sessions.js", () => ({
    resolveSessionStorePathCore: params.getSessionStorePath,
    resolveSessionFilePathCore: vi.fn(params.getSessionStorePath),
    loadSessionStore: params.getSessions,
    saveSessionStore: vi.fn().mockResolvedValue(undefined),
    readSessionUpdatedAt: vi.fn(() => undefined),
    recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
    updateLastRoute: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock("../config/sessions/paths.js", () => ({
    resolveSessionStorePathCore: params.getSessionStorePath,
  }));
  vi.doMock("../config/sessions/session-accessor.js", () => ({
    listSessionEntriesReadOnly: (scope?: { agentId?: string; storePath?: string }) => {
      params.onSessionRead?.(scope ?? {});
      return Object.entries(params.getSessions()).map(([sessionKey, entry]) => ({
        sessionKey,
        entry,
      }));
    },
  }));
  vi.doMock("../plugins/runtime/runtime-web-channel-plugin.js", () => ({
    webAuthExists: vi.fn(async () => true),
    getWebAuthAgeMs: vi.fn(() => 1234),
    readWebSelfId: vi.fn(() => ({ e164: null, jid: null })),
    logWebSelfId: vi.fn(),
    logoutWeb: vi.fn(),
  }));
  vi.doMock("../channels/plugins/read-only.js", () => ({
    listReadOnlyChannelPluginsForConfig: params.getPlugins,
  }));

  const [pluginsRuntime, pluginDegradedState, channelTestUtils, health] = await Promise.all([
    import("../plugins/runtime.js"),
    import("../plugins/runtime-degraded-state.js"),
    import("../test-utils/channel-plugins.js"),
    import("../gateway/health/collector.js"),
  ]);
  const collectSnapshot = health.collectGatewayHealthSnapshot;

  return {
    setActivePluginRegistry: pluginsRuntime.setActivePluginRegistry,
    setActiveDegradedPlugins: pluginDegradedState.setActiveDegradedPlugins,
    createChannelTestPluginBase: channelTestUtils.createChannelTestPluginBase,
    createTestRegistry: channelTestUtils.createTestRegistry,
    getHealthSnapshot: createLegacyHealthSnapshotCollector(collectSnapshot),
  };
}
