import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/bundled-dir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/bundled-dir.js")>();
  return {
    ...actual,
    resolveBundledPluginsDir: (env: NodeJS.ProcessEnv = process.env) =>
      env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? actual.resolveBundledPluginsDir(env),
  };
});

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

describe("bundled root-aware plugin lookups", () => {
  it("reads bundled channel ids from the active bundled root without re-importing", async () => {
    const rootA = makeBundledRoot("openclaw-bundled-ids-a-");
    const rootB = makeBundledRoot("openclaw-bundled-ids-b-");

    vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
      listChannelCatalogEntries: (params?: { env?: NodeJS.ProcessEnv }) => {
        const activeRoot = params?.env?.OPENCLAW_BUNDLED_PLUGINS_DIR;
        if (activeRoot === rootA.pluginsDir) {
          return [{ pluginId: "alpha", channel: { id: "alpha-chat" } }];
        }
        if (activeRoot === rootB.pluginsDir) {
          return [{ pluginId: "beta", channel: { id: "beta-chat" } }];
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
    expect(bundledIds.listBundledChannelIds()).toEqual(["alpha-chat"]);

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = rootB.pluginsDir;
    expect(bundledIds.listBundledChannelPluginIds()).toEqual(["beta"]);
    expect(bundledIds.listBundledChannelIds()).toEqual(["beta-chat"]);
  });

  it("reads bootstrap plugins from the active bundled root without re-importing", async () => {
    const rootA = makeBundledRoot("openclaw-bootstrap-a-");
    const rootB = makeBundledRoot("openclaw-bootstrap-b-");

    vi.doMock("./bundled-ids.js", () => ({
      listBundledChannelPluginIdsForRoot: () => {
        if (process.env.OPENCLAW_BUNDLED_PLUGINS_DIR === rootA.pluginsDir) {
          return ["alpha"];
        }
        if (process.env.OPENCLAW_BUNDLED_PLUGINS_DIR === rootB.pluginsDir) {
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

  it("retries bootstrap plugin loading after an error", async () => {
    const root = makeBundledRoot("openclaw-bootstrap-plugin-throw-");

    vi.doMock("./bundled-ids.js", () => ({
      listBundledChannelPluginIdsForRoot: () =>
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR === root.pluginsDir ? ["alpha"] : [],
    }));

    const getBundledChannelPluginMock = vi.fn(() => {
      throw new Error("Cannot find module 'nostr-tools'");
    });
    const getBundledChannelSecretsMock = vi.fn(() => {
      throw new Error("secrets should not load after plugin is marked missing");
    });

    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: getBundledChannelPluginMock,
      getBundledChannelSetupPlugin: vi.fn(() => undefined),
      getBundledChannelSecrets: getBundledChannelSecretsMock,
      getBundledChannelSetupSecrets: vi.fn(() => undefined),
    }));

    const bootstrapRegistry = await importFreshModule<typeof import("./bootstrap-registry.js")>(
      import.meta.url,
      "./bootstrap-registry.js?scope=bootstrap-plugin-load-guard",
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = root.pluginsDir;
    expect(bootstrapRegistry.listBootstrapChannelPluginIds()).toEqual(["alpha"]);
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    expect(getBundledChannelPluginMock).toHaveBeenCalledTimes(2);
    expect(getBundledChannelSecretsMock).toHaveBeenCalledTimes(1);
  });

  it("keeps plugin loading independent from bootstrap secrets loading errors", async () => {
    const root = makeBundledRoot("openclaw-bootstrap-secrets-throw-");

    vi.doMock("./bundled-ids.js", () => ({
      listBundledChannelPluginIdsForRoot: () =>
        process.env.OPENCLAW_BUNDLED_PLUGINS_DIR === root.pluginsDir ? ["alpha"] : [],
    }));

    const getBundledChannelSecretsMock = vi.fn(() => {
      throw new Error("Cannot find module '@larksuiteoapi/node-sdk'");
    });
    const getBundledChannelPluginMock = vi.fn(() => ({
      id: "alpha",
      meta: { id: "alpha", label: "Alpha" },
      capabilities: {},
      config: {},
    }));

    vi.doMock("./bundled.js", () => ({
      getBundledChannelPlugin: getBundledChannelPluginMock,
      getBundledChannelSetupPlugin: vi.fn(() => undefined),
      getBundledChannelSecrets: getBundledChannelSecretsMock,
      getBundledChannelSetupSecrets: vi.fn(() => undefined),
    }));

    const bootstrapRegistry = await importFreshModule<typeof import("./bootstrap-registry.js")>(
      import.meta.url,
      "./bootstrap-registry.js?scope=bootstrap-secrets-load-guard",
    );

    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = root.pluginsDir;
    expect(bootstrapRegistry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelSecrets("alpha")).toBeUndefined();
    expect(bootstrapRegistry.getBootstrapChannelPlugin("alpha")).toMatchObject({
      id: "alpha",
      meta: { id: "alpha", label: "Alpha" },
    });
    expect(getBundledChannelSecretsMock).toHaveBeenCalledTimes(2);
    expect(getBundledChannelPluginMock).toHaveBeenCalledTimes(1);
  });
});
