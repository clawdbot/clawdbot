// Verifies bundled plugin metadata generation and import boundaries.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { toErrorObject as toLintErrorObject } from "@openclaw/normalization-core/error-coercion";
import { assert, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expectNoReaddirSyncDuring } from "../test-utils/fs-scan-assertions.js";
import { listGitTrackedFiles, toRepoRelativePath } from "../test-utils/repo-files.js";
import { collectBundledChannelConfigsCore } from "./bundled-channel-config-metadata.js";
import {
  listBundledPluginMetadata,
  resolveBundledPluginGeneratedPath,
} from "./bundled-plugin-metadata.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";

type BundledPluginMetadata = ReturnType<typeof listBundledPluginMetadata>[number];
import { resolveGatewayStartupPluginIdsFromRegistry } from "./gateway-startup-plugin-ids.js";
import {
  createGeneratedPluginTempRoot,
  installGeneratedPluginTempRootCleanup,
  pluginTestRepoRoot as repoRoot,
  writeJson,
} from "./generated-plugin-test-helpers.js";
import type { InstalledPluginIndex, InstalledPluginIndexRecord } from "./installed-plugin-index.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import {
  getPackageManifestMetadata,
  loadPluginManifest,
  type PackageManifest,
} from "./manifest.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { writeBundledRuntimeSidecarPathBaseline } from "./runtime-sidecar-paths-baseline.js";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "./runtime-sidecar-paths.js";

const BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS = 300_000;
const EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_EXTRAS = ["memory-core", "xai"] as const;

installGeneratedPluginTempRootCleanup();

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
});

function expectTestOnlyArtifactsExcluded(artifacts: readonly string[]) {
  artifacts.forEach((artifact) => {
    expect(artifact).not.toMatch(/^test-/);
    expect(artifact).not.toContain(".test-");
    expect(artifact).not.toMatch(/\.test\.js$/);
  });
}

function expectGeneratedPathResolution(tempRoot: string, expectedRelativePath: string) {
  expect(
    resolveBundledPluginGeneratedPath(
      tempRoot,
      {
        source: "./plugin/index.ts",
        built: "plugin/index.js",
      },
      undefined,
    ),
  ).toBe(path.join(tempRoot, expectedRelativePath));
}

function expectPluginScopedGeneratedPathResolution(
  tempRoot: string,
  pluginDirName: string,
  expectedRelativePath: string,
) {
  expect(
    resolveBundledPluginGeneratedPath(
      tempRoot,
      {
        source: "./index.ts",
        built: "index.js",
      },
      pluginDirName,
    ),
  ).toBe(path.join(tempRoot, expectedRelativePath));
}

function expectArtifactPresence(
  artifacts: readonly string[] | undefined,
  params: { contains?: readonly string[]; excludes?: readonly string[] },
) {
  if (params.contains) {
    for (const artifact of params.contains) {
      expect(artifacts).toContain(artifact);
    }
  }
  if (params.excludes) {
    for (const artifact of params.excludes) {
      expect(artifacts).not.toContain(artifact);
    }
  }
}

let repoBundledPluginMetadataCache: readonly BundledPluginMetadata[] | undefined;
let repoBundledPluginManifestsCache:
  | ReturnType<typeof listRepoBundledPluginManifestsUncached>
  | undefined;
const repoBundledChannelConfigsCache = new Map<
  string,
  ReturnType<typeof collectBundledChannelConfigsCore>
>();

function listRepoBundledPluginMetadata(): readonly BundledPluginMetadata[] {
  repoBundledPluginMetadataCache ??= listBundledPluginMetadata({
    rootDir: repoRoot,
    includeSyntheticChannelConfigs: false,
  });
  return repoBundledPluginMetadataCache;
}

function listRepoBundledPluginManifestsUncached() {
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return listRepoBundledPluginManifestDirs().flatMap((dirName) => {
    const result = loadPluginManifest(path.join(bundledPluginsDir, dirName), false);
    return result.ok ? [{ dirName, manifest: result.manifest }] : [];
  });
}

function listRepoBundledPluginManifestDirs(): string[] {
  const externalDirs = listExternalRepoBundledPluginManifestDirs();
  if (externalDirs) {
    return externalDirs;
  }
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function listExternalRepoBundledPluginManifestDirs(): string[] | null {
  const manifestFiles =
    listGitRepoBundledPluginManifestFiles() ?? listFindRepoBundledPluginManifestFiles();
  if (!manifestFiles) {
    return null;
  }
  return manifestFiles
    .flatMap((file) => {
      const match = /^extensions\/([^/]+)\/openclaw\.plugin\.json$/u.exec(file);
      return match?.[1] ? [match[1]] : [];
    })
    .toSorted();
}

function listGitRepoBundledPluginManifestFiles(): string[] | null {
  return listGitTrackedFiles({ repoRoot, pathspecs: "extensions/*/openclaw.plugin.json" });
}

function listFindRepoBundledPluginManifestFiles(): string[] | null {
  const result = spawnSync(
    "find",
    [
      path.join(repoRoot, "extensions"),
      "-maxdepth",
      "2",
      "-type",
      "f",
      "-name",
      "openclaw.plugin.json",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => toRepoRelativePath(repoRoot, file))
    .toSorted();
}

function listRepoBundledPluginManifests() {
  repoBundledPluginManifestsCache ??= listRepoBundledPluginManifestsUncached();
  return repoBundledPluginManifestsCache;
}

function createRepoBundledManifestRegistry(): PluginManifestRegistry {
  return {
    plugins: listRepoBundledPluginManifests().map(({ manifest, dirName }) => ({
      id: manifest.id,
      name: manifest.name,
      description: manifest.description,
      version: manifest.version,
      enabledByDefault: manifest.enabledByDefault === true ? true : undefined,
      enabledByDefaultOnPlatforms: manifest.enabledByDefaultOnPlatforms,
      kind: manifest.kind,
      channels: manifest.channels ?? [],
      providers: manifest.providers ?? [],
      cliBackends: manifest.cliBackends ?? [],
      syntheticAuthRefs: manifest.syntheticAuthRefs ?? [],
      nonSecretAuthMarkers: manifest.nonSecretAuthMarkers ?? [],
      skills: manifest.skills ?? [],
      origin: "bundled",
      rootDir: path.join(repoRoot, "extensions", dirName),
      source: path.join(repoRoot, "extensions", dirName, "index.ts"),
      manifestPath: path.join(repoRoot, "extensions", dirName, "openclaw.plugin.json"),
      activation: manifest.activation,
      setup: manifest.setup,
      hooks: [],
      contracts: manifest.contracts,
    })),
    diagnostics: [],
  };
}

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  return fs.existsSync(packagePath)
    ? (JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest)
    : undefined;
}

function collectRootPackageExcludedExtensionDirsForTest(): readonly string[] {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    files?: unknown;
  };
  if (!Array.isArray(packageJson.files)) {
    return [];
  }
  return packageJson.files
    .flatMap((entry) => {
      if (typeof entry !== "string") {
        return [];
      }
      const match = /^!dist\/extensions\/([^/]+)\/\*\*$/u.exec(entry);
      return match?.[1] ? [match[1]] : [];
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function collectRepoBundledChannelConfigsForTest(dirName: string) {
  const cached = repoBundledChannelConfigsCache.get(dirName);
  if (cached) {
    return cached;
  }
  const pluginDir = path.join(repoRoot, "extensions", dirName);
  const manifest = loadPluginManifest(pluginDir, false);
  if (!manifest.ok) {
    throw toLintErrorObject(manifest.error, "Non-Error thrown");
  }
  const configs = collectBundledChannelConfigsCore({
    pluginDir,
    manifest: manifest.manifest,
    packageManifest: getPackageManifestMetadata(readPackageManifest(pluginDir)),
  });
  repoBundledChannelConfigsCache.set(dirName, configs);
  return configs;
}

function hasPluginKind(record: PluginManifestRecord, kind: string): boolean {
  return Array.isArray(record.kind) ? record.kind.includes(kind as never) : record.kind === kind;
}

function createInstalledPluginRecordForManifest(
  record: PluginManifestRecord,
): InstalledPluginIndexRecord {
  return {
    pluginId: record.id,
    manifestPath: record.manifestPath,
    manifestHash: `test-${record.id}`,
    source: record.source,
    rootDir: record.rootDir,
    origin: record.origin,
    enabled: record.enabledByDefault === true,
    ...(record.enabledByDefault === true ? { enabledByDefault: true } : {}),
    ...(record.enabledByDefaultOnPlatforms?.length
      ? { enabledByDefaultOnPlatforms: record.enabledByDefaultOnPlatforms }
      : {}),
    startup: {
      sidecar: record.activation?.onStartup === true,
      memory: hasPluginKind(record, "memory"),
      agentHarnesses: [
        ...new Set([...(record.activation?.onAgentHarnesses ?? []), ...record.cliBackends]),
      ].toSorted((left, right) => left.localeCompare(right)),
    },
    compat: [],
  };
}

function createInstalledPluginIndexForManifests(
  manifestRegistry: PluginManifestRegistry,
): InstalledPluginIndex {
  return {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: "test",
    generatedAtMs: 0,
    installRecords: {},
    plugins: manifestRegistry.plugins.map(createInstalledPluginRecordForManifest),
    diagnostics: [],
  };
}

describe("bundled plugin metadata", () => {
  beforeAll(() => {
    listRepoBundledPluginMetadata();
    collectRepoBundledChannelConfigsForTest("discord");
    collectRepoBundledChannelConfigsForTest("tlon");
  });

  it("lists bundled plugin manifests without scanning extension directories in-process", () => {
    expectNoReaddirSyncDuring(() => {
      const manifests = listRepoBundledPluginManifestsUncached();

      expect(manifests.length).toBeGreaterThan(0);
      expect(manifests.every((entry) => entry.dirName.length > 0)).toBe(true);
    });
  });

  it(
    "matches the runtime metadata snapshot",
    { timeout: BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS },
    () => {
      expect(listRepoBundledPluginMetadata()).toEqual(
        listBundledPluginMetadata({
          includeSyntheticChannelConfigs: false,
        }),
      );
    },
  );

  it(
    "matches the checked-in runtime sidecar path baseline",
    { timeout: BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS },
    async () => {
      await expect(
        writeBundledRuntimeSidecarPathBaseline({ repoRoot, check: true }),
      ).resolves.toMatchObject({ changed: false });
    },
  );

  it("excludes non-packaged QA sidecars from the packaged runtime sidecar baseline", () => {
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
      "dist/extensions/qa-channel/runtime-api.js",
    );
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain("dist/extensions/qa-lab/runtime-api.js");
  });

  it("excludes root-package-excluded plugin sidecars from the packaged runtime sidecar baseline", () => {
    for (const pluginDir of collectRootPackageExcludedExtensionDirsForTest()) {
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(`dist/extensions/${pluginDir}/index.js`);
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
        `dist/extensions/${pluginDir}/runtime-api.js`,
      );
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
        `dist/extensions/${pluginDir}/runtime-setter-api.js`,
      );
    }
  });

  it("captures setup-entry metadata for bundled channel plugins", () => {
    const discord = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "discord");
    expect(discord?.source).toEqual({ source: "./index.ts", built: "index.js" });
    expect(discord?.setupSource).toEqual({ source: "./setup-entry.ts", built: "setup-entry.js" });
    expectArtifactPresence(discord?.publicSurfaceArtifacts, {
      contains: ["api.js", "runtime-api.js", "session-key-api.js"],
      excludes: ["test-api.js"],
    });
    expectArtifactPresence(discord?.runtimeSidecarArtifacts, {
      contains: ["runtime-api.js"],
    });
    expect(discord?.manifest.id).toBe("discord");
    const discordChannelConfig = collectRepoBundledChannelConfigsForTest("discord")?.discord as
      | { schema?: { type?: unknown } }
      | undefined;
    expect(discordChannelConfig?.schema?.type).toBe("object");
  });

  it("keeps Slack's doctor contract sidecar on the bundled public surface", () => {
    const slack = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "slack");
    expectArtifactPresence(slack?.publicSurfaceArtifacts, {
      contains: ["doctor-contract-api.js"],
    });
  });

  it("keeps Memory Core's health checks on a narrow public surface", () => {
    const memoryCore = listRepoBundledPluginMetadata().find(
      (entry) => entry.dirName === "memory-core",
    );
    expectArtifactPresence(memoryCore?.publicSurfaceArtifacts, {
      contains: ["doctor-health-api.js"],
    });
  });

  it("keeps iMessage message-tool discovery on a narrow public surface", () => {
    const imessage = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "imessage");
    expectArtifactPresence(imessage?.publicSurfaceArtifacts, {
      contains: ["message-tool-api.js"],
    });
  });

  it("keeps Slack's narrow runtime-setter sidecar on the bundled public surface", () => {
    // Regression for #69317: the bundled channel entry now points its
    // runtime.specifier at runtime-setter-api.js to avoid loading the full
    // runtime-api barrel during register(). The setter file must therefore
    // be discoverable as part of Slack's public surface.
    const slack = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "slack");
    expectArtifactPresence(slack?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps Telegram's narrow runtime setter on the bundled runtime sidecar surface", () => {
    const telegram = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "telegram");
    expectArtifactPresence(telegram?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
    expectArtifactPresence(telegram?.runtimeSidecarArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps Discord's narrow runtime setter on the bundled runtime sidecar surface", () => {
    const discord = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "discord");
    expectArtifactPresence(discord?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
    expectArtifactPresence(discord?.runtimeSidecarArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps QA runner discovery on narrow bundled runtime sidecars", () => {
    const runnerPlugins = listRepoBundledPluginMetadata().filter(
      (entry) => (entry.manifest.qaRunners?.length ?? 0) > 0,
    );
    expect(runnerPlugins.length).toBeGreaterThan(0);

    for (const plugin of runnerPlugins) {
      expectArtifactPresence(plugin?.publicSurfaceArtifacts, {
        contains: ["qa-runner-api.js"],
      });
      expectArtifactPresence(plugin?.runtimeSidecarArtifacts, {
        contains: ["qa-runner-api.js"],
      });
    }
  });

  it("loads tlon channel config metadata from the lightweight schema surface", () => {
    const tlonChannelConfig = collectRepoBundledChannelConfigsForTest("tlon")?.tlon as
      | { schema?: { type?: unknown } }
      | undefined;
    expect(tlonChannelConfig?.schema?.type).toBe("object");
  });

  it("keeps bundled persisted-auth metadata on channel package manifests", () => {
    const whatsapp = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "whatsapp");
    expect(whatsapp?.packageManifest?.channel?.persistedAuthState).toEqual({
      specifier: "./auth-presence",
      exportName: "hasAnyWhatsAppAuth",
    });

    const matrix = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "matrix");
    expect(matrix?.packageManifest?.channel?.persistedAuthState).toEqual({
      specifier: "./auth-presence",
      exportName: "hasAnyMatrixAuth",
    });
  });

  it("keeps Matrix's narrow runtime-setter sidecar on the bundled public surface", () => {
    const matrix = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "matrix");
    expectArtifactPresence(matrix?.publicSurfaceArtifacts, {
      contains: ["runtime-setter-api.js"],
    });
  });

  it("keeps bundled configured-state env metadata on channel package manifests", () => {
    const configuredChannels = listRepoBundledPluginMetadata()
      .filter((entry) => ["discord", "irc", "slack", "telegram"].includes(entry.dirName))
      .map((entry) => ({
        dir: entry.dirName,
        configuredState: entry.packageManifest?.channel?.configuredState,
      }));
    expect(configuredChannels).toEqual([
      {
        dir: "discord",
        configuredState: {
          env: {
            anyOf: ["DISCORD_BOT_TOKEN"],
          },
        },
      },
      {
        dir: "irc",
        configuredState: {
          env: {
            allOf: ["IRC_HOST", "IRC_NICK"],
          },
        },
      },
      {
        dir: "slack",
        configuredState: {
          env: {
            anyOf: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
          },
          specifier: "./configured-state",
          exportName: "hasConfiguredSlackChannelState",
        },
      },
      {
        dir: "telegram",
        configuredState: {
          env: {
            anyOf: ["TELEGRAM_BOT_TOKEN"],
          },
        },
      },
    ]);
  });

  it("excludes test-only public surface artifacts", () => {
    listRepoBundledPluginMetadata().forEach((entry) =>
      expectTestOnlyArtifactsExcluded(entry.publicSurfaceArtifacts ?? []),
    );
  });

  it("keeps config schemas on all bundled plugin manifests", () => {
    for (const entry of listRepoBundledPluginMetadata()) {
      const { configSchema } = entry.manifest;
      if (configSchema === null) {
        throw new Error(`expected ${entry.manifest.id} config schema`);
      }
      expect(typeof configSchema).toBe("object");
      expect(Array.isArray(configSchema)).toBe(false);
    }
  });

  it("declares explicit startup activation on all bundled plugin manifests", () => {
    for (const entry of listRepoBundledPluginManifests()) {
      expect(typeof entry.manifest.activation?.onStartup).toBe("boolean");
    }
  });

  it("scopes Voice Call CLI activation to the voicecall command", () => {
    const entry = listRepoBundledPluginManifests().find(
      ({ manifest }) => manifest.id === "voice-call",
    );

    expect(entry?.manifest.commandAliases).toStrictEqual([{ name: "voicecall" }]);
    expect(entry?.manifest.activation?.onCommands).toStrictEqual(["voicecall"]);
  });

  it("keeps Workboard CLI ownership separate from its slash command", () => {
    const entry = listRepoBundledPluginManifests().find(
      ({ manifest }) => manifest.id === "workboard",
    );

    expect(entry?.manifest.commandAliases).toStrictEqual([{ name: "workboard" }]);
    expect(entry?.manifest.activation?.onCommands).toStrictEqual(["workboard"]);
  });

  it("scopes Codex CLI activation to the codex command", () => {
    const entry = listRepoBundledPluginManifests().find(({ manifest }) => manifest.id === "codex");

    expect(entry?.manifest.activation?.onCommands).toStrictEqual(["codex"]);
  });

  it("keeps empty-config Gateway startup narrower than declared startup sidecars", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const linuxOnlyPlugin = manifestRegistry.plugins[0];
    assert(linuxOnlyPlugin, "expected bundled plugin manifest fixture");
    manifestRegistry.plugins.push({
      ...linuxOnlyPlugin,
      id: "zz-linux-only-default-test",
      enabledByDefault: undefined,
      enabledByDefaultOnPlatforms: ["linux"],
      activation: { ...linuxOnlyPlugin.activation, onStartup: true },
    });
    const index = createInstalledPluginIndexForManifests(manifestRegistry);
    const expectedPluginIds = [
      ...manifestRegistry.plugins
        .filter(
          (plugin) =>
            isPluginEnabledByDefaultForPlatform(plugin, "linux") && plugin.activation?.onStartup,
        )
        .map((plugin) => plugin.id),
      ...EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_EXTRAS,
    ].toSorted((left, right) => left.localeCompare(right));

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: {},
        env: {},
        index,
        manifestRegistry,
        platform: "linux",
      }),
    ).toEqual(expectedPluginIds);
  });

  it("auto-starts Bonjour for empty-config macOS Gateway startup", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const index = createInstalledPluginIndexForManifests(manifestRegistry);

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: {},
        env: process.env,
        index,
        manifestRegistry,
        platform: "darwin",
      }),
    ).toContain("bonjour");
  });

  it("starts Bonjour when explicitly enabled", () => {
    const manifestRegistry = createRepoBundledManifestRegistry();
    const index = createInstalledPluginIndexForManifests(manifestRegistry);

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: { plugins: { entries: { bonjour: { enabled: true } } } },
        env: process.env,
        index,
        manifestRegistry,
        platform: "linux",
      }),
    ).toContain("bonjour");
  });

  it("prefers built generated paths when present and falls back to source paths", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-metadata-");
    const pluginRoot = path.join(tempRoot, "extensions", "plugin");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "plugin");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    expectGeneratedPathResolution(tempRoot, path.join("extensions", "plugin", "index.ts"));

    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(distPluginRoot, "index.js"), "export {};\n", "utf8");
    expectGeneratedPathResolution(tempRoot, path.join("dist", "extensions", "plugin", "index.js"));
  });

  it("uses dist-runtime generated paths before source fallback when packaged dist is absent", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-runtime-metadata-");
    const pluginRoot = path.join(tempRoot, "extensions", "plugin");
    const runtimePluginRoot = path.join(tempRoot, "dist-runtime", "extensions", "plugin");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(runtimePluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    fs.writeFileSync(path.join(runtimePluginRoot, "index.js"), "export {};\n", "utf8");

    expectGeneratedPathResolution(
      tempRoot,
      path.join("dist-runtime", "extensions", "plugin", "index.js"),
    );
  });

  it("resolves plugin-local generated entry paths when the plugin dir is provided", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-metadata-local-");
    const pluginRoot = path.join(tempRoot, "extensions", "alpha");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "alpha");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export {};\n", "utf8");
    expectPluginScopedGeneratedPathResolution(
      tempRoot,
      "alpha",
      path.join("extensions", "alpha", "index.ts"),
    );

    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(distPluginRoot, "index.js"), "export {};\n", "utf8");
    expectPluginScopedGeneratedPathResolution(
      tempRoot,
      "alpha",
      path.join("dist", "extensions", "alpha", "index.js"),
    );
  });

  it("keeps generated entry path resolution inside bundled plugin roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-path-contained-");
    const sourcePluginRoot = path.join(tempRoot, "extensions", "alpha");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "alpha");
    const absoluteEscape = path.join(tempRoot, "absolute.js");
    const absolutePluginEntry = path.join(sourcePluginRoot, "index.ts");

    fs.mkdirSync(sourcePluginRoot, { recursive: true });
    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(absolutePluginEntry, "export {};\n", "utf8");
    fs.writeFileSync(path.join(tempRoot, "extensions", "escape.ts"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "dist", "extensions", "escape.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(absoluteEscape, "export {};\n", "utf8");

    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: absolutePluginEntry,
          built: absolutePluginEntry,
        },
        "alpha",
      ),
    ).toBe(absolutePluginEntry);
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: "../escape.ts",
          built: "../escape.js",
        },
        "alpha",
      ),
    ).toBeNull();
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: absoluteEscape,
          built: absoluteEscape,
        },
        "alpha",
      ),
    ).toBeNull();
  });

  it("scans direct plugin-tree overrides and resolves generated paths from that scan dir", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-direct-tree-");
    const pluginsDir = path.join(tempRoot, "bundled-plugins");
    const pluginRoot = path.join(pluginsDir, "alpha");

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      channels: ["alpha"],
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");
    expect(
      listBundledPluginMetadata({
        rootDir: tempRoot,
        scanDir: pluginsDir,
      }).map((entry) => entry.manifest.id),
    ).toEqual(["alpha"]);
    expect(
      resolveBundledPluginGeneratedPath(
        tempRoot,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "alpha",
        pluginsDir,
      ),
    ).toBe(path.join(pluginRoot, "index.ts"));
  });

  it("reflects bundled manifest edits in the next lifecycle generation", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-fresh-");
    const pluginRoot = path.join(tempRoot, "extensions", "alpha");

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      name: "Before",
      configSchema: { type: "object" },
    });

    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]?.manifest.name).toBe("Before");

    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      name: "After",
      configSchema: { type: "object" },
    });
    clearPluginMetadataLifecycleCaches();

    expect(listBundledPluginMetadata({ rootDir: tempRoot })[0]?.manifest.name).toBe("After");
  });

  it("prefers direct scan-dir overrides over nested dist artifacts within the same override root", () => {
    const pluginsDir = createGeneratedPluginTempRoot("openclaw-bundled-plugin-direct-priority-");
    const pluginRoot = path.join(pluginsDir, "alpha");
    const nestedDistPluginRoot = path.join(pluginsDir, "dist", "extensions", "alpha");

    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(nestedDistPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, "index.js"), "export const source = true;\n", "utf8");
    fs.writeFileSync(
      path.join(nestedDistPluginRoot, "index.js"),
      "export const built = true;\n",
      "utf8",
    );

    expect(
      resolveBundledPluginGeneratedPath(
        pluginsDir,
        {
          source: "./index.ts",
          built: "index.js",
        },
        "alpha",
        pluginsDir,
      ),
    ).toBe(path.join(pluginRoot, "index.js"));
  });
});
