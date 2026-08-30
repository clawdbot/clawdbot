import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { retainLegacyDefaultAgentId } from "../../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { installPluginMetadataOwner } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../../plugins/plugin-cache.js";
import { createPluginMetadataOwner } from "../../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import { createColdPluginFixture } from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
} from "../../plugins/test-helpers/fs-fixtures.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveReadOnlyChannelPluginsForConfig } from "./read-only.js";

const tempDirs: string[] = [];

beforeEach(() => resetPluginRuntimeStateForTest());
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  closeOpenClawStateDatabaseForTest();
  cleanupTrackedTempDirs(tempDirs);
});

describe("read-only channel plugin legacy workspace discovery", () => {
  it.each([
    { name: "retains the compatibility owner's explicit workspace", retainedOwner: "ops" },
    { name: "discovers plugins from every explicit agent workspace", retainedOwner: undefined },
  ])("$name", ({ retainedOwner }) => {
    const root = fs.realpathSync(makeTrackedTempDir("openclaw-read-only-workspaces", tempDirs));
    const env = {
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
    };
    const fixtures = ["ops", "research"].map((agentId) => {
      const workspaceDir = path.join(root, agentId);
      const pluginId = `${agentId}-chat-plugin`;
      const rootDir = path.join(workspaceDir, ".openclaw", "extensions", pluginId);
      fs.mkdirSync(rootDir, { recursive: true });
      return {
        agentId,
        workspaceDir,
        plugin: createColdPluginFixture({
          rootDir,
          pluginId,
          channelId: `${agentId}-chat`,
          manifest: { providers: [], providerAuthChoices: [] },
        }),
      };
    });
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: Object.fromEntries(
          fixtures.map(({ agentId, workspaceDir }) => [agentId, { workspace: workspaceDir }]),
        ),
      },
      channels: Object.fromEntries(
        fixtures.map(({ plugin }) => [plugin.channelId, { enabled: true }]),
      ),
      plugins: {
        allow: fixtures.map(({ plugin }) => plugin.pluginId),
        entries: Object.fromEntries(
          fixtures.map(({ plugin }) => [plugin.pluginId, { enabled: true }]),
        ),
      },
    };
    retainLegacyDefaultAgentId(cfg, retainedOwner);
    const pluginCache = createPluginCache();
    const owner = createPluginMetadataOwner(pluginCache);
    const releaseOwner = installPluginMetadataOwner(owner, pluginCache);
    try {
      const metadata = owner.prepare({ config: cfg, env });
      owner.publish(metadata, { config: cfg, env });
      expect(metadata.selectedSnapshot.workspaceDir).toBe(
        retainedOwner ? path.join(root, retainedOwner) : undefined,
      );

      const resolution = resolveReadOnlyChannelPluginsForConfig(cfg, {
        env,
        includePersistedAuthState: false,
      });

      expect(resolution.plugins.map((plugin) => plugin.id).toSorted()).toEqual([
        "ops-chat",
        "research-chat",
      ]);
      expect(resolution.manifestRecords.map((plugin) => plugin.id).toSorted()).toEqual([
        "ops-chat-plugin",
        "research-chat-plugin",
      ]);
      expect(resolution.missingConfiguredChannelIds).toEqual([]);
      for (const { plugin } of fixtures) {
        expect(fs.existsSync(plugin.runtimeMarker)).toBe(false);
      }
    } finally {
      releaseOwner();
    }
  });
});
