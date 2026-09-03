import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnabledBundleLspConfig } from "../plugins/bundle-lsp.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
import {
  createBundleMcpTempHarness,
  writeBundleTextFiles,
} from "../plugins/bundle-mcp.test-support.js";
import { withPluginMetadataSnapshotScope } from "../plugins/current-plugin-metadata-snapshot.js";
import {
  bindPluginMetadataSnapshotCache,
  createPluginCache,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";
import { loadEnabledBundleAgentSettingsSnapshot } from "./agent-project-settings-snapshot.js";

const tempHarness = createBundleMcpTempHarness();

afterEach(async () => {
  vi.restoreAllMocks();
  clearPluginMetadataLifecycleCaches();
  await tempHarness.cleanup();
});

async function createBundle() {
  const rootDir = await tempHarness.createTempDir("openclaw-bundle-metadata-cache-");
  await writeBundleTextFiles(rootDir, {
    ".claude-plugin/plugin.json": JSON.stringify({ name: "cache-bundle" }),
    ".mcp.json": JSON.stringify({ mcpServers: { bundled: { command: "original" } } }),
    ".lsp.json": JSON.stringify({ lspServers: { language: { command: "language" } } }),
    "settings.json": JSON.stringify({ hideThinkingBlock: true, shellPath: "/blocked" }),
  });
  const cache = createPluginCache();
  const snapshot = withPluginCache(cache, () => {
    const prepared = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: "cache-bundle",
          origin: "global",
          format: "bundle",
          bundleFormat: "claude",
          rootDir,
          settingsFiles: ["settings.json"],
        },
      ],
    });
    bindPluginMetadataSnapshotCache(prepared);
    return prepared;
  });
  const cfg = { plugins: { entries: { "cache-bundle": { enabled: true } } } };
  return { rootDir, cache, snapshot, cfg, workspaceDir: rootDir };
}

describe("bundle metadata cache ownership", () => {
  it.each(["provided", "current"] as const)(
    "keeps %s bundle discovery isolated between plugin cache generations",
    async (registrySource) => {
      const bundle = await createBundle();
      const params = {
        workspaceDir: bundle.workspaceDir,
        cfg: bundle.cfg,
        ...(registrySource === "provided"
          ? { manifestRegistry: bundle.snapshot.manifestRegistry }
          : {}),
      };
      const read = () => loadSessionMcpConfig(params).loaded.mcpServers.bundled?.command;
      const readOriginal = () =>
        withPluginMetadataSnapshotScope(bundle.snapshot, read, {
          config: bundle.cfg,
          trustConfigIdentity: true,
        });
      expect(readOriginal()).toBe("original");
      await fs.writeFile(
        path.join(bundle.rootDir, ".mcp.json"),
        JSON.stringify({
          mcpServers: { bundled: { command: "replacement" } },
        }),
      );
      const candidate = withPluginCache(createPluginCache(), () => {
        const snapshot = createPluginMetadataSnapshotFixture({
          plugins: [...bundle.snapshot.plugins],
        });
        bindPluginMetadataSnapshotCache(snapshot);
        return snapshot;
      });
      expect(
        withPluginMetadataSnapshotScope(candidate, read, {
          config: bundle.cfg,
          trustConfigIdentity: true,
        }),
      ).toBe("replacement");
      expect(readOriginal()).toBe("original");
    },
  );

  it("reuses bundle file facts across MCP, LSP, settings, and live session policy", async () => {
    const bundle = await createBundle();
    await withPluginCache(bundle.cache, async () => {
      const params = {
        workspaceDir: bundle.workspaceDir,
        cfg: bundle.cfg,
        manifestRegistry: bundle.snapshot.manifestRegistry,
      };
      const settingsParams = {
        cwd: bundle.workspaceDir,
        cfg: bundle.cfg,
        pluginMetadataSnapshot: bundle.snapshot,
      };
      loadEnabledBundleMcpConfig(params);
      loadEnabledBundleLspConfig(params);
      loadEnabledBundleAgentSettingsSnapshot(settingsParams);
      loadSessionMcpConfig(params);
      const probes = [
        vi.spyOn(fsSync, "existsSync"),
        vi.spyOn(fsSync, "realpathSync"),
        vi.spyOn(fsSync, "readFileSync"),
        vi.spyOn(fsSync, "readSync"),
        vi.spyOn(fsSync, "statSync"),
        vi.spyOn(fsSync, "lstatSync"),
      ];
      const current = loadSessionMcpConfig({
        ...params,
        cfg: { ...bundle.cfg, mcp: { servers: { custom: { command: "custom" } } } },
      });
      expect(current.loaded.mcpServers.bundled?.command).toBe("original");
      expect(current.loaded.mcpServers.custom?.command).toBe("custom");
      expect(
        loadSessionMcpConfig({ ...params, toolOverrides: { mcpServers: { bundled: false } } })
          .loaded.mcpServers,
      ).toEqual({});
      expect(loadEnabledBundleMcpConfig(params).config.mcpServers.bundled?.command).toBe(
        "original",
      );
      expect(loadEnabledBundleLspConfig(params).config.lspServers.language?.command).toBe(
        "language",
      );
      const settings = loadEnabledBundleAgentSettingsSnapshot(settingsParams);
      expect(settings.hideThinkingBlock).toBe(true);
      expect(settings.shellPath).toBeUndefined();
      for (const probe of probes) {
        expect(probe).not.toHaveBeenCalled();
      }
    });
  });

  it("reads explicitly supplied settings snapshots from their original plugin cache", async () => {
    const bundle = await createBundle();
    const params = {
      cwd: bundle.workspaceDir,
      cfg: bundle.cfg,
      pluginMetadataSnapshot: bundle.snapshot,
    };
    expect(
      withPluginCache(bundle.cache, () => loadEnabledBundleAgentSettingsSnapshot(params))
        .hideThinkingBlock,
    ).toBe(true);
    await fs.writeFile(
      path.join(bundle.rootDir, "settings.json"),
      JSON.stringify({ hideThinkingBlock: false }),
    );
    expect(
      withPluginCache(createPluginCache(), () => loadEnabledBundleAgentSettingsSnapshot(params))
        .hideThinkingBlock,
    ).toBe(true);
  });
});
