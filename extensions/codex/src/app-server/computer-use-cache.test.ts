// Codex tests cover Computer Use shared plugin cache reconciliation.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureCodexComputerUseSharedPluginCache } from "./computer-use-cache.js";
import type { ResolvedCodexComputerUseConfig } from "./config.js";
import { useAutoCleanupTempDirTracker } from "./test-support.js";

describe("Codex Computer Use shared plugin cache", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("prefers the current ChatGPT.app bundled marketplace when both desktop app candidates exist", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const chatGptMarketplacePath = path.join(
      root,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    const legacyCodexMarketplacePath = path.join(
      root,
      "Applications",
      "Codex.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    await writeBundledComputerUsePlugin(chatGptMarketplacePath, "2.0.0");
    await writeBundledComputerUsePlugin(legacyCodexMarketplacePath, "1.0.0");

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome: path.join(root, "agent", "codex-home"),
      bundledMarketplacePathCandidates: [chatGptMarketplacePath, legacyCodexMarketplacePath],
      config: computerUseConfig(),
    });

    expect(result).toMatchObject({
      status: "shared",
      version: "2.0.0",
      targetPath: path.join(chatGptMarketplacePath, "plugins", "computer-use"),
    });
  });

  it("falls back to the legacy Codex.app bundled marketplace when ChatGPT.app is absent", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const chatGptMarketplacePath = path.join(
      root,
      "Applications",
      "ChatGPT.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    const legacyCodexMarketplacePath = path.join(
      root,
      "Applications",
      "Codex.app",
      "Contents",
      "Resources",
      "plugins",
      "openai-bundled",
    );
    await writeBundledComputerUsePlugin(legacyCodexMarketplacePath, "1.0.0");

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome: path.join(root, "agent", "codex-home"),
      bundledMarketplacePathCandidates: [chatGptMarketplacePath, legacyCodexMarketplacePath],
      config: computerUseConfig(),
    });

    expect(result).toMatchObject({
      status: "shared",
      version: "1.0.0",
      targetPath: path.join(legacyCodexMarketplacePath, "plugins", "computer-use"),
    });
  });

  it("copies the bundled plugin without removing versions used by live clients", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const bundledMarketplacePath = path.join(root, "Codex.app", "plugins", "openai-bundled");
    const bundledPluginRoot = path.join(bundledMarketplacePath, "plugins", "computer-use");
    await fs.mkdir(path.join(bundledPluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(bundledPluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "computer-use", version: "1.0.857" }),
    );
    const codexHome = path.join(root, "agent", "codex-home");
    const activeCachePath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.857",
    );
    const priorCachePath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.799",
    );
    await fs.mkdir(priorCachePath, { recursive: true });
    await fs.writeFile(path.join(priorCachePath, "live-client-marker"), "in use");
    await fs.symlink(bundledPluginRoot, activeCachePath, "dir");

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome,
      bundledMarketplacePath,
      config: computerUseConfig(),
    });

    expect(result).toMatchObject({
      status: "shared",
      changed: true,
      version: "1.0.857",
      removedStaleVersions: [],
    });
    await expect(
      fs.readFile(path.join(priorCachePath, "live-client-marker"), "utf8"),
    ).resolves.toBe("in use");
    const cacheEntries = await fs.readdir(path.dirname(activeCachePath), {
      withFileTypes: true,
    });
    const activeCacheEntry = cacheEntries.find((entry) => entry.name === "1.0.857");
    expect(activeCacheEntry?.isDirectory()).toBe(true);
    expect(activeCacheEntry?.isSymbolicLink()).toBe(false);
    expect((await fs.lstat(activeCachePath)).isDirectory()).toBe(true);
    expect((await fs.lstat(activeCachePath)).isSymbolicLink()).toBe(false);
    await expect(
      fs.access(path.join(activeCachePath, ".codex-plugin", "plugin.json")),
    ).resolves.toBe(undefined);
    await expect(fs.access(priorCachePath)).resolves.toBe(undefined);
  });

  it("leaves an up-to-date copied cache entry unchanged", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const bundledMarketplacePath = path.join(root, "Codex.app", "plugins", "openai-bundled");
    const bundledPluginRoot = path.join(bundledMarketplacePath, "plugins", "computer-use");
    await fs.mkdir(path.join(bundledPluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(bundledPluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "computer-use", version: "1.0.857" }),
    );
    const codexHome = path.join(root, "agent", "codex-home");
    const activeCachePath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.857",
    );
    await fs.mkdir(path.dirname(activeCachePath), { recursive: true });
    await fs.cp(bundledPluginRoot, activeCachePath, { recursive: true });

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome,
      bundledMarketplacePath,
      config: computerUseConfig(),
    });

    expect(result).toMatchObject({
      status: "shared",
      changed: false,
      version: "1.0.857",
      removedStaleVersions: [],
    });
    expect((await fs.lstat(activeCachePath)).isDirectory()).toBe(true);
    expect((await fs.lstat(activeCachePath)).isSymbolicLink()).toBe(false);
    await expect(
      fs.access(path.join(activeCachePath, ".codex-plugin", "plugin.json")),
    ).resolves.toBe(undefined);
  });

  it("refreshes a stale copied cache entry with the bundled version", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const bundledMarketplacePath = path.join(root, "Codex.app", "plugins", "openai-bundled");
    const bundledPluginRoot = path.join(bundledMarketplacePath, "plugins", "computer-use");
    await fs.mkdir(path.join(bundledPluginRoot, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(bundledPluginRoot, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "computer-use", version: "1.0.857" }),
    );
    const codexHome = path.join(root, "agent", "codex-home");
    const activeCachePath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "1.0.857",
    );
    await fs.mkdir(path.join(activeCachePath, ".codex-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(activeCachePath, ".codex-plugin", "plugin.json"),
      JSON.stringify({ name: "computer-use", version: "1.0.799" }),
    );

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome,
      bundledMarketplacePath,
      config: computerUseConfig(),
    });

    expect(result).toMatchObject({
      status: "shared",
      changed: true,
      version: "1.0.857",
      removedStaleVersions: [],
    });
    await expect(
      fs.readFile(path.join(activeCachePath, ".codex-plugin", "plugin.json"), "utf8"),
    ).resolves.toContain('"version":"1.0.857"');
  });

  it("leaves cache entries alone in independent mode", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome: path.join(root, "codex-home"),
      bundledMarketplacePath: path.join(root, "missing"),
      config: computerUseConfig({ pluginCacheMode: "independent" }),
    });

    expect(result).toMatchObject({
      status: "independent",
      changed: false,
      removedStaleVersions: [],
    });
  });

  it("preserves an explicitly named marketplace cache", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const codexHome = path.join(root, "agent", "codex-home");
    const cacheRoot = path.join(codexHome, "plugins", "cache", "desktop-tools", "computer-use");
    await fs.mkdir(path.join(cacheRoot, "1.0.101"), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, "1.0.102"), { recursive: true });

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome,
      bundledMarketplacePath: path.join(root, "missing-bundled-marketplace"),
      config: computerUseConfig({ marketplaceName: "desktop-tools" }),
    });

    expect(result).toMatchObject({
      status: "explicit_marketplace",
      changed: false,
      removedStaleVersions: [],
    });
    await expect(fs.access(path.join(cacheRoot, "1.0.101"))).resolves.toBe(undefined);
    await expect(fs.access(path.join(cacheRoot, "1.0.102"))).resolves.toBe(undefined);
  });

  it("preserves the default namespace when marketplacePath is explicit", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const codexHome = path.join(root, "agent", "codex-home");
    const cacheRoot = path.join(codexHome, "plugins", "cache", "openai-bundled", "computer-use");
    await fs.mkdir(path.join(cacheRoot, "1.0.101"), { recursive: true });
    await fs.mkdir(path.join(cacheRoot, "1.0.102"), { recursive: true });

    const result = await ensureCodexComputerUseSharedPluginCache({
      codexHome,
      bundledMarketplacePath: path.join(root, "missing-bundled-marketplace"),
      config: computerUseConfig({
        marketplacePath: path.join(
          root,
          "custom-marketplace",
          ".agents",
          "plugins",
          "marketplace.json",
        ),
      }),
    });

    expect(result).toMatchObject({
      status: "explicit_marketplace",
      changed: false,
      removedStaleVersions: [],
    });
    await expect(fs.access(path.join(cacheRoot, "1.0.101"))).resolves.toBe(undefined);
    await expect(fs.access(path.join(cacheRoot, "1.0.102"))).resolves.toBe(undefined);
  });

  it("preserves the active cache when replacement copying fails", async () => {
    const root = tempDirs.make("openclaw-computer-use-cache-");
    const codexHome = path.join(root, "agent", "codex-home");
    const bundledMarketplacePath = path.join(root, "bundled-marketplace");
    const cachePath = path.join(
      codexHome,
      "plugins",
      "cache",
      "openai-bundled",
      "computer-use",
      "2.0.0",
    );
    const manifestPath = path.join(cachePath, ".codex-plugin", "plugin.json");
    const olderCachePath = path.join(path.dirname(cachePath), "1.0.0");
    const olderManifestPath = path.join(olderCachePath, ".codex-plugin", "plugin.json");
    await writeBundledComputerUsePlugin(bundledMarketplacePath, "2.0.0");
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    await fs.writeFile(manifestPath, JSON.stringify({ name: "computer-use", version: "old" }));
    await fs.mkdir(path.dirname(olderManifestPath), { recursive: true });
    await fs.writeFile(
      olderManifestPath,
      JSON.stringify({ name: "computer-use", version: "1.0.0" }),
    );
    vi.spyOn(fs, "cp").mockRejectedValueOnce(new Error("copy failed"));

    await expect(
      ensureCodexComputerUseSharedPluginCache({
        codexHome,
        bundledMarketplacePath,
        config: computerUseConfig(),
      }),
    ).rejects.toThrow("copy failed");
    await expect(fs.readFile(manifestPath, "utf8")).resolves.toContain('"version":"old"');
    await expect(fs.readFile(olderManifestPath, "utf8")).resolves.toContain('"version":"1.0.0"');
  });
});

async function writeBundledComputerUsePlugin(
  bundledMarketplacePath: string,
  version: string,
): Promise<void> {
  const bundledPluginRoot = path.join(bundledMarketplacePath, "plugins", "computer-use");
  await fs.mkdir(path.join(bundledPluginRoot, ".codex-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(bundledPluginRoot, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "computer-use", version }),
  );
}

function computerUseConfig(
  overrides: Partial<ResolvedCodexComputerUseConfig> = {},
): ResolvedCodexComputerUseConfig {
  return {
    enabled: true,
    autoInstall: true,
    marketplaceDiscoveryTimeoutMs: 60_000,
    liveTestTimeoutMs: 60_000,
    toolCallTimeoutMs: 60_000,
    healthCheckEnabled: false,
    healthCheckIntervalMinutes: 60,
    pluginCacheMode: "shared",
    strictReadiness: false,
    autoRepair: false,
    pluginName: "computer-use",
    mcpServerName: "computer-use",
    ...overrides,
  };
}
