import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findLegacyConfigIssues } from "../config/legacy.js";
import type { OpenClawConfig } from "../config/types.js";
import {
  applyPluginDoctorCompatibilityMigrations,
  clearPluginDoctorContractRegistryCache,
  listPluginDoctorLegacyConfigRules,
  listPluginDoctorSessionRouteStateOwners,
} from "./doctor-contract-registry.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "openclaw-doctor-contract-load-paths-"),
  );
  tempDirs.push(dir);
  return dir;
}

function makeHermeticDoctorEnv(stateDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: stateDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  };
}

function writeDoctorPlugin(pluginRoot: string, pluginId: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Load Path Doctor",
        version: "0.0.0-test",
        configSchema: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `
const pluginId = ${JSON.stringify(pluginId)};

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

module.exports = {
  legacyConfigRules: [
    {
      path: ["plugins", "entries", pluginId, "config", "summaryModel"],
      message: "load-path doctor contract warning",
    },
  ],
  normalizeCompatibilityConfig({ cfg }) {
    const root = isRecord(cfg) ? { ...cfg } : {};
    const plugins = isRecord(root.plugins) ? { ...root.plugins } : {};
    const entries = isRecord(plugins.entries) ? { ...plugins.entries } : {};
    const entry = isRecord(entries[pluginId]) ? { ...entries[pluginId] } : {};
    const llm = isRecord(entry.llm) ? { ...entry.llm } : {};
    const allowedModels = Array.isArray(llm.allowedModels) ? [...llm.allowedModels] : [];
    if (!allowedModels.includes("openai-codex/gpt-5.4-mini")) {
      allowedModels.push("openai-codex/gpt-5.4-mini");
    }
    root.plugins = plugins;
    plugins.entries = entries;
    entries[pluginId] = entry;
    entry.llm = {
      ...llm,
      allowModelOverride: true,
      allowedModels,
    };
    return {
      config: root,
      changes: ["configured load-path doctor contract LLM policy"],
    };
  },
};
`,
    "utf8",
  );
}

function writeDoctorSessionOwnerPlugin(pluginRoot: string, pluginId: string): void {
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify(
      {
        id: pluginId,
        name: "Load Path Session Owner",
        version: "0.0.0-test",
        configSchema: {},
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "doctor-contract-api.cjs"),
    `
module.exports = {
  sessionRouteStateOwners: [
    {
      id: "load-path-session-owner",
      label: "Load Path Session Owner",
      providerIds: ["load-path-provider"],
      runtimeIds: ["load-path-runtime"],
      cliSessionKeys: ["load-path-cli"],
      authProfilePrefixes: ["load-path:"],
    },
  ],
};
`,
    "utf8",
  );
}

function createDoctorPluginConfig(pluginRoot: string, pluginId: string): OpenClawConfig {
  return {
    plugins: {
      load: { paths: [pluginRoot] },
      entries: {
        [pluginId]: {
          enabled: true,
          config: {
            summaryModel: "gpt-5.4-mini",
          },
        },
      },
    },
  };
}

function readPluginLlmPolicy(config: OpenClawConfig, pluginId: string): Record<string, unknown> {
  const entry = config.plugins?.entries?.[pluginId] as { llm?: unknown } | undefined;
  return entry?.llm && typeof entry.llm === "object" && !Array.isArray(entry.llm)
    ? (entry.llm as Record<string, unknown>)
    : {};
}

beforeEach(() => {
  clearPluginDoctorContractRegistryCache();
});

afterEach(() => {
  clearPluginDoctorContractRegistryCache();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor contract registry load-path plugins", () => {
  it("discovers doctor warning rules from plugins.load.paths", () => {
    const stateDir = makeTempDir();
    const pluginRoot = makeTempDir();
    const pluginId = "load-path-doctor";
    writeDoctorPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    const rules = listPluginDoctorLegacyConfigRules({
      config,
      env: makeHermeticDoctorEnv(stateDir),
      pluginIds: [pluginId],
    });
    expect(rules).toEqual([
      {
        path: ["plugins", "entries", pluginId, "config", "summaryModel"],
        message: "load-path doctor contract warning",
      },
    ]);
    expect(findLegacyConfigIssues(config, config, rules)).toEqual([
      {
        path: `plugins.entries.${pluginId}.config.summaryModel`,
        message: "load-path doctor contract warning",
      },
    ]);
  });

  it("applies compatibility normalizers from plugins.load.paths", () => {
    const stateDir = makeTempDir();
    const pluginRoot = makeTempDir();
    const pluginId = "load-path-doctor";
    writeDoctorPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    const result = applyPluginDoctorCompatibilityMigrations(config, {
      config,
      env: makeHermeticDoctorEnv(stateDir),
      pluginIds: [pluginId],
    });
    const llm = readPluginLlmPolicy(result.config, pluginId);

    expect(result.changes).toEqual(["configured load-path doctor contract LLM policy"]);
    expect(llm).toEqual({
      allowModelOverride: true,
      allowedModels: ["openai-codex/gpt-5.4-mini"],
    });
  });

  it("discovers session route-state owners from plugins.load.paths", () => {
    const stateDir = makeTempDir();
    const pluginRoot = makeTempDir();
    const pluginId = "load-path-session-owner";
    writeDoctorSessionOwnerPlugin(pluginRoot, pluginId);
    const config = createDoctorPluginConfig(pluginRoot, pluginId);

    expect(
      listPluginDoctorSessionRouteStateOwners({
        config,
        env: makeHermeticDoctorEnv(stateDir),
      }),
    ).toEqual([
      {
        id: "load-path-session-owner",
        label: "Load Path Session Owner",
        providerIds: ["load-path-provider"],
        runtimeIds: ["load-path-runtime"],
        cliSessionKeys: ["load-path-cli"],
        authProfilePrefixes: ["load-path:"],
      },
    ]);
  });
});
