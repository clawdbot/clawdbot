import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  loadInstalledPluginIndexInstallRecordsSync,
  writePersistedInstalledPluginIndexInstallRecords,
} from "./installed-plugin-index-records.js";
import {
  diffInstalledPluginIndexInvalidationReasons,
  getInstalledPluginRecord,
  isInstalledPluginEnabled,
  listEnabledInstalledPluginRecords,
  listInstalledPluginRecords,
  loadInstalledPluginIndex,
  refreshInstalledPluginIndex,
} from "./installed-plugin-index.js";
import { recordPluginInstall } from "./installs.js";
import type { OpenClawPackageManifest } from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

vi.unmock("../version.js");

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-installed-plugin-index", tempDirs);
}

function writePluginManifest(rootDir: string, manifest: Record<string, unknown>) {
  fs.writeFileSync(path.join(rootDir, "openclaw.plugin.json"), JSON.stringify(manifest), "utf-8");
}

function writePackageJson(rootDir: string, packageJson: Record<string, unknown>) {
  fs.writeFileSync(path.join(rootDir, "package.json"), JSON.stringify(packageJson), "utf-8");
}

function writeRuntimeEntry(rootDir: string) {
  fs.writeFileSync(
    path.join(rootDir, "index.ts"),
    "throw new Error('runtime entry should not load while building installed plugin index');\n",
    "utf-8",
  );
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    OPENCLAW_VERSION: "2026.4.25",
    VITEST: "true",
    ...overrides,
  };
}

function createPluginCandidate(params: {
  rootDir: string;
  idHint?: string;
  origin?: PluginCandidate["origin"];
  packageName?: string;
  packageVersion?: string;
  packageDir?: string;
  packageManifest?: OpenClawPackageManifest;
  format?: PluginCandidate["format"];
  bundleFormat?: PluginCandidate["bundleFormat"];
}): PluginCandidate {
  return {
    idHint: params.idHint ?? "demo",
    source: params.format === "bundle" ? params.rootDir : path.join(params.rootDir, "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin ?? "global",
    format: params.format,
    bundleFormat: params.bundleFormat,
    packageName: params.packageName,
    packageVersion: params.packageVersion,
    packageDir: params.packageDir ?? params.rootDir,
    packageManifest: params.packageManifest,
  };
}

function createRichPluginFixture(params: { packageVersion?: string } = {}) {
  const rootDir = makeTempDir();
  writeRuntimeEntry(rootDir);
  writePackageJson(rootDir, {
    name: "@vendor/demo-plugin",
    version: params.packageVersion ?? "1.2.3",
  });
  writePluginManifest(rootDir, {
    id: "demo",
    name: "Demo",
    configSchema: { type: "object" },
    providers: ["demo"],
    channels: ["demo-chat"],
    cliBackends: ["demo-cli"],
    channelConfigs: {
      "demo-chat": {
        schema: { type: "object" },
      },
    },
    modelCatalog: {
      providers: {
        demo: {
          models: [{ id: "demo-model" }],
        },
      },
      discovery: {
        demo: "static",
      },
    },
    setup: {
      providers: [{ id: "demo", envVars: ["DEMO_API_KEY"] }],
      cliBackends: ["setup-cli"],
    },
    commandAliases: [{ name: "demo-command" }],
    contracts: {
      tools: ["demo-tool"],
    },
    providerAuthEnvVars: {
      demo: ["DEMO_API_KEY"],
    },
    syntheticAuthRefs: ["demo", "demo-cli"],
    channelEnvVars: {
      "demo-chat": ["DEMO_CHAT_TOKEN"],
    },
    activation: {
      onAgentHarnesses: ["codex"],
      onProviders: ["demo"],
      onChannels: ["demo-chat"],
    },
  });
  return {
    rootDir,
    candidate: createPluginCandidate({
      rootDir,
      packageName: "@vendor/demo-plugin",
      packageVersion: params.packageVersion ?? "1.2.3",
      packageManifest: {
        channel: {
          id: "demo",
          label: "Demo",
          blurb: "Demo channel",
          preferOver: ["legacy-demo"],
          commands: {
            nativeCommandsAutoEnabled: true,
            nativeSkillsAutoEnabled: false,
          },
        },
        install: {
          npmSpec: "@vendor/demo-plugin@1.2.3",
          expectedIntegrity: "sha512-demo",
          defaultChoice: "npm",
        },
      },
    }),
  };
}

describe("installed plugin index", () => {
  it("builds a runtime-free installed plugin snapshot from manifest and package metadata", () => {
    const fixture = createRichPluginFixture();

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      env: hermeticEnv(),
      now: () => new Date("2026-04-25T12:00:00.000Z"),
    });

    expect(index).toMatchObject({
      version: 1,
      migrationVersion: 1,
      generatedAtMs: 1777118400000,
      plugins: [
        {
          pluginId: "demo",
          packageName: "@vendor/demo-plugin",
          packageVersion: "1.2.3",
          origin: "global",
          rootDir: fixture.rootDir,
          source: path.join(fixture.rootDir, "index.ts"),
          enabled: true,
          syntheticAuthRefs: ["demo", "demo-cli"],
          packageInstall: {
            defaultChoice: "npm",
            npm: {
              spec: "@vendor/demo-plugin@1.2.3",
              packageName: "@vendor/demo-plugin",
              selector: "1.2.3",
              selectorKind: "exact-version",
              exactVersion: true,
              expectedIntegrity: "sha512-demo",
              pinState: "exact-with-integrity",
            },
            warnings: [],
          },
          packageChannel: {
            id: "demo",
            label: "Demo",
            blurb: "Demo channel",
            preferOver: ["legacy-demo"],
            commands: {
              nativeCommandsAutoEnabled: true,
              nativeSkillsAutoEnabled: false,
            },
          },
          compat: [
            "activation-agent-harness-hint",
            "activation-channel-hint",
            "activation-provider-hint",
            "channel-env-vars",
            "provider-auth-env-vars",
          ],
        },
      ],
    });
    expect(index.plugins[0]?.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(index.plugins[0]?.packageJson).toMatchObject({
      path: "package.json",
      hash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(index.plugins[0]?.installRecord).toBeUndefined();
    expect(index.plugins[0]?.installRecordHash).toBeUndefined();
  });

  it("does not classify migration-provider-only plugins as gateway startup sidecars", () => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    writePackageJson(rootDir, {
      name: "@vendor/migration-plugin",
      version: "1.0.0",
    });
    writePluginManifest(rootDir, {
      id: "migration-plugin",
      name: "Migration Plugin",
      enabledByDefault: true,
      configSchema: { type: "object" },
      contracts: {
        migrationProviders: ["legacy-import"],
      },
    });

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
          packageName: "@vendor/migration-plugin",
          packageVersion: "1.0.0",
        }),
      ],
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "migration-plugin",
      enabledByDefault: true,
      startup: {
        sidecar: false,
      },
    });
  });

  it("keeps bundle format metadata needed for manifest reconstruction", () => {
    const rootDir = makeTempDir();
    fs.mkdirSync(path.join(rootDir, ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "commands"), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, ".claude-plugin", "plugin.json"),
      JSON.stringify({
        name: "Claude Bundle",
        commands: "commands",
      }),
      "utf8",
    );

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
          idHint: "claude-bundle",
          format: "bundle",
          bundleFormat: "claude",
        }),
      ],
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "claude-bundle",
      format: "bundle",
      bundleFormat: "claude",
      source: rootDir,
    });
  });

  it("keeps packageJson paths root-relative when packageDir is reached through a symlink", () => {
    const fixture = createRichPluginFixture();
    const linkParent = makeTempDir();
    const linkRoot = path.join(linkParent, "linked-demo");
    try {
      fs.symlinkSync(fixture.rootDir, linkRoot, "dir");
    } catch {
      return;
    }

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir: fs.realpathSync(fixture.rootDir),
          packageDir: linkRoot,
          packageName: "@vendor/demo-plugin",
          packageVersion: "1.2.3",
        }),
      ],
      env: hermeticEnv(),
    });

    expect(index.plugins[0]?.packageJson).toMatchObject({
      path: "package.json",
    });
  });

  it("exposes cold registry records for existing plugins without plugin runtimes", () => {
    const fixture = createRichPluginFixture();
    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      env: hermeticEnv(),
    });

    expect(listInstalledPluginRecords(index).map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    expect(listEnabledInstalledPluginRecords(index).map((plugin) => plugin.pluginId)).toEqual([
      "demo",
    ]);
    const record = getInstalledPluginRecord(index, "demo");
    expect(record).toMatchObject({
      pluginId: "demo",
      enabled: true,
    });
    expect(record?.installRecord).toBeUndefined();
    expect(isInstalledPluginEnabled(index, "demo")).toBe(true);
  });

  it("keeps disabled plugins in inventory while excluding them from cold owner resolution", () => {
    const fixture = createRichPluginFixture();
    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
    });

    expect(listInstalledPluginRecords(index).map((plugin) => plugin.pluginId)).toEqual(["demo"]);
    const config = {
      plugins: {
        entries: {
          demo: {
            enabled: false,
          },
        },
      },
    };
    expect(listEnabledInstalledPluginRecords(index, config)).toEqual([]);
    expect(getInstalledPluginRecord(index, "demo")).toMatchObject({
      pluginId: "demo",
      enabled: false,
    });
    expect(isInstalledPluginEnabled(index, "demo", config)).toBe(false);
  });

  it("uses runtime plugin id normalization for legacy enablement aliases", () => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    writePluginManifest(rootDir, {
      id: "openai",
      configSchema: { type: "object" },
      providers: ["openai"],
    });

    const config = {
      plugins: {
        entries: {
          "openai-codex": {
            enabled: false,
          },
        },
      },
    };
    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
          idHint: "openai",
          origin: "bundled",
        }),
      ],
      config,
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "openai",
      enabled: false,
    });
    expect(listEnabledInstalledPluginRecords(index, config)).toEqual([]);
  });

  it("records explicit install records separately from package install intent", () => {
    const fixture = createRichPluginFixture();

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      installRecords: {
        demo: {
          source: "npm",
          spec: "@vendor/demo-plugin@latest",
          installPath: "plugins/demo",
          resolvedName: "@vendor/demo-plugin",
          resolvedVersion: "1.2.3",
          resolvedSpec: "@vendor/demo-plugin@1.2.3",
          integrity: "sha512-installed",
          shasum: "abc123",
          resolvedAt: "2026-04-25T11:00:00.000Z",
          installedAt: "2026-04-25T11:01:00.000Z",
        },
      },
      env: hermeticEnv(),
    });

    expect(index.installRecords).toMatchObject({
      demo: {
        source: "npm",
        spec: "@vendor/demo-plugin@latest",
        installPath: "plugins/demo",
        resolvedName: "@vendor/demo-plugin",
        resolvedVersion: "1.2.3",
        resolvedSpec: "@vendor/demo-plugin@1.2.3",
        integrity: "sha512-installed",
        shasum: "abc123",
        resolvedAt: "2026-04-25T11:00:00.000Z",
        installedAt: "2026-04-25T11:01:00.000Z",
      },
    });
    expect(index.plugins[0]).toMatchObject({
      packageInstall: {
        npm: {
          spec: "@vendor/demo-plugin@1.2.3",
          expectedIntegrity: "sha512-demo",
          pinState: "exact-with-integrity",
        },
      },
    });
    expect(index.plugins[0]?.installRecord).toBeUndefined();
    expect(index.plugins[0]?.installRecordHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("uses in-flight install records to rank installed globals over bundled duplicates", () => {
    const bundledDir = makeTempDir();
    const globalDir = makeTempDir();
    writeRuntimeEntry(bundledDir);
    writeRuntimeEntry(globalDir);
    writePluginManifest(bundledDir, {
      id: "duplicate-demo",
      configSchema: { type: "object" },
    });
    writePluginManifest(globalDir, {
      id: "duplicate-demo",
      configSchema: { type: "object" },
    });

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir: bundledDir,
          idHint: "duplicate-demo",
          origin: "bundled",
        }),
        createPluginCandidate({
          rootDir: globalDir,
          idHint: "duplicate-demo",
          origin: "global",
        }),
      ],
      installRecords: {
        "duplicate-demo": {
          source: "npm",
          installPath: globalDir,
        },
      },
      env: hermeticEnv(),
    });

    expect(index.installRecords).toMatchObject({
      "duplicate-demo": {
        source: "npm",
        installPath: globalDir,
      },
    });
    expect(index.plugins).toHaveLength(1);
    expect(index.plugins[0]).toMatchObject({
      pluginId: "duplicate-demo",
      origin: "global",
      rootDir: globalDir,
      installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
  });

  it("indexes npm plugin index records written before a process reload", () => {
    const fixture = createRichPluginFixture();
    const cfg = recordPluginInstall(
      {},
      {
        pluginId: "demo",
        source: "npm",
        spec: "@vendor/demo-plugin@latest",
        installPath: fixture.rootDir,
        version: "1.2.3",
        resolvedName: "@vendor/demo-plugin",
        resolvedVersion: "1.2.3",
        resolvedSpec: "@vendor/demo-plugin@1.2.3",
        integrity: "sha512-installed",
        shasum: "abc123",
        resolvedAt: "2026-04-25T11:00:00.000Z",
        installedAt: "2026-04-25T11:01:00.000Z",
      },
    );

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: cfg,
      installRecords: cfg.plugins?.installs,
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "demo",
      installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(index.installRecords).toMatchObject({
      demo: {
        source: "npm",
        spec: "@vendor/demo-plugin@latest",
        installPath: fixture.rootDir,
        version: "1.2.3",
        resolvedName: "@vendor/demo-plugin",
        resolvedVersion: "1.2.3",
        resolvedSpec: "@vendor/demo-plugin@1.2.3",
        integrity: "sha512-installed",
        shasum: "abc123",
        resolvedAt: "2026-04-25T11:00:00.000Z",
        installedAt: "2026-04-25T11:01:00.000Z",
      },
    });
  });

  it("indexes persisted plugin index records from an explicit state directory", async () => {
    const fixture = createRichPluginFixture();
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        demo: {
          source: "npm",
          spec: "@vendor/demo-plugin@1.2.3",
          installPath: fixture.rootDir,
          resolvedName: "@vendor/demo-plugin",
          resolvedVersion: "1.2.3",
          integrity: "sha512-installed",
        },
      },
      { stateDir, candidates: [fixture.candidate] },
    );

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      env: hermeticEnv(),
      stateDir,
      installRecords: loadInstalledPluginIndexInstallRecordsSync({ stateDir }),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "demo",
      installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(index.installRecords).toMatchObject({
      demo: {
        source: "npm",
        spec: "@vendor/demo-plugin@1.2.3",
        installPath: fixture.rootDir,
        resolvedName: "@vendor/demo-plugin",
        resolvedVersion: "1.2.3",
        integrity: "sha512-installed",
      },
    });
  });

  it("indexes local fallback plugin index records written before a process reload", () => {
    const fixture = createRichPluginFixture();
    const cfg = recordPluginInstall(
      {},
      {
        pluginId: "demo",
        source: "path",
        sourcePath: "./plugins/demo",
        spec: "@vendor/demo-plugin@1.2.3",
        installedAt: "2026-04-25T11:01:00.000Z",
      },
    );

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: cfg,
      installRecords: cfg.plugins?.installs,
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "demo",
      installRecordHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(index.installRecords).toMatchObject({
      demo: {
        source: "path",
        sourcePath: "./plugins/demo",
        spec: "@vendor/demo-plugin@1.2.3",
        installedAt: "2026-04-25T11:01:00.000Z",
      },
    });
  });

  it("does not treat package install intent as source invalidation", () => {
    const fixture = createRichPluginFixture();
    const previous = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      installRecords: {
        demo: {
          source: "npm",
          resolvedName: "@vendor/demo-plugin",
          resolvedVersion: "1.2.3",
          resolvedSpec: "@vendor/demo-plugin@1.2.3",
          integrity: "sha512-installed",
        },
      },
      env: hermeticEnv(),
    });
    const current = {
      ...previous,
      plugins: previous.plugins.map((plugin) => ({
        ...plugin,
        packageInstall: {
          ...plugin.packageInstall,
          warnings: ["npm-spec-missing-integrity" as const],
        },
      })),
    };

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toEqual([]);
  });

  it("treats plugin index changes as source invalidation", () => {
    const fixture = createRichPluginFixture();
    const previous = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      installRecords: {
        demo: {
          source: "npm",
          resolvedName: "@vendor/demo-plugin",
          resolvedVersion: "1.2.3",
          resolvedSpec: "@vendor/demo-plugin@1.2.3",
          integrity: "sha512-old",
        },
      },
      env: hermeticEnv(),
    });
    const current = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      installRecords: {
        demo: {
          source: "npm",
          resolvedName: "@vendor/demo-plugin",
          resolvedVersion: "1.2.3",
          resolvedSpec: "@vendor/demo-plugin@1.2.3",
          integrity: "sha512-new",
        },
      },
      env: hermeticEnv(),
    });

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toEqual([
      "source-changed",
    ]);
  });

  it("treats enablement changes as policy invalidation", () => {
    const fixture = createRichPluginFixture();
    const previous = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: true,
            },
          },
        },
      },
      env: hermeticEnv(),
    });
    const current = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
    });

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toEqual([
      "policy-changed",
    ]);
  });

  it("does not mark enabled-only migration snapshots stale for omitted disabled plugins", () => {
    const enabledFixture = createRichPluginFixture();
    const disabledFixture = createRichPluginFixture();
    writePluginManifest(disabledFixture.rootDir, {
      id: "disabled-demo",
      name: "Disabled Demo",
      configSchema: { type: "object" },
      providers: ["disabled-demo"],
    });
    const current = loadInstalledPluginIndex({
      candidates: [
        enabledFixture.candidate,
        {
          ...disabledFixture.candidate,
          idHint: "disabled-demo",
        },
      ],
      config: {
        plugins: {
          entries: {
            "disabled-demo": {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
    });
    const migratedEnabledOnly = {
      ...current,
      refreshReason: "migration" as const,
      plugins: current.plugins.filter((plugin) => plugin.enabled),
    };

    expect(diffInstalledPluginIndexInvalidationReasons(migratedEnabledOnly, current)).toEqual([]);
  });

  it("marks disabled plugins without dropping their cold contributions", () => {
    const fixture = createRichPluginFixture();

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      },
      env: hermeticEnv(),
    });

    expect(
      isInstalledPluginEnabled(index, "demo", {
        plugins: {
          entries: {
            demo: {
              enabled: false,
            },
          },
        },
      }),
    ).toBe(false);
    expect(index.plugins[0]?.enabled).toBe(false);
  });

  it("tracks refresh reason without using the manifest cache", () => {
    const fixture = createRichPluginFixture();

    const index = refreshInstalledPluginIndex({
      reason: "manual",
      candidates: [fixture.candidate],
      env: hermeticEnv(),
    });

    expect(index.refreshReason).toBe("manual");
  });

  it("diffs invalidation reasons for manifest, package, source, host, compat, and migration changes", () => {
    const fixture = createRichPluginFixture();
    const previous = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              resolvedVersion: "1.2.3",
            },
          },
        },
      },
      env: hermeticEnv({ OPENCLAW_VERSION: "2026.4.25" }),
    });

    writePackageJson(fixture.rootDir, {
      name: "@vendor/demo-plugin",
      version: "1.2.4",
    });
    writePluginManifest(fixture.rootDir, {
      id: "demo",
      configSchema: { type: "object" },
      providers: ["demo", "demo-next"],
    });
    const current = {
      ...loadInstalledPluginIndex({
        candidates: [
          {
            ...fixture.candidate,
            packageVersion: "1.2.4",
          },
        ],
        installRecords: {
          demo: {
            source: "npm",
            resolvedVersion: "1.2.4",
          },
        },
        env: hermeticEnv({ OPENCLAW_VERSION: "2026.4.26" }),
      }),
      compatRegistryVersion: "different-compat-registry",
    };

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toEqual([
      "compat-registry-changed",
      "host-contract-changed",
      "source-changed",
      "stale-manifest",
      "stale-package",
    ]);

    const moved = {
      ...current,
      plugins: current.plugins.map((plugin) => ({
        ...plugin,
        rootDir: path.join(plugin.rootDir, "moved"),
      })),
    };
    expect(diffInstalledPluginIndexInvalidationReasons(current, moved)).toContain("source-changed");
  });
});
