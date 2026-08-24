import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifestMetadataSnapshot } from "../../../plugins/manifest-contract-eligibility.js";
import { clearPluginMetadataLifecycleCaches } from "../../../plugins/plugin-metadata-lifecycle.js";
import {
  detectConfiguredPluginInstallHealthIssues,
  repairMissingConfiguredPluginInstalls,
} from "./missing-configured-plugin-install.js";

const tempDirs: string[] = [];

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
  it("does not install a provider plugin already present at a configured load path", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-load-path-provider-"));
    tempDirs.push(rootDir);
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

  it("discovers packaged OpenCode Go before configured-plugin repair", async () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-opencode-go-"));
    tempDirs.push(rootDir);
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
