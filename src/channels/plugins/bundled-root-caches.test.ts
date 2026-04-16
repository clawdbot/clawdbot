import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";

const tempDirs: string[] = [];
const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function makeBundledRoot(prefix: string): { root: string; pluginsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(root);
  const pluginsDir = path.join(root, "dist", "extensions");
  fs.mkdirSync(pluginsDir, { recursive: true });
  return { root, pluginsDir };
}

function resolveMockRootSuffix(params: {
  activeRoot: string | undefined;
  rootAPluginsDir: string;
  rootBPluginsDir: string;
}): "A" | "B" | "unknown" {
  if (params.activeRoot === params.rootAPluginsDir) {
    return "A";
  }
  if (params.activeRoot === params.rootBPluginsDir) {
    return "B";
  }
  return "unknown";
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  vi.resetModules();
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
  vi.doUnmock("./bundled.js");
  vi.doUnmock("./bundled-ids.js");
});

describe("bundled root-aware caches", () => {
  it("partitions bundled channel ids by active bundled root without re-importing", async () => {
    const rootA = makeBundledRoot("openclaw-bundled-ids-a-");
    const rootB = makeBundledRoot("openclaw-bundled-ids-b-");

    vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
      listChannelCatalogEntries: (params?: { env?: NodeJS.ProcessEnv }) => {
        const activeRoot = params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR;
        if (activeRoot === rootA.pluginsDir) {
          return [{ pluginId: "alpha" }];
        }
        if (activeRoot === rootB.pluginsDir) {
          return [{ pluginId: "beta" }];
        }
        return [];
      },
    }));

    const bundledIds = await importFreshModule<typeof import("./bundled-ids.js")>(
      import.meta.url,
      "./bundled-ids.js?scope=root-aware-id-cache",
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = rootA.pluginsDir;
    expect(bundledIds.listBundledChannelPluginIds()).toEqual(["alpha"]);

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = rootB.pluginsDir;
    expect(bundledIds.listBundledChannelPluginIds()).toEqual(["beta"]);
  });

  it("partitions bootstrap plugin caches by active bundled root without re-importing", async () => {
    const rootA = makeBundledRoot("openclaw-bootstrap-a-");
    const rootB = makeBundledRoot("openclaw-bootstrap-b-");

    vi.doMock("./bundled-ids.js", () => ({
      listBundledChannelPluginIdsForRoot: (cacheKey: string) => {
        if (cacheKey === rootA.pluginsDir) {
          return ["alpha"];
        }
        if (cacheKey === rootB.pluginsDir) {
          return ["beta"];
        }
        return [];
      },
    }));

    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: (id: string) => ({
        id,
        meta: { id, label: `runtime-${id}` },
        capabilities: {},
        config: {},
      }),
      getBundledChannelSetupPlugin: (id: string) => {
        const suffix = resolveMockRootSuffix({
          activeRoot: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
          rootAPluginsDir: rootA.pluginsDir,
          rootBPluginsDir: rootB.pluginsDir,
        });
        return {
          id,
          meta: { id, label: `setup-${suffix}` },
          capabilities: {},
          config: {},
        };
      },
      getBundledChannelSecrets: (id: string) => ({
        secretTargetRegistryEntries: [{ id: `runtime-${id}`, targetType: "channel" }],
      }),
      getBundledChannelSetupSecrets: (id: string) => {
        const suffix = resolveMockRootSuffix({
          activeRoot: process.env.OPENCLAW_BUNDLED_PLUGINS_DIR,
          rootAPluginsDir: rootA.pluginsDir,
          rootBPluginsDir: rootB.pluginsDir,
        });
        return {
          secretTargetRegistryEntries: [{ id: `setup-${id}-${suffix}`, targetType: "channel" }],
        };
      },
    }));

    const bootstrapRegistry = await importFreshModule<typeof import("./bootstrap-registry.js")>(
      import.meta.url,
      "./bootstrap-registry.js?scope=root-aware-bootstrap-cache",
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = rootA.pluginsDir;
    expect(bootstrapRegistry.listBootstrapChannelPluginIds()).toEqual(["alpha"]);
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")?.meta.label).toBe("setup-A");
    expect(
      bootstrapRegistry.getBootstrapChannelSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id,
    ).toBe("setup-alpha-A");

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = rootB.pluginsDir;
    expect(bootstrapRegistry.listBootstrapChannelPluginIds()).toEqual(["beta"]);
    expect(bootstrapRegistry.getBootstrapChannelPlugin("beta")?.meta.label).toBe("setup-B");
    expect(
      bootstrapRegistry.getBootstrapChannelSecrets("beta")?.secretTargetRegistryEntries?.[0]?.id,
    ).toBe("setup-beta-B");
  });
});
