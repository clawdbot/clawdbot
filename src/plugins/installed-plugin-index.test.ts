import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import {
  diffInstalledPluginIndexInvalidationReasons,
  loadInstalledPluginIndex,
  refreshInstalledPluginIndex,
  resolveInstalledPluginContributions,
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
  packageManifest?: OpenClawPackageManifest;
}): PluginCandidate {
  return {
    idHint: params.idHint ?? "demo",
    source: path.join(params.rootDir, "index.ts"),
    rootDir: params.rootDir,
    origin: params.origin ?? "global",
    packageName: params.packageName,
    packageVersion: params.packageVersion,
    packageDir: params.rootDir,
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
    channelEnvVars: {
      "demo-chat": ["DEMO_CHAT_TOKEN"],
    },
    activation: {
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
      generatedAt: "2026-04-25T12:00:00.000Z",
      plugins: [
        {
          pluginId: "demo",
          packageName: "@vendor/demo-plugin",
          packageVersion: "1.2.3",
          origin: "global",
          rootDir: fixture.rootDir,
          enabled: true,
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
          contributions: {
            providers: ["demo"],
            channels: ["demo-chat"],
            channelConfigs: ["demo-chat"],
            setupProviders: ["demo"],
            cliBackends: ["demo-cli", "setup-cli"],
            modelCatalogProviders: ["demo"],
            commandAliases: ["demo-command"],
            contracts: ["tools"],
          },
          compat: [
            "activation-channel-hint",
            "activation-provider-hint",
            "channel-env-vars",
            "provider-auth-env-vars",
          ],
        },
      ],
    });
    expect(index.plugins[0]?.manifestHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(index.plugins[0]?.packageJsonHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(index.plugins[0]?.packageJsonPath).toBe(path.join(fixture.rootDir, "package.json"));
    expect(index.plugins[0]?.installRecord).toBeUndefined();
    expect(index.plugins[0]?.installRecordHash).toBeUndefined();

    const contributions = resolveInstalledPluginContributions(index);
    expect(contributions.providers.get("demo")).toEqual(["demo"]);
    expect(contributions.channels.get("demo-chat")).toEqual(["demo"]);
    expect(contributions.contracts.get("tools")).toEqual(["demo"]);
  });

  it("records the config install ledger separately from package install intent", () => {
    const fixture = createRichPluginFixture();

    const index = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          installs: {
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
        },
      },
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      installRecord: {
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
      packageInstall: {
        npm: {
          spec: "@vendor/demo-plugin@1.2.3",
          expectedIntegrity: "sha512-demo",
          pinState: "exact-with-integrity",
        },
      },
    });
    expect(index.plugins[0]?.installRecordHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("indexes npm install ledger records written before a process reload", () => {
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
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "demo",
      installRecord: {
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

  it("indexes local fallback install ledger records written before a process reload", () => {
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
      env: hermeticEnv(),
    });

    expect(index.plugins[0]).toMatchObject({
      pluginId: "demo",
      installRecord: {
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
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              resolvedName: "@vendor/demo-plugin",
              resolvedVersion: "1.2.3",
              resolvedSpec: "@vendor/demo-plugin@1.2.3",
              integrity: "sha512-installed",
            },
          },
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

  it("treats install ledger changes as source invalidation", () => {
    const fixture = createRichPluginFixture();
    const previous = loadInstalledPluginIndex({
      candidates: [fixture.candidate],
      config: {
        plugins: {
          installs: {
            demo: {
              source: "npm",
              resolvedName: "@vendor/demo-plugin",
              resolvedVersion: "1.2.3",
              resolvedSpec: "@vendor/demo-plugin@1.2.3",
              integrity: "sha512-old",
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
          installs: {
            demo: {
              source: "npm",
              resolvedName: "@vendor/demo-plugin",
              resolvedVersion: "1.2.3",
              resolvedSpec: "@vendor/demo-plugin@1.2.3",
              integrity: "sha512-new",
            },
          },
        },
      },
      env: hermeticEnv(),
    });

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toEqual([
      "source-changed",
    ]);
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

    expect(index.plugins[0]?.enabled).toBe(false);
    expect(index.plugins[0]?.contributions.providers).toEqual(["demo"]);
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

  it("diffs invalidation reasons for manifest, package, source, host, and compat changes", () => {
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
        config: {
          plugins: {
            installs: {
              demo: {
                source: "npm",
                resolvedVersion: "1.2.4",
              },
            },
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
