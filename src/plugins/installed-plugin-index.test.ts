import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCandidate } from "./discovery.js";
import { buildInstalledPluginIndexRecords } from "./installed-plugin-index-record-builder.js";
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
import type { PluginManifestRecord } from "./manifest-registry.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function readRecordField(record: Record<string, unknown>, key: string, label: string) {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function expectRecordFields(record: Record<string, unknown>, fields: Record<string, unknown>) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectSha256(value: unknown) {
  expect(typeof value).toBe("string");
  expect(value).toMatch(/^[a-f0-9]{64}$/u);
}

function writeManifestlessClaudeBundle(rootDir: string, entries: readonly string[] = ["skills"]) {
  for (const entry of entries) {
    fs.mkdirSync(path.join(rootDir, entry), { recursive: true });
    fs.writeFileSync(path.join(rootDir, entry, "README.md"), `# ${entry}\n`, "utf-8");
  }
}

function hermeticEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
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

function createRichPluginFixture(params: { id?: string; packageVersion?: string } = {}) {
  const rootDir = makeTempDir();
  const id = params.id ?? "demo";
  writeRuntimeEntry(rootDir);
  writePackageJson(rootDir, {
    name: `@vendor/${id}`,
    version: params.packageVersion ?? "1.2.3",
  });
  writePluginManifest(rootDir, {
    id,
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

    expectRecordFields(index as unknown as Record<string, unknown>, {
      version: 1,
      migrationVersion: 1,
      generatedAtMs: 1777118400000,
    });
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "demo",
      packageName: "@vendor/demo-plugin",
      packageVersion: "1.2.3",
      origin: "global",
      rootDir: fixture.rootDir,
      source: path.join(fixture.rootDir, "index.ts"),
      enabled: true,
      syntheticAuthRefs: ["demo", "demo-cli"],
      compat: [
        "activation-agent-harness-hint",
        "activation-channel-hint",
        "activation-provider-hint",
        "channel-env-vars",
        "provider-auth-env-vars",
      ],
    });
    expectRecordFields(readRecordField(plugin, "packageInstall", "package install"), {
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
    });
    expectRecordFields(readRecordField(plugin, "packageChannel", "package channel"), {
      id: "demo",
      label: "Demo",
      blurb: "Demo channel",
      preferOver: ["legacy-demo"],
      commands: {
        nativeCommandsAutoEnabled: true,
        nativeSkillsAutoEnabled: false,
      },
    });
    expectSha256(plugin.manifestHash);
    const packageJson = requireRecord(index.plugins[0]?.packageJson, "package json");
    expectRecordFields(packageJson, {
      path: "package.json",
    });
    expectSha256(packageJson.hash);
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

    expectRecordFields(requireRecord(index.plugins[0], "installed plugin record"), {
      pluginId: "migration-plugin",
      enabledByDefault: true,
    });
    expect(index.plugins[0]?.startup.sidecar).toBe(false);
  });

  it("does not classify legacy plugins as startup sidecars", () => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    writePluginManifest(rootDir, {
      id: "legacy-sidecar",
      configSchema: { type: "object" },
    });

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
        }),
      ],
      env: hermeticEnv(),
    });

    expectRecordFields(requireRecord(index.plugins[0], "installed plugin record"), {
      pluginId: "legacy-sidecar",
      compat: [],
    });
    expect(index.plugins[0]?.startup.sidecar).toBe(false);
  });

  it("tolerates stale manifest records without normalized channels", () => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");

    const records = buildInstalledPluginIndexRecords({
      candidates: [createPluginCandidate({ rootDir })],
      registry: {
        plugins: [
          {
            id: "stale-record",
            providers: [],
            cliBackends: [],
            skills: [],
            hooks: [],
            origin: "global",
            rootDir,
            source: path.join(rootDir, "index.ts"),
            manifestPath,
          } as unknown as PluginManifestRecord,
        ],
        diagnostics: [],
      },
      diagnostics: [],
      installRecords: {},
    });

    expectRecordFields(requireRecord(records[0], "installed plugin record"), {
      pluginId: "stale-record",
      compat: [],
    });
    expect(records[0]?.startup.sidecar).toBe(false);
  });

  it("indexes manifestless Claude bundles without missing-manifest diagnostics", () => {
    const rootDir = path.join(makeTempDir(), "workspace");
    writeManifestlessClaudeBundle(rootDir);

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
          idHint: "workspace",
          format: "bundle",
          bundleFormat: "claude",
          origin: "config",
        }),
      ],
      env: hermeticEnv(),
    });

    expect(index.diagnostics).toStrictEqual([]);
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "workspace",
      manifestPath: path.join(rootDir, ".claude-plugin", "plugin.json"),
      source: rootDir,
      format: "bundle",
      bundleFormat: "claude",
    });
    expectSha256(plugin.manifestHash);
  });

  it("changes manifestless Claude bundle hashes when derived metadata changes", () => {
    const rootDir = path.join(makeTempDir(), "workspace");
    writeManifestlessClaudeBundle(rootDir, ["skills"]);

    const first = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
          idHint: "workspace",
          format: "bundle",
          bundleFormat: "claude",
          origin: "config",
        }),
      ],
      env: hermeticEnv(),
    });

    writeManifestlessClaudeBundle(rootDir, ["commands"]);
    const second = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
          idHint: "workspace",
          format: "bundle",
          bundleFormat: "claude",
          origin: "config",
        }),
      ],
      env: hermeticEnv(),
    });

    expect(second.plugins[0]?.manifestHash).not.toBe(first.plugins[0]?.manifestHash);
  });

  it("keeps explicit startup opt-outs out of startup sidecars", () => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    writePluginManifest(rootDir, {
      id: "modern-inert",
      activation: {
        onStartup: false,
      },
      configSchema: { type: "object" },
    });

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
        }),
      ],
      env: hermeticEnv(),
    });

    expectRecordFields(requireRecord(index.plugins[0], "installed plugin record"), {
      pluginId: "modern-inert",
      compat: [],
    });
    expect(index.plugins[0]?.startup.sidecar).toBe(false);
  });

  it("classifies explicit startup activation as a gateway startup sidecar", () => {
    const rootDir = makeTempDir();
    writeRuntimeEntry(rootDir);
    writePluginManifest(rootDir, {
      id: "explicit-startup-provider",
      providers: ["demo"],
      activation: {
        onStartup: true,
      },
      configSchema: { type: "object" },
    });

    const index = loadInstalledPluginIndex({
      candidates: [
        createPluginCandidate({
          rootDir,
        }),
      ],
      env: hermeticEnv(),
    });

    expectRecordFields(requireRecord(index.plugins[0], "installed plugin record"), {
      pluginId: "explicit-startup-provider",
    });
    expect(index.plugins[0]?.startup.sidecar).toBe(true);
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

    expectRecordFields(requireRecord(index.plugins[0], "installed plugin record"), {
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

    expect(index.plugins[0]?.packageJson?.path).toBe("package.json");
  });

  it.runIf(process.platform !== "win32")(
    "does not record packageJson metadata from symlinks outside the plugin root",
    () => {
      const fixture = createRichPluginFixture();
      const outsideDir = makeTempDir();
      const packageJsonPath = path.join(fixture.rootDir, "package.json");
      const outsidePackageJsonPath = path.join(outsideDir, "package.json");
      fs.rmSync(packageJsonPath);
      fs.writeFileSync(
        outsidePackageJsonPath,
        JSON.stringify({ name: "@vendor/outside-plugin", version: "9.9.9" }),
        "utf8",
      );
      fs.symlinkSync(outsidePackageJsonPath, packageJsonPath);

      const index = loadInstalledPluginIndex({
        candidates: [fixture.candidate],
        env: hermeticEnv(),
      });

      expect(index.plugins[0]?.packageJson).toBeUndefined();
    },
  );

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
    expectRecordFields(requireRecord(record, "installed plugin record"), {
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
    expect(listEnabledInstalledPluginRecords(index, config)).toStrictEqual([]);
    expectRecordFields(
      requireRecord(getInstalledPluginRecord(index, "demo"), "installed plugin record"),
      {
        pluginId: "demo",
        enabled: false,
      },
    );
    expect(isInstalledPluginEnabled(index, "demo", config)).toBe(false);
  });

  it("keeps an index-disabled plugin disabled when config only enables another plugin", () => {
    const enabledFixture = createRichPluginFixture({ id: "enabled-demo" });
    const disabledFixture = createRichPluginFixture({ id: "disabled-demo" });
    const index = loadInstalledPluginIndex({
      candidates: [enabledFixture.candidate, disabledFixture.candidate],
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

    expect(index.plugins.find((plugin) => plugin.pluginId === "disabled-demo")?.enabled).toBe(
      false,
    );
    expect(
      isInstalledPluginEnabled(index, "disabled-demo", {
        plugins: {
          entries: {
            "enabled-demo": {
              enabled: true,
            },
          },
        },
      }),
    ).toBe(false);
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

    expectRecordFields(requireRecord(index.plugins[0], "installed plugin record"), {
      pluginId: "openai",
      enabled: false,
    });
    expect(listEnabledInstalledPluginRecords(index, config)).toStrictEqual([]);
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

    expect(index.installRecords).toEqual({
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
    expectRecordFields(
      readRecordField(
        readRecordField(
          requireRecord(index.plugins[0], "installed plugin record"),
          "packageInstall",
          "package install",
        ),
        "npm",
        "npm package install",
      ),
      {
        spec: "@vendor/demo-plugin@1.2.3",
        expectedIntegrity: "sha512-demo",
        pinState: "exact-with-integrity",
      },
    );
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

    expect(index.installRecords).toEqual({
      "duplicate-demo": {
        source: "npm",
        installPath: globalDir,
      },
    });
    expect(index.plugins).toHaveLength(1);
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "duplicate-demo",
      origin: "global",
      rootDir: globalDir,
    });
    expectSha256(plugin.installRecordHash);
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

    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "demo",
    });
    expectSha256(plugin.installRecordHash);
    expect(index.installRecords).toEqual({
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

    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "demo",
    });
    expectSha256(plugin.installRecordHash);
    expect(index.installRecords).toEqual({
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

  it("discovers installed plugin packages from persisted install records", async () => {
    const fixture = createRichPluginFixture();
    const stateDir = makeTempDir();
    await writePersistedInstalledPluginIndexInstallRecords(
      {
        demo: {
          source: "git",
          spec: "git:file:///tmp/demo.git@abc123",
          installPath: fixture.rootDir,
          gitUrl: "file:///tmp/demo.git",
          gitCommit: "abc123",
        },
      },
      { stateDir },
    );

    const index = loadInstalledPluginIndex({
      env: hermeticEnv({
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: stateDir,
      }),
    });

    expect(index.plugins).toHaveLength(1);
    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "demo",
      origin: "global",
      rootDir: fs.realpathSync.native(fixture.rootDir),
    });
    expectSha256(plugin.installRecordHash);
    expect(index.installRecords).toEqual({
      demo: {
        source: "git",
        spec: "git:file:///tmp/demo.git@abc123",
        installPath: fixture.rootDir,
        gitUrl: "file:///tmp/demo.git",
        gitCommit: "abc123",
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

    const plugin = requireRecord(index.plugins[0], "installed plugin record");
    expectRecordFields(plugin, {
      pluginId: "demo",
    });
    expectSha256(plugin.installRecordHash);
    expect(index.installRecords).toEqual({
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

    expect(diffInstalledPluginIndexInvalidationReasons(previous, current)).toStrictEqual([]);
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

    expect(diffInstalledPluginIndexInvalidationReasons(migratedEnabledOnly, current)).toStrictEqual(
      [],
    );
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
