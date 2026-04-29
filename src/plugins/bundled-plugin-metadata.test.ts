import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectBundledChannelConfigs } from "./bundled-channel-config-metadata.js";
import {
  type BundledPluginMetadata,
  listBundledPluginMetadata,
  resolveBundledPluginGeneratedPath,
  resolveBundledPluginRepoEntryPath,
} from "./bundled-plugin-metadata.js";
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
import { collectBundledRuntimeSidecarPaths } from "./runtime-sidecar-paths-baseline.js";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "./runtime-sidecar-paths.js";

const BUNDLED_PLUGIN_METADATA_TEST_TIMEOUT_MS = 300_000;
const EXPECTED_BUNDLED_STARTUP_PLUGIN_IDS = [
  "acpx",
  "active-memory",
  "bonjour",
  "browser",
  "device-pair",
  "diagnostics-otel",
  "diagnostics-prometheus",
  "diffs",
  "google-meet",
  "llm-task",
  "lobster",
  "memory-wiki",
  "openshell",
  "phone-control",
  "skill-workshop",
  "talk-voice",
  "thread-ownership",
  "voice-call",
  "webhooks",
] as const;
const EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_PLUGIN_IDS = [
  "acpx",
  "bonjour",
  "browser",
  "device-pair",
  "memory-core",
  "phone-control",
  "talk-voice",
] as const;

installGeneratedPluginTempRootCleanup();

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

function listRepoBundledPluginMetadata(): readonly BundledPluginMetadata[] {
  return listBundledPluginMetadata({
    rootDir: repoRoot,
    includeSyntheticChannelConfigs: false,
  });
}

function listRepoBundledPluginManifests() {
  const bundledPluginsDir = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(bundledPluginsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const result = loadPluginManifest(path.join(bundledPluginsDir, entry.name), false);
      return result.ok ? [{ dirName: entry.name, manifest: result.manifest }] : [];
    });
}

function readPackageManifest(pluginDir: string): PackageManifest | undefined {
  const packagePath = path.join(pluginDir, "package.json");
  return fs.existsSync(packagePath)
    ? (JSON.parse(fs.readFileSync(packagePath, "utf8")) as PackageManifest)
    : undefined;
}

function collectRepoBundledChannelConfigsForTest(dirName: string) {
  const pluginDir = path.join(repoRoot, "extensions", dirName);
  const manifest = loadPluginManifest(pluginDir, false);
  if (!manifest.ok) {
    throw manifest.error;
  }
  return collectBundledChannelConfigs({
    pluginDir,
    manifest: manifest.manifest,
    packageManifest: getPackageManifestMetadata(readPackageManifest(pluginDir)),
  });
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
    startup: {
      sidecar: record.activation?.onStartup === true,
      memory: hasPluginKind(record, "memory"),
      deferConfiguredChannelFullLoadUntilAfterListen:
        record.startupDeferConfiguredChannelFullLoadUntilAfterListen === true,
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
    () => {
      expect(BUNDLED_RUNTIME_SIDECAR_PATHS).toEqual(
        collectBundledRuntimeSidecarPaths({ rootDir: repoRoot }),
      );
    },
  );

  it("excludes non-packaged QA sidecars from the packaged runtime sidecar baseline", () => {
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain(
      "dist/extensions/qa-channel/runtime-api.js",
    );
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain("dist/extensions/qa-lab/runtime-api.js");
    expect(BUNDLED_RUNTIME_SIDECAR_PATHS).not.toContain("dist/extensions/qa-matrix/runtime-api.js");
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
    expect(collectRepoBundledChannelConfigsForTest("discord")?.discord).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ type: "object" }),
      }),
    );
  });

  it("keeps Slack's doctor contract sidecar on the bundled public surface", () => {
    const slack = listRepoBundledPluginMetadata().find((entry) => entry.dirName === "slack");
    expectArtifactPresence(slack?.publicSurfaceArtifacts, {
      contains: ["doctor-contract-api.js"],
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

  it("loads tlon channel config metadata from the lightweight schema surface", () => {
    expect(collectRepoBundledChannelConfigsForTest("tlon")?.tlon).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({ type: "object" }),
      }),
    );
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

  it("keeps bundled configured-state metadata on channel package manifests", () => {
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
          specifier: "./configured-state",
          exportName: "hasDiscordConfiguredState",
        },
      },
      {
        dir: "irc",
        configuredState: {
          specifier: "./configured-state",
          exportName: "hasIrcConfiguredState",
        },
      },
      {
        dir: "slack",
        configuredState: {
          specifier: "./configured-state",
          exportName: "hasSlackConfiguredState",
        },
      },
      {
        dir: "telegram",
        configuredState: {
          specifier: "./configured-state",
          exportName: "hasTelegramConfiguredState",
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
      expect(entry.manifest.configSchema).toEqual(expect.any(Object));
    }
  });

  it("declares explicit startup activation on all bundled plugin manifests", () => {
    const startupPluginIds: string[] = [];

    for (const entry of listRepoBundledPluginManifests()) {
      expect(typeof entry.manifest.activation?.onStartup).toBe("boolean");
      if (entry.manifest.activation?.onStartup === true) {
        startupPluginIds.push(entry.manifest.id);
      }
    }

    expect(startupPluginIds.toSorted((left, right) => left.localeCompare(right))).toEqual(
      EXPECTED_BUNDLED_STARTUP_PLUGIN_IDS,
    );
  });

  it("keeps empty-config Gateway startup narrower than declared startup sidecars", () => {
    const manifestRegistry = {
      plugins: listRepoBundledPluginManifests().map(({ manifest, dirName }) => ({
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        enabledByDefault: manifest.enabledByDefault === true ? true : undefined,
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
    } satisfies PluginManifestRegistry;
    const index = createInstalledPluginIndexForManifests(manifestRegistry);

    expect(
      resolveGatewayStartupPluginIdsFromRegistry({
        config: {},
        env: process.env,
        index,
        manifestRegistry,
      }),
    ).toEqual(EXPECTED_EMPTY_CONFIG_GATEWAY_STARTUP_PLUGIN_IDS);
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

  it("reflects bundled manifest edits on the next metadata read", () => {
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

  it("resolves bundled repo entry paths from dist before workspace source", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-repo-entry-");
    const pluginRoot = path.join(tempRoot, "extensions", "alpha");
    const distPluginRoot = path.join(tempRoot, "dist", "extensions", "alpha");

    writeJson(path.join(pluginRoot, "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
      },
    });
    writeJson(path.join(pluginRoot, "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export const source = true;\n", "utf8");

    expect(
      resolveBundledPluginRepoEntryPath({
        rootDir: tempRoot,
        pluginId: "alpha",
        preferBuilt: true,
      }),
    ).toBe(path.join(pluginRoot, "index.ts"));

    fs.mkdirSync(distPluginRoot, { recursive: true });
    fs.writeFileSync(path.join(distPluginRoot, "index.js"), "export const built = true;\n", "utf8");
    expect(
      resolveBundledPluginRepoEntryPath({
        rootDir: tempRoot,
        pluginId: "alpha",
        preferBuilt: true,
      }),
    ).toBe(path.join(distPluginRoot, "index.js"));
  });

  it("merges runtime channel schema metadata with manifest-owned channel config fields", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-channel-configs-");

    writeJson(path.join(tempRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
          preferOver: ["alpha-legacy"],
        },
      },
    });
    writeJson(path.join(tempRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      channels: ["alpha"],
      configSchema: { type: "object" },
      channelConfigs: {
        alpha: {
          schema: { type: "object", properties: { stale: { type: "boolean" } } },
          label: "Manifest Label",
          uiHints: {
            "channels.alpha.explicitOnly": {
              help: "manifest hint",
            },
          },
        },
      },
    });
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "index.ts"),
      "export {};\n",
      "utf8",
    );
    fs.mkdirSync(path.join(tempRoot, "extensions", "alpha", "src"), { recursive: true });
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "src", "config-schema.js"),
      [
        "export const AlphaChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { generated: { type: 'string' } },",
        "  },",
        "  uiHints: {",
        "    'channels.alpha.generatedOnly': { help: 'generated hint' },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: tempRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          generated: { type: "string" },
        },
      },
      label: "Manifest Label",
      description: "Alpha Root Description",
      preferOver: ["alpha-legacy"],
      uiHints: {
        "channels.alpha.generatedOnly": { help: "generated hint" },
        "channels.alpha.explicitOnly": { help: "manifest hint" },
      },
    });
  });

  it("captures top-level public surface artifacts without duplicating the primary entrypoints", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-public-artifacts-");

    writeJson(path.join(tempRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        setupEntry: "./setup-entry.ts",
      },
    });
    writeJson(path.join(tempRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "index.ts"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "setup-entry.ts"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(path.join(tempRoot, "extensions", "alpha", "api.ts"), "export {};\n", "utf8");
    fs.writeFileSync(
      path.join(tempRoot, "extensions", "alpha", "runtime-api.ts"),
      "export {};\n",
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: tempRoot });
    const firstEntry = entries[0] as
      | {
          publicSurfaceArtifacts?: string[];
          runtimeSidecarArtifacts?: string[];
        }
      | undefined;
    expect(firstEntry?.publicSurfaceArtifacts).toEqual(["api.js", "runtime-api.js"]);
    expect(firstEntry?.runtimeSidecarArtifacts).toEqual(["runtime-api.js"]);
  });

  it("loads channel config metadata from built public surfaces in dist-only roots", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-");
    const distRoot = path.join(tempRoot, "dist");

    writeJson(path.join(distRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
        },
      },
    });
    writeJson(path.join(distRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: {
        type: "object",
        properties: {},
      },
      channels: ["alpha"],
      channelConfigs: {
        alpha: {
          schema: { type: "object", properties: { stale: { type: "boolean" } } },
          uiHints: {
            "channels.alpha.explicitOnly": {
              help: "manifest hint",
            },
          },
        },
      },
    });
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "index.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "channel-config-api.js"),
      [
        "export const AlphaChannelConfigSchema = {",
        "  schema: {",
        "    type: 'object',",
        "    properties: { built: { type: 'string' } },",
        "  },",
        "  uiHints: {",
        "    'channels.alpha.generatedOnly': { help: 'built hint' },",
        "  },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: distRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toEqual({
      schema: {
        type: "object",
        properties: {
          built: { type: "string" },
        },
      },
      label: "Alpha Root Label",
      description: "Alpha Root Description",
      uiHints: {
        "channels.alpha.generatedOnly": { help: "built hint" },
        "channels.alpha.explicitOnly": { help: "manifest hint" },
      },
    });
  });

  it("does not probe broad runtime public surfaces for channel config metadata", () => {
    const tempRoot = createGeneratedPluginTempRoot("openclaw-bundled-plugin-dist-config-runtime-");
    const distRoot = path.join(tempRoot, "dist");
    const markerPath = path.join(tempRoot, "runtime-api-loaded");

    writeJson(path.join(distRoot, "extensions", "alpha", "package.json"), {
      name: "@openclaw/alpha",
      version: "0.0.1",
      openclaw: {
        extensions: ["./index.ts"],
        channel: {
          id: "alpha",
          label: "Alpha Root Label",
          blurb: "Alpha Root Description",
        },
      },
    });
    writeJson(path.join(distRoot, "extensions", "alpha", "openclaw.plugin.json"), {
      id: "alpha",
      configSchema: {
        type: "object",
        properties: {},
      },
      channels: ["alpha"],
      channelConfigs: {
        alpha: {
          schema: { type: "object", properties: { manifest: { type: "boolean" } } },
        },
      },
    });
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "index.js"),
      "export {};\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "runtime-api.js"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
        "export const AlphaChannelConfigSchema = {",
        "  schema: { type: 'object', properties: { runtimeApi: { type: 'string' } } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(distRoot, "extensions", "alpha", "api.js"),
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(markerPath)}, "loaded", "utf8");`,
        "export const AlphaChannelConfigSchema = {",
        "  schema: { type: 'object', properties: { api: { type: 'string' } } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = listBundledPluginMetadata({ rootDir: distRoot });
    const channelConfigs = entries[0]?.manifest.channelConfigs as
      | Record<string, unknown>
      | undefined;
    expect(channelConfigs?.alpha).toMatchObject({
      schema: {
        type: "object",
        properties: {
          manifest: { type: "boolean" },
        },
      },
      label: "Alpha Root Label",
      description: "Alpha Root Description",
    });
    expect(fs.existsSync(markerPath)).toBe(false);
  });
});
