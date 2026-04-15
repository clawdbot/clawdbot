import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearPluginDiscoveryCache } from "../plugins/discovery.js";
import { clearPluginManifestRegistryCache } from "../plugins/manifest-registry.js";
import { resetFacadeRuntimeStateForTest } from "./facade-runtime.js";

const ORIGINAL_ENV = {
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS,
  OPENCLAW_CONFIG_PATH: process.env.OPENCLAW_CONFIG_PATH,
  OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE,
  OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: process.env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE,
  OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS: process.env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS,
  OPENCLAW_PLUGIN_MANIFEST_CACHE_MS: process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS,
  OPENCLAW_TEST_FAST: process.env.OPENCLAW_TEST_FAST,
} as const;

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function resetQaRunnerRuntimeState() {
  clearPluginDiscoveryCache();
  clearPluginManifestRegistryCache();
  resetFacadeRuntimeStateForTest();
}

describe("plugin-sdk qa-runner-runtime linked plugin smoke", () => {
  beforeEach(() => {
    resetQaRunnerRuntimeState();
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    process.env.OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE = "1";
    process.env.OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE = "1";
    process.env.OPENCLAW_PLUGIN_DISCOVERY_CACHE_MS = "0";
    process.env.OPENCLAW_PLUGIN_MANIFEST_CACHE_MS = "0";
    process.env.OPENCLAW_TEST_FAST = "1";
  });

  afterEach(() => {
    resetQaRunnerRuntimeState();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("loads an activated qa runner from a linked plugin path without a bundled install fallback", async () => {
    const stateDir = makeTempDir("openclaw-qa-runner-state-");
    const pluginDir = path.join(stateDir, "extensions", "qa-linked");
    const configPath = path.join(stateDir, "openclaw.json");

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        plugins: {},
      }),
      "utf8",
    );
    process.env.OPENCLAW_CONFIG_PATH = configPath;

    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "qa-linked",
        qaRunners: [
          {
            commandName: "linked",
            description: "Run the linked QA lane",
          },
        ],
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: "@openclaw/qa-linked",
        type: "module",
        openclaw: {
          extensions: ["./index.js"],
          install: {
            npmSpec: "@openclaw/qa-linked",
          },
        },
      }),
      "utf8",
    );
    fs.writeFileSync(path.join(pluginDir, "index.js"), "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(pluginDir, "runtime-api.js"),
      [
        "export const qaRunnerCliRegistrations = [",
        "  {",
        '    commandName: "linked",',
        "    register() {}",
        "  }",
        "];",
      ].join("\n"),
      "utf8",
    );

    const module = await import("./qa-runner-runtime.js");

    expect(module.listQaRunnerCliContributions()).toEqual([
      {
        pluginId: "qa-linked",
        commandName: "linked",
        description: "Run the linked QA lane",
        status: "available",
        registration: {
          commandName: "linked",
          register: expect.any(Function),
        },
      },
    ]);
  });
});
