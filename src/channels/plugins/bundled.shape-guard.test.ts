import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../../test/helpers/import-fresh.ts";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";

const bundledChannelEntrypointPaths = ["index.ts", "channel-entry.ts", "setup-entry.ts"] as const;

type BundledEntrySource = { built?: string; source?: string };

function restoreBundledPluginsDir(previousBundledPluginsDir: string | undefined) {
  if (previousBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = previousBundledPluginsDir;
  }
}

function alphaChannelMetadata({ includeSetup = false }: { includeSetup?: boolean } = {}) {
  return {
    dirName: "alpha",
    manifest: {
      id: "alpha",
      channels: ["alpha"],
    },
    source: {
      source: "./index.js",
      built: "./index.js",
    },
    ...(includeSetup
      ? {
          setupSource: {
            source: "./setup-entry.js",
            built: "./setup-entry.js",
          },
        }
      : {}),
  };
}

function resolveAlphaDistExtensionEntry(
  rootDir: string,
  entry: BundledEntrySource,
  pluginDirName?: string,
) {
  return path.join(
    rootDir,
    "dist",
    "extensions",
    pluginDirName ?? "alpha",
    (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, ""),
  );
}

function mockAlphaDistExtensionRuntime() {
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [alphaChannelMetadata({ includeSetup: true })],
    resolveBundledChannelGeneratedPath: resolveAlphaDistExtensionEntry,
  }));
}

function collectBundledChannelEntrypointOffenders(
  bundledPluginRoots: string[],
  isOffender: (source: string, filePath: string) => boolean,
) {
  const offenders: string[] = [];
  for (const extensionDir of bundledPluginRoots) {
    for (const relativePath of bundledChannelEntrypointPaths) {
      const filePath = path.join(extensionDir, relativePath);
      if (!fs.existsSync(filePath)) {
        continue;
      }
      const source = fs.readFileSync(filePath, "utf8");
      const usesEntryHelpers =
        source.includes("defineBundledChannelEntry") ||
        source.includes("defineBundledChannelSetupEntry");
      if (usesEntryHelpers && isOffender(source, filePath)) {
        offenders.push(path.relative(process.cwd(), filePath));
      }
    }
  }
  return offenders;
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("../../plugins/bundled-plugin-metadata.js");
  vi.doUnmock("../../plugins/discovery.js");
  vi.doUnmock("../../plugins/manifest-registry.js");
  vi.doUnmock("../../plugins/channel-catalog-registry.js");
  vi.doUnmock("../../infra/boundary-file-read.js");
  vi.doUnmock("jiti");
});

describe("bundled channel entry shape guards", () => {
  const bundledPluginRoots = loadPluginManifestRegistry({ cache: true, config: {} })
    .plugins.filter((plugin) => plugin.origin === "bundled")
    .map((plugin) => plugin.rootDir);

  it("treats missing bundled discovery results as empty", async () => {
    vi.doMock("../../plugins/bundled-channel-runtime.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-channel-runtime.js")>();
      return {
        ...actual,
        listBundledChannelPluginMetadata: () => [],
      };
    });

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=missing-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toEqual([]);
    expect(bundled.listBundledChannelSetupPlugins()).toEqual([]);
  });

  it("loads real bundled channel entry contracts from the source tree", async () => {
    vi.doMock("../../plugins/bundled-channel-runtime.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-channel-runtime.js")>();
      return {
        ...actual,
        listBundledChannelPluginMetadata: (params: {
          includeChannelConfigs: boolean;
          includeSyntheticChannelConfigs: boolean;
        }) =>
          actual
            .listBundledChannelPluginMetadata(params)
            .filter((metadata) => metadata.manifest.id === "slack"),
      };
    });

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=real-bundled-source-tree",
    );

    expect(bundled.listBundledChannelPluginIds()).toEqual(["slack"]);
    expect(bundled.hasBundledChannelEntryFeature("slack", "accountInspect")).toBe(true);
  });

  it("fills sparse bundled channel plugin metadata from package metadata", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-metadata-"));
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const pluginDir = path.join(tempRoot, "dist", "extensions", "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      [
        "const plugin = {",
        "  id: 'alpha',",
        "  meta: { id: 'alpha' },",
        "  capabilities: { chatTypes: ['direct'] },",
        "  config: {},",
        "};",
        "export default {",
        "  kind: 'bundled-channel-entry',",
        "  id: 'alpha',",
        "  name: 'Alpha',",
        "  description: 'Alpha',",
        "  register() {},",
        "  loadChannelPlugin() { return plugin; },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: () => [
        {
          ...alphaChannelMetadata(),
          packageManifest: {
            channel: {
              id: "alpha",
              label: "Alpha",
              selectionLabel: "Use Alpha",
              docsPath: "/channels/alpha",
              blurb: "Alpha channel metadata.",
            },
          },
        },
      ],
      resolveBundledChannelGeneratedPath: (
        _rootDir: string,
        entry: { built?: string; source?: string },
      ) =>
        path.join(pluginDir, (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, "")),
    }));

    try {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(tempRoot, "dist", "extensions");

      const bundled = await importFreshModule<typeof import("./bundled.js")>(
        import.meta.url,
        "./bundled.js?scope=bundled-package-metadata",
      );

      const plugin = bundled.requireBundledChannelPlugin("alpha");
      expect(plugin.meta).toMatchObject({
        id: "alpha",
        label: "Alpha",
        selectionLabel: "Use Alpha",
        docsPath: "/channels/alpha",
        blurb: "Alpha channel metadata.",
      });
    } finally {
      restoreBundledPluginsDir(previousBundledPluginsDir);
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it("uses the active bundled plugin root override for channel entry loading", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-override-"));
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const pluginDir = path.join(tempRoot, "dist", "extensions", "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      [
        "globalThis.__bundledOverrideRuntime = undefined;",
        "const plugin = { id: 'alpha', meta: {}, capabilities: {}, config: {} };",
        "export default {",
        "  kind: 'bundled-channel-entry',",
        "  id: 'alpha',",
        "  name: 'Alpha',",
        "  description: 'Alpha',",
        "  register() {},",
        "  loadChannelPlugin() { return plugin; },",
        "  setChannelRuntime(runtime) { globalThis.__bundledOverrideRuntime = runtime.marker; },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    let metadataRootDir: string | undefined;
    let generatedRootDir: string | undefined;

    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: (params?: { rootDir?: string }) => {
        metadataRootDir = params?.rootDir;
        return [alphaChannelMetadata()];
      },
      resolveBundledChannelGeneratedPath: (
        rootDir: string,
        entry: { built?: string; source?: string },
        pluginDirName?: string,
      ) => {
        generatedRootDir = rootDir;
        return path.join(
          rootDir,
          "dist",
          "extensions",
          pluginDirName ?? "alpha",
          (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, ""),
        );
      },
    }));

    try {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(tempRoot, "dist", "extensions");

      const bundled = await importFreshModule<typeof import("./bundled.js")>(
        import.meta.url,
        "./bundled.js?scope=bundled-override-root",
      );

      bundled.setBundledChannelRuntime("alpha", { marker: "ok" } as never);
      const testGlobal = globalThis as typeof globalThis & {
        __bundledOverrideRuntime?: unknown;
      };

      expect(metadataRootDir).toBe(tempRoot);
      expect(generatedRootDir).toBe(tempRoot);
      expect(testGlobal.__bundledOverrideRuntime).toBe("ok");
      expect(bundled.requireBundledChannelPlugin("alpha").id).toBe("alpha");
    } finally {
      restoreBundledPluginsDir(previousBundledPluginsDir);
      fs.rmSync(tempRoot, { recursive: true, force: true });
      delete (globalThis as { __bundledOverrideRuntime?: unknown }).__bundledOverrideRuntime;
    }
  });

  it("treats direct bundled plugin-tree overrides as scan roots", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-direct-override-"));
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const pluginsRoot = path.join(tempRoot, "bundled-plugins");
    const pluginDir = path.join(pluginsRoot, "alpha");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      [
        "globalThis.__bundledOverrideRuntime = undefined;",
        "const plugin = { id: 'alpha', meta: {}, capabilities: {}, config: {} };",
        "export default {",
        "  kind: 'bundled-channel-entry',",
        "  id: 'alpha',",
        "  name: 'Alpha',",
        "  description: 'Alpha',",
        "  register() {},",
        "  loadChannelPlugin() { return plugin; },",
        "  setChannelRuntime(runtime) { globalThis.__bundledOverrideRuntime = runtime.marker; },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    let metadataScanDir: string | undefined;
    let generatedRootDir: string | undefined;
    let generatedScanDir: string | undefined;

    vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
      listBundledChannelPluginMetadata: (params?: { rootDir?: string; scanDir?: string }) => {
        metadataScanDir = params?.scanDir;
        return [alphaChannelMetadata()];
      },
      resolveBundledChannelGeneratedPath: (
        rootDir: string,
        entry: { built?: string; source?: string },
        pluginDirName?: string,
        scanDir?: string,
      ) => {
        generatedRootDir = rootDir;
        generatedScanDir = scanDir;
        return path.join(
          scanDir ?? path.join(rootDir, "dist", "extensions"),
          pluginDirName ?? "alpha",
          (entry.built ?? entry.source ?? "./index.js").replace(/^\.\//u, ""),
        );
      },
    }));

    try {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = pluginsRoot;

      const bundled = await importFreshModule<typeof import("./bundled.js")>(
        import.meta.url,
        "./bundled.js?scope=bundled-direct-override-root",
      );

      bundled.setBundledChannelRuntime("alpha", { marker: "ok" } as never);
      const testGlobal = globalThis as typeof globalThis & {
        __bundledOverrideRuntime?: unknown;
      };

      expect(metadataScanDir).toBe(pluginsRoot);
      expect(generatedRootDir).toBe(pluginsRoot);
      expect(generatedScanDir).toBe(pluginsRoot);
      expect(testGlobal.__bundledOverrideRuntime).toBe("ok");
      expect(bundled.requireBundledChannelPlugin("alpha").id).toBe("alpha");
    } finally {
      restoreBundledPluginsDir(previousBundledPluginsDir);
      fs.rmSync(tempRoot, { recursive: true, force: true });
      delete (globalThis as { __bundledOverrideRuntime?: unknown }).__bundledOverrideRuntime;
    }
  });

  it("partitions bundled channel lazy caches by active bundled root without re-importing", async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-root-a-"));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-root-b-"));
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const testGlobal = globalThis as typeof globalThis & {
      __bundledRootRuntime?: unknown;
    };

    const writeBundledRoot = (rootDir: string, label: string) => {
      const pluginDir = path.join(rootDir, "dist", "extensions", "alpha");
      fs.mkdirSync(pluginDir, { recursive: true });
      fs.writeFileSync(
        path.join(pluginDir, "index.js"),
        [
          `globalThis.__bundledRootRuntime = globalThis.__bundledRootRuntime ?? [];`,
          "export default {",
          "  kind: 'bundled-channel-entry',",
          "  id: 'alpha',",
          `  name: ${JSON.stringify(`Alpha ${label}`)},`,
          `  description: ${JSON.stringify(`Alpha ${label}`)},`,
          "  register() {},",
          "  loadChannelPlugin() {",
          "    return {",
          "      id: 'alpha',",
          `      meta: { id: 'alpha', label: ${JSON.stringify(`Alpha ${label}`)} },`,
          "      capabilities: {},",
          "      config: {},",
          `      secrets: { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.token`)}, targetType: 'channel' }] },`,
          "    };",
          "  },",
          "  loadChannelSecrets() {",
          `    return { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.entry-token`)}, targetType: 'channel' }] };`,
          "  },",
          "  setChannelRuntime(runtime) {",
          `    globalThis.__bundledRootRuntime.push(${JSON.stringify(`entry:${label}`)} + ':' + String(runtime.marker));`,
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
      fs.writeFileSync(
        path.join(pluginDir, "setup-entry.js"),
        [
          "export default {",
          "  kind: 'bundled-channel-setup-entry',",
          "  loadSetupPlugin() {",
          "    return {",
          "      id: 'alpha',",
          `      meta: { id: 'alpha', label: ${JSON.stringify(`Setup ${label}`)} },`,
          "      capabilities: {},",
          "      config: {},",
          `      secrets: { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.setup-plugin-token`)}, targetType: 'channel' }] },`,
          "    };",
          "  },",
          "  loadSetupSecrets() {",
          `    return { secretTargetRegistryEntries: [{ id: ${JSON.stringify(`channels.alpha.${label}.setup-entry-token`)}, targetType: 'channel' }] };`,
          "  },",
          "};",
          "",
        ].join("\n"),
        "utf8",
      );
    };

    writeBundledRoot(rootA, "A");
    writeBundledRoot(rootB, "B");

    mockAlphaDistExtensionRuntime();

    try {
      const bundled = await importFreshModule<typeof import("./bundled.js")>(
        import.meta.url,
        "./bundled.js?scope=bundled-root-partition",
      );

      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(rootA, "dist", "extensions");
      expect(bundled.requireBundledChannelPlugin("alpha").meta.label).toBe("Alpha A");
      expect(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("Setup A");
      expect(bundled.getBundledChannelSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id).toBe(
        "channels.alpha.A.entry-token",
      );
      expect(
        bundled.getBundledChannelSetupSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id,
      ).toBe("channels.alpha.A.setup-entry-token");
      bundled.setBundledChannelRuntime("alpha", { marker: "first" } as never);

      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(rootB, "dist", "extensions");
      expect(bundled.requireBundledChannelPlugin("alpha").meta.label).toBe("Alpha B");
      expect(bundled.getBundledChannelSetupPlugin("alpha")?.meta.label).toBe("Setup B");
      expect(bundled.getBundledChannelSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id).toBe(
        "channels.alpha.B.entry-token",
      );
      expect(
        bundled.getBundledChannelSetupSecrets("alpha")?.secretTargetRegistryEntries?.[0]?.id,
      ).toBe("channels.alpha.B.setup-entry-token");
      bundled.setBundledChannelRuntime("alpha", { marker: "second" } as never);

      expect(testGlobal.__bundledRootRuntime).toEqual(["entry:A:first", "entry:B:second"]);
    } finally {
      restoreBundledPluginsDir(previousBundledPluginsDir);
      fs.rmSync(rootA, { recursive: true, force: true });
      fs.rmSync(rootB, { recursive: true, force: true });
      delete testGlobal.__bundledRootRuntime;
    }
  });

  it("loads setup-entry feature plugins without loading the main channel entry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-setup-only-"));
    const previousBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    const pluginDir = path.join(root, "dist", "extensions", "alpha");
    const testGlobal = globalThis as typeof globalThis & {
      __bundledSetupOnlyMainLoaded?: boolean;
      __bundledSetupOnlySetupLoaded?: number;
      __bundledSetupOnlyPluginLoaded?: boolean;
    };
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "index.js"),
      [
        "globalThis.__bundledSetupOnlyMainLoaded = true;",
        "throw new Error('main entry loaded');",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "setup-entry.js"),
      [
        "globalThis.__bundledSetupOnlySetupLoaded = (globalThis.__bundledSetupOnlySetupLoaded ?? 0) + 1;",
        "export default {",
        "  kind: 'bundled-channel-setup-entry',",
        "  features: { legacyStateMigrations: true },",
        "  loadSetupPlugin() {",
        "    globalThis.__bundledSetupOnlyPluginLoaded = true;",
        "    throw new Error('setup plugin loaded');",
        "  },",
        "  loadLegacyStateMigrationDetector() {",
        "    return ({ oauthDir }) => [{",
        "      kind: 'copy',",
        "      label: 'Alpha state',",
        "      sourcePath: oauthDir + '/legacy.json',",
        "      targetPath: oauthDir + '/alpha/legacy.json',",
        "    }];",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    mockAlphaDistExtensionRuntime();

    try {
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = path.join(root, "dist", "extensions");

      const bundled = await importFreshModule<typeof import("./bundled.js")>(
        import.meta.url,
        "./bundled.js?scope=bundled-setup-only-feature",
      );

      const detectors = bundled.listBundledChannelLegacyStateMigrationDetectors();
      expect(
        detectors.map((detector) =>
          detector({ cfg: {}, env: {}, stateDir: "/state", oauthDir: "/oauth" } as never),
        ),
      ).toEqual([
        [
          {
            kind: "copy",
            label: "Alpha state",
            sourcePath: "/oauth/legacy.json",
            targetPath: "/oauth/alpha/legacy.json",
          },
        ],
      ]);
      expect(testGlobal.__bundledSetupOnlySetupLoaded).toBe(1);
      expect(testGlobal.__bundledSetupOnlyMainLoaded).toBeUndefined();
      expect(testGlobal.__bundledSetupOnlyPluginLoaded).toBeUndefined();
    } finally {
      restoreBundledPluginsDir(previousBundledPluginsDir);
      fs.rmSync(root, { recursive: true, force: true });
      delete testGlobal.__bundledSetupOnlyMainLoaded;
      delete testGlobal.__bundledSetupOnlySetupLoaded;
      delete testGlobal.__bundledSetupOnlyPluginLoaded;
    }
  });

  it("keeps channel entrypoints on the dedicated entry-contract SDK surface", () => {
    const offenders = collectBundledChannelEntrypointOffenders(
      bundledPluginRoots,
      (source) =>
        !source.includes('from "openclaw/plugin-sdk/channel-entry-contract"') ||
        source.includes('from "openclaw/plugin-sdk/core"') ||
        source.includes('from "openclaw/plugin-sdk/channel-core"'),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps setup-entry legacy feature hints mirrored in package metadata", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      const setupEntryPath = path.join(extensionDir, "setup-entry.ts");
      const packageJsonPath = path.join(extensionDir, "package.json");
      if (!fs.existsSync(setupEntryPath) || !fs.existsSync(packageJsonPath)) {
        continue;
      }
      const setupEntrySource = fs.readFileSync(setupEntryPath, "utf8");
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
        openclaw?: {
          setupFeatures?: Record<string, boolean>;
        };
      };
      for (const feature of ["legacyStateMigrations", "legacySessionSurfaces"]) {
        const usesFeature = setupEntrySource.includes(`${feature}: true`);
        const hasHint = packageJson.openclaw?.setupFeatures?.[feature] === true;
        if (usesFeature !== hasHint) {
          offenders.push(`${path.relative(process.cwd(), extensionDir)}:${feature}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps bundled channel entrypoints free of static src imports", () => {
    const offenders = collectBundledChannelEntrypointOffenders(bundledPluginRoots, (source) =>
      /^(?:import|export)\s.+["']\.\/src\//mu.test(source),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps channel implementations off the broad core SDK surface", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      for (const relativePath of ["src/channel.ts", "src/plugin.ts"]) {
        const filePath = path.join(extensionDir, relativePath);
        if (!fs.existsSync(filePath)) {
          continue;
        }
        const source = fs.readFileSync(filePath, "utf8");
        if (!source.includes("createChatChannelPlugin")) {
          continue;
        }
        if (source.includes('from "openclaw/plugin-sdk/core"')) {
          offenders.push(path.relative(process.cwd(), filePath));
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps plugin-sdk channel-core free of chat metadata bootstrap imports", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/channel-core.ts"), "utf8");

    expect(source.includes("../channels/chat-meta.js")).toBe(false);
    expect(source.includes("getChatChannelMeta")).toBe(false);
  });

  it("keeps bundled hot runtime barrels off the broad core SDK surface", () => {
    const offenders = [
      "extensions/googlechat/runtime-api.ts",
      "extensions/irc/src/runtime-api.ts",
      "extensions/matrix/src/runtime-api.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("openclaw/plugin-sdk/core"),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps runtime helper surfaces off bootstrap-registry", () => {
    const offenders = [
      "src/config/markdown-tables.ts",
      "src/config/sessions/group.ts",
      "src/channels/plugins/setup-helpers.ts",
      "src/plugin-sdk/extension-shared.ts",
    ].filter((filePath) =>
      fs.readFileSync(path.resolve(filePath), "utf8").includes("bootstrap-registry.js"),
    );

    expect(offenders).toEqual([]);
  });

  it("keeps extension-shared off the broad runtime barrel", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/extension-shared.ts"), "utf8");

    expect(source.includes('from "./runtime.js"')).toBe(false);
  });

  it("keeps nextcloud-talk's private SDK surface off the broad runtime barrel", () => {
    const source = fs.readFileSync(path.resolve("src/plugin-sdk/nextcloud-talk.ts"), "utf8");

    expect(source.includes('from "./runtime.js"')).toBe(false);
  });

  it("keeps bundled doctor surfaces off the broad runtime barrel", () => {
    const offenders = [
      "extensions/discord/src/doctor.ts",
      "extensions/matrix/src/doctor.ts",
      "extensions/slack/src/doctor.ts",
      "extensions/telegram/src/doctor.ts",
      "extensions/zalouser/src/doctor.ts",
    ].filter((filePath) =>
      fs
        .readFileSync(path.resolve(filePath), "utf8")
        .includes('from "openclaw/plugin-sdk/runtime"'),
    );

    expect(offenders).toEqual([]);
  });

  it("breaks reentrant bundled channel discovery cycles with an empty fallback", async () => {
    const pluginDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-reentrant-"));
    const modulePath = path.join(pluginDir, "index.js");
    fs.writeFileSync(modulePath, "export {};\n", "utf8");

    vi.doMock("../../plugins/bundled-plugin-metadata.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../../plugins/bundled-plugin-metadata.js")>();
      return {
        ...actual,
        listBundledPluginMetadata: () => [
          {
            dirName: "alpha",
            idHint: "alpha",
            source: {
              source: "./index.js",
              built: "./index.js",
            },
            manifest: {
              id: "alpha",
              channels: ["alpha"],
            },
          },
        ],
        resolveBundledPluginGeneratedPath: () => modulePath,
      };
    });
    vi.doMock("../../infra/boundary-file-read.js", () => ({
      openBoundaryFileSync: ({ absolutePath }: { absolutePath: string }) => ({
        ok: true,
        path: absolutePath,
        fd: fs.openSync(absolutePath, "r"),
      }),
    }));
    vi.doMock("../../plugins/channel-catalog-registry.js", () => ({
      listChannelCatalogEntries: () => [],
    }));

    let reentered = false;
    vi.doMock("jiti", () => ({
      createJiti: () => {
        return () => {
          if (!reentered) {
            reentered = true;
            expect(bundled.listBundledChannelPlugins()).toEqual([]);
          }
          return {
            default: {
              kind: "bundled-channel-entry",
              id: "alpha",
              name: "Alpha",
              description: "Alpha",
              configSchema: {},
              register() {},
              loadChannelPlugin() {
                return {
                  id: "alpha",
                  meta: {},
                  capabilities: {},
                  config: {},
                };
              },
            },
          };
        };
      },
    }));

    const bundled = await importFreshModule<typeof import("./bundled.js")>(
      import.meta.url,
      "./bundled.js?scope=reentrant-bundled-discovery",
    );

    expect(bundled.listBundledChannelPlugins()).toHaveLength(1);
    expect(reentered).toBe(true);
  });

  it("keeps private src runtime barrels from forwarding to parent runtime barrels that export local plugins", () => {
    const offenders: string[] = [];

    for (const extensionDir of bundledPluginRoots) {
      const privateRuntimePath = path.join(extensionDir, "src", "runtime-api.ts");
      const publicRuntimePath = path.join(extensionDir, "runtime-api.ts");
      if (!fs.existsSync(privateRuntimePath) || !fs.existsSync(publicRuntimePath)) {
        continue;
      }
      const privateRuntimeSource = fs.readFileSync(privateRuntimePath, "utf8");
      const publicRuntimeSource = fs.readFileSync(publicRuntimePath, "utf8");
      const forwardsParentRuntime =
        privateRuntimeSource.includes('export * from "../runtime-api.js"') ||
        privateRuntimeSource.includes("export * from '../runtime-api.js'");
      const exportsLocalPlugin =
        publicRuntimeSource.includes('from "./src/channel.js"') &&
        /export\s+\{\s*[\w$]+Plugin\s*\}\s+from\s+["']\.\/src\/channel\.js["']/u.test(
          publicRuntimeSource,
        );
      if (forwardsParentRuntime && exportsLocalPlugin) {
        offenders.push(path.relative(process.cwd(), publicRuntimePath));
      }
    }

    expect(offenders).toEqual([]);
  });
});
