import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  clearPluginManifestRegistryCache,
  loadPluginManifestRegistry,
} from "./manifest-registry.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs: string[] = [];

function chmodSafeDir(dir: string) {
  if (process.platform === "win32") {
    return;
  }
  fs.chmodSync(dir, 0o755);
}

function mkdirSafe(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  chmodSafeDir(dir);
}

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-registry", tempDirs);
}

function writeManifest(dir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
}

function writeTextFile(rootDir: string, relativePath: string, value: string) {
  mkdirSafe(path.dirname(path.join(rootDir, relativePath)));
  fs.writeFileSync(path.join(rootDir, relativePath), value, "utf-8");
}

function setupBundleFixture(params: {
  bundleDir: string;
  dirs?: readonly string[];
  textFiles?: Readonly<Record<string, string>>;
  manifestRelativePath?: string;
  manifest?: Record<string, unknown>;
}) {
  for (const relativeDir of params.dirs ?? []) {
    mkdirSafe(path.join(params.bundleDir, relativeDir));
  }
  for (const [relativePath, value] of Object.entries(params.textFiles ?? {})) {
    writeTextFile(params.bundleDir, relativePath, value);
  }
  if (params.manifestRelativePath && params.manifest) {
    writeTextFile(params.bundleDir, params.manifestRelativePath, JSON.stringify(params.manifest));
  }
}

function createPluginCandidate(params: {
  idHint: string;
  rootDir: string;
  sourceName?: string;
  origin: "bundled" | "global" | "workspace" | "config";
  format?: "openclaw" | "bundle";
  bundleFormat?: "codex" | "claude" | "cursor";
  packageManifest?: OpenClawPackageManifest;
  packageDir?: string;
  bundledManifest?: PluginCandidate["bundledManifest"];
  bundledManifestPath?: string;
}): PluginCandidate {
  return {
    idHint: params.idHint,
    source: path.join(params.rootDir, params.sourceName ?? "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin,
    format: params.format,
    bundleFormat: params.bundleFormat,
    packageManifest: params.packageManifest,
    packageDir: params.packageDir,
    bundledManifest: params.bundledManifest,
    bundledManifestPath: params.bundledManifestPath,
  };
}

function loadRegistry(candidates: PluginCandidate[]) {
  return loadPluginManifestRegistry({
    candidates,
    cache: false,
  });
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_VERSION: undefined,
    VITEST: "true",
    ...overrides,
  };
}

function countDuplicateWarnings(registry: ReturnType<typeof loadPluginManifestRegistry>): number {
  return registry.diagnostics.filter(
    (diagnostic) =>
      diagnostic.level === "warn" && diagnostic.message?.includes("duplicate plugin id"),
  ).length;
}

function hasPluginIdMismatchWarning(
  registry: ReturnType<typeof loadPluginManifestRegistry>,
): boolean {
  return registry.diagnostics.some((diagnostic) =>
    diagnostic.message.includes("plugin id mismatch"),
  );
}

function expectRegistryDiagnosticContains(
  registry: ReturnType<typeof loadPluginManifestRegistry>,
  fragment: string,
) {
  expect(registry.diagnostics.some((diag) => diag.message.includes(fragment))).toBe(true);
}

function prepareLinkedManifestFixture(params: { id: string; mode: "symlink" | "hardlink" }): {
  rootDir: string;
  linked: boolean;
} {
  const rootDir = makeTempDir();
  const outsideDir = makeTempDir();
  const outsideManifest = path.join(outsideDir, "openclaw.plugin.json");
  const linkedManifest = path.join(rootDir, "openclaw.plugin.json");
  fs.writeFileSync(path.join(rootDir, "index.ts"), "export default function () {}", "utf-8");
  fs.writeFileSync(
    outsideManifest,
    JSON.stringify({ id: params.id, configSchema: { type: "object" } }),
    "utf-8",
  );

  try {
    if (params.mode === "symlink") {
      fs.symlinkSync(outsideManifest, linkedManifest);
    } else {
      fs.linkSync(outsideManifest, linkedManifest);
    }
    return { rootDir, linked: true };
  } catch (err) {
    if (params.mode === "symlink") {
      return { rootDir, linked: false };
    }
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      return { rootDir, linked: false };
    }
    throw err;
  }
}

function loadSingleCandidateRegistry(params: {
  idHint: string;
  rootDir: string;
  origin: "bundled" | "global" | "workspace" | "config";
}) {
  return loadRegistry([
    createPluginCandidate({
      idHint: params.idHint,
      rootDir: params.rootDir,
      origin: params.origin,
    }),
  ]);
}

function loadRegistryForMinHostVersionCase(params: {
  rootDir: string;
  minHostVersion: string;
  env?: NodeJS.ProcessEnv;
}) {
  return loadPluginManifestRegistry({
    cache: false,
    ...(params.env ? { env: params.env } : {}),
    candidates: [
      createPluginCandidate({
        idHint: "synology-chat",
        rootDir: params.rootDir,
        packageDir: params.rootDir,
        origin: "global",
        packageManifest: {
          install: {
            npmSpec: "@openclaw/synology-chat",
            minHostVersion: params.minHostVersion,
          },
        },
      }),
    ],
  });
}

function hasUnsafeManifestDiagnostic(registry: ReturnType<typeof loadPluginManifestRegistry>) {
  return registry.diagnostics.some((diag) => diag.message.includes("unsafe plugin manifest path"));
}

function expectUnsafeWorkspaceManifestRejected(params: {
  id: string;
  mode: "symlink" | "hardlink";
}) {
  const fixture = prepareLinkedManifestFixture({ id: params.id, mode: params.mode });
  if (!fixture.linked) {
    return;
  }
  const registry = loadSingleCandidateRegistry({
    idHint: params.id,
    rootDir: fixture.rootDir,
    origin: "workspace",
  });
  expect(registry.plugins).toHaveLength(0);
  expect(hasUnsafeManifestDiagnostic(registry)).toBe(true);
}

function createDuplicateCandidateRegistry(params: {
  pluginId: string;
  duplicateOrigin: "global" | "workspace";
}) {
  const bundledDir = makeTempDir();
  const duplicateDir = makeTempDir();
  const manifest = { id: params.pluginId, configSchema: { type: "object" } };
  writeManifest(bundledDir, manifest);
  writeManifest(duplicateDir, manifest);

  return loadPluginManifestRegistry({
    cache: false,
    candidates: [
      createPluginCandidate({
        idHint: params.pluginId,
        rootDir: bundledDir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: params.pluginId,
        rootDir: duplicateDir,
        origin: params.duplicateOrigin,
      }),
    ],
  });
}

function createManifestPluginRoot(params: {
  baseDir: string;
  pluginId: string;
  name: string;
  relativePath?: string;
}) {
  const pluginRoot = path.join(
    params.baseDir,
    ...(params.relativePath ? [params.relativePath] : []),
  );
  mkdirSafe(pluginRoot);
  writeManifest(pluginRoot, {
    id: params.pluginId,
    name: params.name,
    configSchema: { type: "object" },
  });
  fs.writeFileSync(path.join(pluginRoot, "index.ts"), "export default {}", "utf-8");
  return pluginRoot;
}

function loadBundleRegistry(params: {
  idHint: string;
  bundleFormat: "codex" | "claude" | "cursor";
  setup: (bundleDir: string) => void;
}) {
  const bundleDir = makeTempDir();
  params.setup(bundleDir);
  return loadRegistry([
    createPluginCandidate({
      idHint: params.idHint,
      rootDir: bundleDir,
      origin: "global",
      format: "bundle",
      bundleFormat: params.bundleFormat,
    }),
  ]);
}

function expectPluginRoot(
  registry: ReturnType<typeof loadPluginManifestRegistry>,
  pluginId: string,
) {
  const plugin = registry.plugins.find((entry) => entry.id === pluginId);
  expect(plugin).toBeDefined();
  return plugin?.rootDir ?? "";
}

function expectCachedPluginRoot(params: {
  first: ReturnType<typeof loadPluginManifestRegistry>;
  second: ReturnType<typeof loadPluginManifestRegistry>;
  pluginId: string;
  firstRoot: string;
  secondRoot: string;
}) {
  expect(fs.realpathSync(expectPluginRoot(params.first, params.pluginId))).toBe(
    fs.realpathSync(params.firstRoot),
  );
  expect(fs.realpathSync(expectPluginRoot(params.second, params.pluginId))).toBe(
    fs.realpathSync(params.secondRoot),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginManifestRegistryCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifestRegistry", () => {
  it("keeps only the higher-precedence plugin for truly distinct duplicates", () => {
    const dirA = makeTempDir();
    const dirB = makeTempDir();
    const manifest = { id: "test-plugin", configSchema: { type: "object" } };
    writeManifest(dirA, manifest);
    writeManifest(dirB, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "test-plugin",
        rootDir: dirA,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "test-plugin",
        rootDir: dirB,
        origin: "global",
      }),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateWarnings(registry)).toBe(1);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.origin).toBe("bundled");
    expectRegistryDiagnosticContains(
      registry,
      "global plugin will be overridden by bundled plugin",
    );
  });

  it("lets config-loaded plugins replace bundled duplicates", () => {
    const bundledDir = makeTempDir();
    const configDir = makeTempDir();
    const manifest = { id: "config-shadow", configSchema: { type: "object" } };
    writeManifest(bundledDir, manifest);
    writeManifest(configDir, manifest);

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "config-shadow",
        rootDir: bundledDir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "config-shadow",
        rootDir: configDir,
        origin: "config",
      }),
    ]);

    expect(countDuplicateWarnings(registry)).toBe(1);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.origin).toBe("config");
    const warning = registry.diagnostics.find((diag) => diag.pluginId === "config-shadow");
    expect(warning?.source).toBe(path.join(bundledDir, "index.ts"));
    expect(warning?.message).toContain(path.join(configDir, "index.ts"));
  });

  it("reports explicit installed globals as the effective duplicate winner", () => {
    const bundledDir = makeTempDir();
    const globalDir = makeTempDir();
    const manifest = { id: "zalouser", configSchema: { type: "object" } };
    writeManifest(bundledDir, manifest);
    writeManifest(globalDir, manifest);

    const registry = loadPluginManifestRegistry({
      cache: false,
      installRecords: {
        zalouser: {
          source: "npm",
          installPath: globalDir,
        },
      },
      candidates: [
        createPluginCandidate({
          idHint: "zalouser",
          rootDir: bundledDir,
          origin: "bundled",
        }),
        createPluginCandidate({
          idHint: "zalouser",
          rootDir: globalDir,
          origin: "global",
        }),
      ],
    });

    expect(
      registry.diagnostics.some((diag) =>
        diag.message.includes("bundled plugin will be overridden by global plugin"),
      ),
    ).toBe(true);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.origin).toBe("global");
  });

  it("preserves provider auth env metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "openai",
      enabledByDefault: true,
      providers: ["openai", "openai-codex"],
      providerAuthEnvVars: {
        openai: ["OPENAI_API_KEY"],
      },
      providerEndpoints: [
        {
          endpointClass: "openai-public",
          hosts: ["API.OPENAI.COM", ""],
          baseUrls: ["https://api.openai.com/v1"],
        },
      ],
      syntheticAuthRefs: ["openai-cli"],
      nonSecretAuthMarkers: ["openai-cli"],
      providerAuthAliases: {
        "openai-codex": "openai",
      },
      providerAuthChoices: [
        {
          provider: "openai",
          method: "api-key",
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          assistantPriority: 10,
          assistantVisibility: "visible",
        },
      ],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.providerAuthEnvVars).toEqual({
      openai: ["OPENAI_API_KEY"],
    });
    expect(registry.plugins[0]?.providerEndpoints).toEqual([
      {
        endpointClass: "openai-public",
        hosts: ["api.openai.com"],
        baseUrls: ["https://api.openai.com/v1"],
      },
    ]);
    expect(registry.plugins[0]?.syntheticAuthRefs).toEqual(["openai-cli"]);
    expect(registry.plugins[0]?.nonSecretAuthMarkers).toEqual(["openai-cli"]);
    expect(registry.plugins[0]?.providerAuthAliases).toEqual({
      "openai-codex": "openai",
    });
    expect(registry.plugins[0]?.enabledByDefault).toBe(true);
    expect(registry.plugins[0]?.providerAuthChoices).toEqual([
      {
        provider: "openai",
        method: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        assistantPriority: 10,
        assistantVisibility: "visible",
      },
    ]);
  });

  it("preserves model catalog metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "moonshot",
      providers: ["moonshot"],
      modelCatalog: {
        providers: {
          moonshot: {
            baseUrl: "https://api.moonshot.ai/v1",
            api: "openai-responses",
            headers: {
              "x-provider": "moonshot",
            },
            models: [
              {
                id: "kimi-k2.6",
                name: "Kimi K2.6",
                input: ["text", "image", "bogus"],
                reasoning: true,
                contextWindow: 256000,
                contextTokens: 200000,
                maxTokens: 128000,
                cost: {
                  input: 0.6,
                  output: 2.5,
                  cacheRead: 0.15,
                  tieredPricing: [
                    {
                      input: 0.6,
                      output: 2.5,
                      cacheRead: 0.15,
                      cacheWrite: 0.6,
                      range: [0, "bad"],
                    },
                    {
                      input: 0.6,
                      output: 2.5,
                      cacheRead: 0.15,
                      cacheWrite: 0.6,
                      range: [0, -1],
                    },
                    {
                      input: 0.6,
                      output: 2.5,
                      cacheRead: 0.15,
                      cacheWrite: 0.6,
                      range: [0, 256000],
                    },
                  ],
                },
                compat: {
                  supportsTools: true,
                  supportedReasoningEfforts: ["low", "medium"],
                  supportsStore: "yes",
                  unknownFlag: true,
                },
                status: "available",
                tags: ["default"],
              },
            ],
          },
          openai: {
            models: [{ id: "gpt-5.4" }],
          },
        },
        aliases: {
          kimi: {
            provider: "moonshot",
            api: "openai-responses",
          },
          openai: {
            provider: "openai",
          },
        },
        suppressions: [
          {
            provider: "openai",
            model: "legacy-kimi",
            reason: "superseded by moonshot/kimi-k2.6",
          },
        ],
        discovery: {
          moonshot: "static",
          openai: "static",
          ignored: "unknown",
        },
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "moonshot",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.modelCatalog).toEqual({
      providers: {
        moonshot: {
          baseUrl: "https://api.moonshot.ai/v1",
          api: "openai-responses",
          headers: {
            "x-provider": "moonshot",
          },
          models: [
            {
              id: "kimi-k2.6",
              name: "Kimi K2.6",
              input: ["text", "image"],
              reasoning: true,
              contextWindow: 256000,
              contextTokens: 200000,
              maxTokens: 128000,
              cost: {
                input: 0.6,
                output: 2.5,
                cacheRead: 0.15,
                tieredPricing: [
                  {
                    input: 0.6,
                    output: 2.5,
                    cacheRead: 0.15,
                    cacheWrite: 0.6,
                    range: [0, 256000],
                  },
                ],
              },
              compat: {
                supportsTools: true,
                supportedReasoningEfforts: ["low", "medium"],
              },
              status: "available",
              tags: ["default"],
            },
          ],
        },
      },
      aliases: {
        kimi: {
          provider: "moonshot",
          api: "openai-responses",
        },
      },
      suppressions: [
        {
          provider: "openai",
          model: "legacy-kimi",
          reason: "superseded by moonshot/kimi-k2.6",
        },
      ],
      discovery: {
        moonshot: "static",
      },
    });
  });

  it("reports non-bundled providerAuthEnvVars as deprecated compat metadata", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "external-openai",
      providers: ["openai"],
      providerAuthEnvVars: {
        openai: ["OPENAI_API_KEY"],
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "external-openai",
      rootDir: dir,
      origin: "global",
    });

    expect(registry.plugins[0]?.providerAuthEnvVars).toEqual({
      openai: ["OPENAI_API_KEY"],
    });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        pluginId: "external-openai",
        source: path.join(dir, "openclaw.plugin.json"),
        message: expect.stringContaining(
          "providerAuthEnvVars is deprecated compatibility metadata",
        ),
      }),
    );
  });

  it("sanitizes manifest-controlled fields in provider auth compatibility diagnostics", () => {
    const dir = makeTempDir();
    const lineBreak = String.fromCharCode(10);
    const ansiRed = `${String.fromCharCode(27)}[31m`;
    writeManifest(dir, {
      id: `external${lineBreak}openai${ansiRed}`,
      providers: ["openai"],
      providerAuthEnvVars: {
        [`openai${lineBreak}${ansiRed}`]: ["OPENAI_API_KEY"],
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "external-openai",
      rootDir: dir,
      origin: "global",
    });
    const diagnostic = registry.diagnostics.find((entry) =>
      entry.message.includes("providerAuthEnvVars is deprecated compatibility metadata"),
    );

    expect(diagnostic?.pluginId).toBe("externalopenai");
    expect(diagnostic?.message).toContain("openai");
    expect(diagnostic?.message).not.toContain(lineBreak);
    expect(diagnostic?.message).not.toContain(ansiRed);
  });

  it("reports non-bundled channel manifests without channel config descriptors", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "external-chat",
      channels: ["external-chat"],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "external-chat",
      rootDir: dir,
      origin: "global",
    });

    expect(registry.plugins[0]?.channels).toEqual(["external-chat"]);
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        level: "warn",
        pluginId: "external-chat",
        source: path.join(dir, "openclaw.plugin.json"),
        message: expect.stringContaining("without channelConfigs metadata"),
      }),
    );
  });

  it("sanitizes manifest-controlled fields in channel config descriptor diagnostics", () => {
    const dir = makeTempDir();
    const lineBreak = String.fromCharCode(10);
    const ansiRed = `${String.fromCharCode(27)}[31m`;
    writeManifest(dir, {
      id: `external${lineBreak}chat${ansiRed}`,
      channels: [`external${lineBreak}channel${ansiRed}`],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "external-chat",
      rootDir: dir,
      origin: "global",
    });
    const diagnostic = registry.diagnostics.find((entry) =>
      entry.message.includes("without channelConfigs metadata"),
    );

    expect(diagnostic?.pluginId).toBe("externalchat");
    expect(diagnostic?.message).toContain("externalchannel");
    expect(diagnostic?.message).not.toContain(lineBreak);
    expect(diagnostic?.message).not.toContain(ansiRed);
  });

  it("accepts non-bundled channel manifests with channel config descriptors", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "external-chat",
      channels: ["external-chat"],
      configSchema: { type: "object" },
      channelConfigs: {
        "external-chat": {
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              token: { type: "string" },
            },
          },
        },
      },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "external-chat",
      rootDir: dir,
      origin: "global",
    });

    expect(registry.plugins[0]?.channelConfigs?.["external-chat"]?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(
      registry.diagnostics.some((diagnostic) =>
        diagnostic.message.includes("without channelConfigs metadata"),
      ),
    ).toBe(false);
  });

  it("drops prototype-polluting channel config keys from plugin manifests", () => {
    const dir = makeTempDir();
    writeTextFile(
      dir,
      "openclaw.plugin.json",
      JSON.stringify({
        id: "external-chat",
        channels: ["safe-chat"],
        configSchema: { type: "object" },
        channelConfigs: {
          ["__proto__"]: {
            schema: {
              type: "object",
              properties: {
                polluted: { const: true },
              },
            },
          },
          constructor: {
            schema: { type: "object" },
          },
          prototype: {
            schema: { type: "object" },
          },
          "safe-chat": {
            schema: {
              type: "object",
              additionalProperties: false,
            },
          },
        },
      }),
    );

    const registry = loadSingleCandidateRegistry({
      idHint: "external-chat",
      rootDir: dir,
      origin: "global",
    });
    const channelConfigs = registry.plugins[0]?.channelConfigs;

    expect(channelConfigs).toBeDefined();
    expect(Object.getPrototypeOf(channelConfigs)).toBe(null);
    expect(Object.prototype.hasOwnProperty.call(channelConfigs, "__proto__")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(channelConfigs, "constructor")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(channelConfigs, "prototype")).toBe(false);
    expect(channelConfigs?.["safe-chat"]?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
  });

  it("falls back providerDiscoverySource from .ts to emitted .js files", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "anthropic-vertex",
      providers: ["anthropic-vertex"],
      providerDiscoveryEntry: "./provider-discovery.ts",
      configSchema: { type: "object" },
    });
    fs.writeFileSync(path.join(dir, "provider-discovery.js"), "export default {};\n", "utf8");

    const registry = loadSingleCandidateRegistry({
      idHint: "anthropic-vertex",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.providerDiscoverySource).toBe(
      path.join(dir, "provider-discovery.js"),
    );
  });

  it("preserves activation and setup descriptors from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "openai",
      providers: ["openai"],
      activation: {
        onProviders: ["openai"],
        onCommands: ["models"],
        onChannels: ["web"],
        onRoutes: ["gateway-webhook"],
        onCapabilities: ["provider", "tool"],
      },
      setup: {
        providers: [
          {
            id: "openai",
            authMethods: ["api-key"],
            envVars: ["OPENAI_API_KEY"],
          },
        ],
        cliBackends: ["openai-cli"],
        configMigrations: ["legacy-openai-auth"],
        requiresRuntime: false,
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.activation).toEqual({
      onProviders: ["openai"],
      onCommands: ["models"],
      onChannels: ["web"],
      onRoutes: ["gateway-webhook"],
      onCapabilities: ["provider", "tool"],
    });
    expect(registry.plugins[0]?.setup).toEqual({
      providers: [
        {
          id: "openai",
          authMethods: ["api-key"],
          envVars: ["OPENAI_API_KEY"],
        },
      ],
      cliBackends: ["openai-cli"],
      configMigrations: ["legacy-openai-auth"],
      requiresRuntime: false,
    });
  });

  it("preserves media-understanding provider metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "openai",
      contracts: {
        mediaUnderstandingProviders: ["openai"],
      },
      mediaUnderstandingProviderMetadata: {
        openai: {
          capabilities: ["image", "audio", "unknown"],
          defaultModels: {
            image: "gpt-5.4-mini",
            audio: "gpt-4o-transcribe",
            unknown: "ignored",
          },
          autoPriority: {
            image: 10,
            audio: 20,
            video: "ignored",
          },
          nativeDocumentInputs: ["pdf", "docx"],
        },
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.mediaUnderstandingProviderMetadata).toEqual({
      openai: {
        capabilities: ["image", "audio"],
        defaultModels: {
          image: "gpt-5.4-mini",
          audio: "gpt-4o-transcribe",
        },
        autoPriority: {
          image: 10,
          audio: 20,
        },
        nativeDocumentInputs: ["pdf"],
      },
    });
  });

  it("preserves external auth provider contracts from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "acme-ai",
      providers: ["acme-ai"],
      contracts: {
        externalAuthProviders: ["acme-ai"],
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "acme-ai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.contracts).toEqual({
      externalAuthProviders: ["acme-ai"],
    });
  });

  it("preserves channel env metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "slack",
      channels: ["slack"],
      channelEnvVars: {
        slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
      },
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "slack",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.channelEnvVars).toEqual({
      slack: ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "SLACK_USER_TOKEN"],
    });
  });

  it("preserves qa runner descriptors from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "qa-matrix",
      qaRunners: [
        {
          commandName: "matrix",
          description: "Run the Matrix live QA lane",
        },
      ],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "qa-matrix",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.qaRunners).toEqual([
      {
        commandName: "matrix",
        description: "Run the Matrix live QA lane",
      },
    ]);
  });

  it("preserves channel config metadata from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "matrix",
      channels: ["matrix"],
      configSchema: { type: "object" },
      channelConfigs: {
        matrix: {
          schema: {
            type: "object",
            properties: {
              homeserver: { type: "string" },
            },
          },
          uiHints: {
            homeserver: {
              label: "Homeserver",
            },
          },
          label: "Matrix",
          description: "Matrix config",
          preferOver: ["matrix-legacy"],
        },
      },
    });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "matrix",
        rootDir: dir,
        origin: "workspace",
      }),
    ]);

    expect(registry.plugins[0]?.channelConfigs).toEqual({
      matrix: {
        schema: {
          type: "object",
          properties: {
            homeserver: { type: "string" },
          },
        },
        uiHints: {
          homeserver: {
            label: "Homeserver",
          },
        },
        label: "Matrix",
        description: "Matrix config",
        preferOver: ["matrix-legacy"],
      },
    });
  });

  it("hydrates bundled channel config metadata onto manifest records", () => {
    const dir = makeTempDir();
    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "telegram",
        rootDir: dir,
        origin: "bundled",
        bundledManifestPath: path.join(dir, "openclaw.plugin.json"),
        bundledManifest: {
          id: "telegram",
          configSchema: { type: "object" },
          channels: ["telegram"],
          channelConfigs: {
            telegram: {
              schema: { type: "object" },
            },
          },
        },
      }),
    ]);

    expect(registry.plugins[0]?.channelConfigs?.telegram).toEqual(
      expect.objectContaining({
        schema: expect.objectContaining({
          type: "object",
        }),
      }),
    );
  });

  it("preserves manifest-owned config contracts from plugin manifests", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "acpx",
      configSchema: { type: "object" },
      configContracts: {
        compatibilityMigrationPaths: ["models.bedrockDiscovery"],
        compatibilityRuntimePaths: ["tools.web.search.apiKey"],
        dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
        secretInputs: {
          bundledDefaultEnabled: false,
          paths: [{ path: "mcpServers.*.env.*", expected: "string" }],
        },
      },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "acpx",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.configContracts).toEqual({
      compatibilityMigrationPaths: ["models.bedrockDiscovery"],
      compatibilityRuntimePaths: ["tools.web.search.apiKey"],
      dangerousFlags: [{ path: "permissionMode", equals: "approve-all" }],
      secretInputs: {
        bundledDefaultEnabled: false,
        paths: [{ path: "mcpServers.*.env.*", expected: "string" }],
      },
    });
  });

  it("resolves contract plugin ids by compatibility runtime path", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "brave",
      configSchema: { type: "object" },
      contracts: {
        webSearchProviders: ["brave"],
      },
      configContracts: {
        compatibilityRuntimePaths: ["tools.web.search.apiKey"],
      },
    });

    const otherDir = makeTempDir();
    writeManifest(otherDir, {
      id: "google",
      configSchema: { type: "object" },
      contracts: {
        webSearchProviders: ["gemini"],
      },
    });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "brave",
        rootDir: dir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "google",
        rootDir: otherDir,
        origin: "bundled",
      }),
    ]);

    expect(
      registry.plugins
        .filter(
          (plugin) =>
            (plugin.contracts?.webSearchProviders?.length ?? 0) > 0 &&
            (plugin.configContracts?.compatibilityRuntimePaths ?? []).includes(
              "tools.web.search.apiKey",
            ),
        )
        .map((plugin) => plugin.id),
    ).toEqual(["brave"]);
  });
  it("does not promote legacy top-level capability fields into contracts", () => {
    const dir = makeTempDir();
    writeManifest(dir, {
      id: "openai",
      providers: ["openai", "openai-codex"],
      speechProviders: ["openai"],
      mediaUnderstandingProviders: ["openai", "openai-codex"],
      imageGenerationProviders: ["openai"],
      configSchema: { type: "object" },
    });

    const registry = loadSingleCandidateRegistry({
      idHint: "openai",
      rootDir: dir,
      origin: "bundled",
    });

    expect(registry.plugins[0]?.contracts).toBeUndefined();
  });
  it.each([
    {
      name: "skips plugins whose minHostVersion is newer than the current host",
      minHostVersion: ">=2026.3.22",
      env: { OPENCLAW_VERSION: "2026.3.21" } as NodeJS.ProcessEnv,
      expectedMessage: "plugin requires OpenClaw >=2026.3.22, but this host is 2026.3.21",
      expectWarn: false,
    },
    {
      name: "rejects invalid minHostVersion metadata",
      minHostVersion: "2026.3.22",
      expectedMessage: "plugin manifest invalid | openclaw.install.minHostVersion must use",
      expectWarn: false,
    },
    {
      name: "warns distinctly when host version cannot be determined",
      minHostVersion: ">=2026.3.22",
      env: { OPENCLAW_VERSION: "unknown" } as NodeJS.ProcessEnv,
      expectedMessage: "host version could not be determined",
      expectWarn: true,
    },
  ] as const)("$name", ({ minHostVersion, env, expectedMessage, expectWarn }) => {
    const dir = makeTempDir();
    writeManifest(dir, { id: "synology-chat", configSchema: { type: "object" } });

    const registry = loadRegistryForMinHostVersionCase({
      rootDir: dir,
      minHostVersion,
      ...(env ? { env } : {}),
    });

    expect(registry.plugins).toEqual([]);
    expectRegistryDiagnosticContains(registry, expectedMessage);
    if (expectWarn) {
      expect(registry.diagnostics.some((diag) => diag.level === "warn")).toBe(true);
    }
  });

  it.each([
    {
      name: "reports bundled plugins as the duplicate winner for auto-discovered globals",
      registry: () =>
        createDuplicateCandidateRegistry({
          pluginId: "feishu",
          duplicateOrigin: "global",
        }),
      expectedMessage: "global plugin will be overridden by bundled plugin",
    },
    {
      name: "reports bundled plugins as the duplicate winner for workspace duplicates",
      registry: () =>
        createDuplicateCandidateRegistry({
          pluginId: "shadowed",
          duplicateOrigin: "workspace",
        }),
      expectedMessage: "workspace plugin will be overridden by bundled plugin",
    },
  ] as const)("$name", ({ registry: buildRegistry, expectedMessage }) => {
    const registry = buildRegistry();
    expectRegistryDiagnosticContains(registry, expectedMessage);
    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]?.origin).toBe("bundled");
  });

  it("suppresses duplicate warning when candidates share the same physical directory via symlink", () => {
    const realDir = makeTempDir();
    const manifest = { id: "feishu", configSchema: { type: "object" } };
    writeManifest(realDir, manifest);

    // Create a symlink pointing to the same directory
    const symlinkParent = makeTempDir();
    const symlinkPath = path.join(symlinkParent, "feishu-link");
    try {
      fs.symlinkSync(realDir, symlinkPath, "junction");
    } catch {
      // On systems where symlinks are not supported (e.g. restricted Windows),
      // skip this test gracefully.
      return;
    }

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "feishu",
        rootDir: realDir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "feishu",
        rootDir: symlinkPath,
        origin: "bundled",
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  it("suppresses duplicate warning when candidates have identical rootDir paths", () => {
    const dir = makeTempDir();
    const manifest = { id: "same-path-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "same-path-plugin",
        rootDir: dir,
        sourceName: "a.ts",
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "same-path-plugin",
        rootDir: dir,
        sourceName: "b.ts",
        origin: "global",
      }),
    ];

    expect(countDuplicateWarnings(loadRegistry(candidates))).toBe(0);
  });

  it("does not warn for id hint mismatches when manifest id is authoritative", () => {
    const dir = makeTempDir();
    writeManifest(dir, { id: "openai", configSchema: { type: "object" } });

    const registry = loadRegistry([
      createPluginCandidate({
        idHint: "totally-different",
        rootDir: dir,
        origin: "bundled",
      }),
    ]);

    expect(hasPluginIdMismatchWarning(registry)).toBe(false);
  });

  it.each([
    {
      name: "loads Codex bundle manifests into the registry",
      idHint: "sample-bundle",
      bundleFormat: "codex" as const,
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: [".codex-plugin", "skills", "hooks"],
          manifestRelativePath: ".codex-plugin/plugin.json",
          manifest: {
            name: "Sample Bundle",
            description: "Bundle fixture",
            skills: "skills",
            hooks: "hooks",
          },
        });
      },
      expected: {
        id: "sample-bundle",
        format: "bundle",
        bundleFormat: "codex",
        hooks: ["hooks"],
        skills: ["skills"],
        bundleCapabilities: expect.arrayContaining(["hooks", "skills"]),
      },
    },
    {
      name: "loads Claude bundle manifests with command roots and settings files",
      idHint: "claude-sample",
      bundleFormat: "claude" as const,
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: [".claude-plugin", "skill-packs/starter", "commands-pack"],
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
          manifestRelativePath: ".claude-plugin/plugin.json",
          manifest: {
            name: "Claude Sample",
            skills: ["skill-packs/starter"],
            commands: "commands-pack",
          },
        });
      },
      expected: {
        id: "claude-sample",
        format: "bundle",
        bundleFormat: "claude",
        skills: ["skill-packs/starter", "commands-pack"],
        settingsFiles: ["settings.json"],
        bundleCapabilities: expect.arrayContaining(["skills", "commands", "settings"]),
      },
    },
    {
      name: "loads manifestless Claude bundles into the registry",
      idHint: "manifestless-claude",
      bundleFormat: "claude" as const,
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: ["commands"],
          textFiles: {
            "settings.json": '{"hideThinkingBlock":true}',
          },
        });
      },
      expected: {
        format: "bundle",
        bundleFormat: "claude",
        skills: ["commands"],
        settingsFiles: ["settings.json"],
        bundleCapabilities: expect.arrayContaining(["skills", "commands", "settings"]),
      },
    },
    {
      name: "loads Cursor bundle manifests into the registry",
      idHint: "cursor-sample",
      bundleFormat: "cursor" as const,
      setup: (bundleDir: string) => {
        setupBundleFixture({
          bundleDir,
          dirs: [".cursor-plugin", "skills", ".cursor/commands", ".cursor/rules"],
          textFiles: {
            ".cursor/hooks.json": '{"hooks":[]}',
            ".mcp.json": '{"servers":{}}',
          },
          manifestRelativePath: ".cursor-plugin/plugin.json",
          manifest: {
            name: "Cursor Sample",
            mcpServers: "./.mcp.json",
          },
        });
      },
      expected: {
        id: "cursor-sample",
        format: "bundle",
        bundleFormat: "cursor",
        skills: ["skills", ".cursor/commands"],
        bundleCapabilities: expect.arrayContaining([
          "skills",
          "commands",
          "rules",
          "hooks",
          "mcpServers",
        ]),
      },
    },
  ] as const)("$name", ({ idHint, bundleFormat, setup, expected }) => {
    const registry = loadBundleRegistry({
      idHint,
      bundleFormat,
      setup,
    });

    expect(registry.plugins).toHaveLength(1);
    expect(registry.plugins[0]).toMatchObject(expected);
  });

  it("prefers higher-precedence origins for the same physical directory (config > workspace > global > bundled)", () => {
    const dir = makeTempDir();
    mkdirSafe(path.join(dir, "sub"));
    const manifest = { id: "precedence-plugin", configSchema: { type: "object" } };
    writeManifest(dir, manifest);

    // Use a different-but-equivalent path representation without requiring symlinks.
    const altDir = path.join(dir, "sub", "..");

    const candidates: PluginCandidate[] = [
      createPluginCandidate({
        idHint: "precedence-plugin",
        rootDir: dir,
        origin: "bundled",
      }),
      createPluginCandidate({
        idHint: "precedence-plugin",
        rootDir: altDir,
        origin: "config",
      }),
    ];

    const registry = loadRegistry(candidates);
    expect(countDuplicateWarnings(registry)).toBe(0);
    expect(registry.plugins.length).toBe(1);
    expect(registry.plugins[0]?.origin).toBe("config");
  });

  it("rejects manifest paths that escape plugin root via symlink", () => {
    expectUnsafeWorkspaceManifestRejected({ id: "unsafe-symlink", mode: "symlink" });
  });

  it("rejects manifest paths that escape plugin root via hardlink", () => {
    if (process.platform === "win32") {
      return;
    }
    expectUnsafeWorkspaceManifestRejected({ id: "unsafe-hardlink", mode: "hardlink" });
  });

  it("allows bundled manifest paths that are hardlinked aliases", () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = prepareLinkedManifestFixture({ id: "bundled-hardlink", mode: "hardlink" });
    if (!fixture.linked) {
      return;
    }

    const registry = loadSingleCandidateRegistry({
      idHint: "bundled-hardlink",
      rootDir: fixture.rootDir,
      origin: "bundled",
    });
    expect(registry.plugins.some((entry) => entry.id === "bundled-hardlink")).toBe(true);
    expect(hasUnsafeManifestDiagnostic(registry)).toBe(false);
  });

  it("does not reuse cached bundled plugin roots across env changes", () => {
    const bundledA = makeTempDir();
    const bundledB = makeTempDir();
    const matrixA = createManifestPluginRoot({
      baseDir: bundledA,
      pluginId: "matrix",
      name: "Matrix A",
      relativePath: "matrix",
    });
    const matrixB = createManifestPluginRoot({
      baseDir: bundledB,
      pluginId: "matrix",
      name: "Matrix B",
      relativePath: "matrix",
    });

    const first = loadPluginManifestRegistry({
      cache: true,
      env: hermeticEnv({
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledA,
      }),
    });
    const second = loadPluginManifestRegistry({
      cache: true,
      env: hermeticEnv({
        OPENCLAW_BUNDLED_PLUGINS_DIR: bundledB,
      }),
    });

    expectCachedPluginRoot({
      first,
      second,
      pluginId: "matrix",
      firstRoot: matrixA,
      secondRoot: matrixB,
    });
  });

  it("does not reuse cached load-path manifests across env home changes", () => {
    const homeA = makeTempDir();
    const homeB = makeTempDir();
    const demoA = createManifestPluginRoot({
      baseDir: homeA,
      pluginId: "demo",
      name: "Demo A",
      relativePath: path.join("plugins", "demo"),
    });
    const demoB = createManifestPluginRoot({
      baseDir: homeB,
      pluginId: "demo",
      name: "Demo B",
      relativePath: path.join("plugins", "demo"),
    });

    const config = {
      plugins: {
        load: {
          paths: ["~/plugins/demo"],
        },
      },
    };

    const first = loadPluginManifestRegistry({
      cache: true,
      config,
      env: hermeticEnv({
        HOME: homeA,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(homeA, ".state"),
      }),
    });
    const second = loadPluginManifestRegistry({
      cache: true,
      config,
      env: hermeticEnv({
        HOME: homeB,
        OPENCLAW_HOME: undefined,
        OPENCLAW_STATE_DIR: path.join(homeB, ".state"),
      }),
    });

    expectCachedPluginRoot({
      first,
      second,
      pluginId: "demo",
      firstRoot: demoA,
      secondRoot: demoB,
    });
  });

  it("does not reuse cached manifests across host version changes", () => {
    const dir = makeTempDir();
    writeManifest(dir, { id: "synology-chat", configSchema: { type: "object" } });
    fs.writeFileSync(path.join(dir, "index.ts"), "export default {}", "utf-8");
    const candidates = [
      createPluginCandidate({
        idHint: "synology-chat",
        rootDir: dir,
        packageDir: dir,
        origin: "global",
        packageManifest: {
          install: {
            npmSpec: "@openclaw/synology-chat",
            minHostVersion: ">=2026.3.22",
          },
        },
      }),
    ];

    const olderHost = loadPluginManifestRegistry({
      cache: true,
      candidates,
      env: hermeticEnv({
        OPENCLAW_VERSION: "2026.3.21",
      }),
    });
    const newerHost = loadPluginManifestRegistry({
      cache: true,
      candidates,
      env: hermeticEnv({
        OPENCLAW_VERSION: "2026.3.22",
      }),
    });

    expect(olderHost.plugins).toEqual([]);
    expect(
      olderHost.diagnostics.some((diag) => diag.message.includes("this host is 2026.3.21")),
    ).toBe(true);
    expect(newerHost.plugins.some((plugin) => plugin.id === "synology-chat")).toBe(true);
    expect(
      newerHost.diagnostics.some((diag) => diag.message.includes("this host is 2026.3.21")),
    ).toBe(false);
  });
});
