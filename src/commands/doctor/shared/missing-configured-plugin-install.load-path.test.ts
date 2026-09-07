import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecords,
} from "../../../plugins/installed-plugin-index-records.js";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  configuredPluginInstallIssueToRepairEffect,
  detectConfiguredPluginInstallHealthIssues,
  repairMissingConfiguredPluginInstalls,
} from "./missing-configured-plugin-install.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
});

function writeProviderPlugin(rootDir: string): void {
  fs.mkdirSync(path.join(rootDir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(rootDir, "dist", "index.js"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/kilocode-provider",
      version: "2026.7.1",
      openclaw: {
        extensions: ["./index.ts"],
        runtimeExtensions: ["./dist/index.js"],
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "kilocode",
      enabledByDefault: true,
      providers: ["kilocode"],
      configSchema: { type: "object", properties: {} },
    }),
    "utf8",
  );
}

async function writePathInstallRecord(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  pluginId: string;
  installPath: string;
  sourcePath?: string;
}): Promise<void> {
  await writePersistedInstalledPluginIndexInstallRecords(
    {
      [params.pluginId]: {
        source: "path",
        sourcePath: params.sourcePath ?? params.installPath,
        installPath: params.installPath,
      },
    },
    { config: params.cfg, env: params.env },
  );
}

async function createConfiguredCodexBundleFixture(
  manifestState: "valid" | "absent" | "malformed",
): Promise<{ cfg: OpenClawConfig; env: NodeJS.ProcessEnv; pluginDir: string }> {
  const rootDir = tempDirs.make(`openclaw-codex-${manifestState}-`);
  const pluginDir = path.join(rootDir, "gmail");
  fs.mkdirSync(path.join(pluginDir, ".codex-plugin"), { recursive: true });
  if (manifestState !== "absent") {
    fs.writeFileSync(
      path.join(pluginDir, ".codex-plugin", "plugin.json"),
      manifestState === "valid"
        ? JSON.stringify({ name: "gmail", apps: "./.app.json" })
        : "{not-json",
      "utf8",
    );
  }
  fs.writeFileSync(
    path.join(pluginDir, ".app.json"),
    JSON.stringify({ apps: { gmail: { id: "connector_test" } } }),
    "utf8",
  );
  const cfg: OpenClawConfig = {
    plugins: {
      load: { paths: [pluginDir] },
      entries: { gmail: { enabled: true } },
    },
  };
  const env = {
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
    VITEST: "true",
  };
  await writePathInstallRecord({ cfg, env, pluginId: "gmail", installPath: pluginDir });
  return { cfg, env, pluginDir };
}

function writeBundledOpenCodeGoPlugin(bundledPluginsDir: string): void {
  const pluginDir = path.join(bundledPluginsDir, "opencode-go");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/opencode-go-provider",
      version: "2026.8.1",
      openclaw: {
        extensions: ["./index.js"],
        install: {
          clawhubSpec: "clawhub:@openclaw/opencode-go-provider",
          npmSpec: "@openclaw/opencode-go-provider",
          defaultChoice: "npm",
        },
        build: { openclawVersion: "2026.8.1" },
        release: { publishToClawHub: true, publishToNpm: true },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "opencode-go",
      activation: { onStartup: false },
      enabledByDefault: true,
      providers: ["opencode-go"],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
}

describe("configured plugin install health for explicit load paths", () => {
  it("persists removal of a stale path record shadowed by a configured plugin", async () => {
    const rootDir = tempDirs.make("openclaw-stale-path-record-");
    const pluginDir = path.join(rootDir, "configured-plugin");
    const stalePath = path.join(rootDir, "removed-plugin");
    writeProviderPlugin(pluginDir);
    const cfg: OpenClawConfig = {
      plugins: {
        load: { paths: [pluginDir] },
        entries: { kilocode: { enabled: true } },
      },
    };
    const env = {
      KILOCODE_API_KEY: "test-key",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      VITEST: "true",
    };
    await writePathInstallRecord({ cfg, env, pluginId: "kilocode", installPath: stalePath });

    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "kilocode", origin: "config", rootDir: pluginDir }),
      ]),
    );
    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({
      changes: [
        'Removed stale path-install record for plugin "kilocode" (loaded from a configured load path).',
      ],
      records: {},
      warnings: [],
    });
    expect(Object.keys(await loadInstalledPluginIndexInstallRecords({ env }))).toStrictEqual([]);
  });

  it("uses configured selection when a load path keeps bundled origin", async () => {
    const rootDir = tempDirs.make("openclaw-stale-bundled-record-");
    const bundledPluginsDir = path.join(rootDir, "dist", "extensions");
    const pluginDir = path.join(bundledPluginsDir, "opencode-go");
    const stalePath = path.join(rootDir, "removed-plugin");
    writeBundledOpenCodeGoPlugin(bundledPluginsDir);
    const cfg: OpenClawConfig = {
      plugins: {
        load: { paths: [pluginDir] },
        entries: { "opencode-go": { enabled: true } },
      },
    };
    const env = {
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      VITEST: "true",
    };
    await writePathInstallRecord({ cfg, env, pluginId: "opencode-go", installPath: stalePath });

    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "opencode-go", origin: "bundled", rootDir: pluginDir }),
      ]),
    );
    expect(snapshot.discovery?.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rootDir: pluginDir, origin: "bundled", configSelected: true }),
      ]),
    );
    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair.records).not.toHaveProperty("opencode-go");
    expect(await loadInstalledPluginIndexInstallRecords({ env })).not.toHaveProperty("opencode-go");
  });

  it("keeps a record whose source path resolves to the configured plugin", async () => {
    const rootDir = tempDirs.make("openclaw-stale-path-alias-");
    const pluginDir = path.join(rootDir, "configured-plugin");
    const sourceAlias = path.join(rootDir, "source-alias");
    const stalePath = path.join(rootDir, "removed-install");
    writeProviderPlugin(pluginDir);
    fs.symlinkSync(pluginDir, sourceAlias, "dir");
    const cfg: OpenClawConfig = {
      plugins: {
        load: { paths: [pluginDir] },
        entries: { kilocode: { enabled: true } },
      },
    };
    const env = {
      KILOCODE_API_KEY: "test-key",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      VITEST: "true",
    };
    await writePathInstallRecord({
      cfg,
      env,
      pluginId: "kilocode",
      installPath: stalePath,
      sourcePath: sourceAlias,
    });

    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toEqual([
      expect.objectContaining({ kind: "missing-installed-payload", pluginId: "kilocode" }),
    ]);
    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair.records).toHaveProperty("kilocode");
    expect(await loadInstalledPluginIndexInstallRecords({ env })).toHaveProperty("kilocode");
  });

  it("does not install a provider plugin already present at a configured load path", async () => {
    const rootDir = tempDirs.make("openclaw-load-path-provider-");
    const pluginDir = path.join(rootDir, "kilocode-provider");
    writeProviderPlugin(pluginDir);

    const cfg = {
      plugins: {
        load: { paths: [pluginDir] },
      },
    };
    const env = {
      KILOCODE_API_KEY: "test-key",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(rootDir, "bundled"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_STATE_DIR: path.join(rootDir, "state"),
      VITEST: "true",
    };
    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins.map((plugin) => plugin.id)).toContain("kilocode");

    const issues = await detectConfiguredPluginInstallHealthIssues({
      cfg,
      env,
    });
    expect(issues).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({
      changes: [],
      records: {},
      warnings: [],
    });
  });

  it("keeps a configured Gmail Codex app bundle without package.json", async () => {
    const { cfg, env, pluginDir } = await createConfiguredCodexBundleFixture("valid");

    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gmail",
          origin: "config",
          rootDir: pluginDir,
          bundleFormat: "codex",
        }),
      ]),
    );
    expect(await detectConfiguredPluginInstallHealthIssues({ cfg, env })).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({ changes: [], warnings: [] });
    expect(repair.records.gmail).toMatchObject({ source: "path", installPath: pluginDir });
    expect(await loadInstalledPluginIndexInstallRecords({ env })).toHaveProperty("gmail");
  });

  it.each(["absent", "malformed"] as const)(
    "classifies a Codex bundle manifest in %s state as repairable",
    async (manifestState) => {
      const { cfg, env } = await createConfiguredCodexBundleFixture(manifestState);

      const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });
      expect(issues).toEqual([
        expect.objectContaining({ kind: "missing-installed-payload", pluginId: "gmail" }),
      ]);
      expect(
        configuredPluginInstallIssueToRepairEffect(
          expectDefined(issues[0], "configured plugin issue"),
        ),
      ).toEqual({
        kind: "package",
        action: "would-reinstall-configured-plugin",
        target: "gmail",
        dryRunSafe: false,
      });
    },
  );

  it("discovers packaged OpenCode Go before configured-plugin repair", async () => {
    const rootDir = tempDirs.make("openclaw-bundled-opencode-go-");
    const homeDir = path.join(rootDir, "home");
    const stateDir = path.join(rootDir, "state");
    const configPath = path.join(stateDir, "openclaw.json");
    const bundledPluginsDir = path.join(rootDir, "dist", "extensions");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    writeBundledOpenCodeGoPlugin(bundledPluginsDir);

    const cfg = {
      auth: {
        profiles: {
          "opencode-go:default": { provider: "opencode-go", mode: "api_key" as const },
        },
      },
    };
    fs.writeFileSync(configPath, `${JSON.stringify(cfg)}\n`, "utf8");
    const env = {
      HOME: homeDir,
      USERPROFILE: homeDir,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
      OPENCLAW_DISABLE_BUNDLED_SOURCE_OVERLAYS: "1",
      OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9",
      npm_config_registry: "http://127.0.0.1:9",
      XDG_CONFIG_HOME: path.join(rootDir, "xdg-config"),
      VITEST: "true",
    };
    const snapshot = loadManifestMetadataSnapshot({ config: cfg, env });
    expect(snapshot.plugins).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "opencode-go", origin: "bundled" })]),
    );

    const issues = await detectConfiguredPluginInstallHealthIssues({ cfg, env });
    expect(issues).toStrictEqual([]);

    const repair = await repairMissingConfiguredPluginInstalls({ cfg, env });
    expect(repair).toMatchObject({
      changes: [],
      warnings: [],
    });
    expect(Object.keys(repair.records)).toStrictEqual([]);
    expect(Object.getPrototypeOf(repair.records)).toBeNull();
  });
});
