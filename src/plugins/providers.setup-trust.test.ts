// Covers provider setup trust checks for plugin-owned providers.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { resolvePluginProviders } from "./providers.runtime.js";
import {
  cleanupTrackedTempDirs,
  makeTrackedTempDir,
  mkdirSafeDir,
} from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
  resetPluginLoaderTestStateForTest();
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-provider-setup-trust", tempDirs);
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function readMarkerLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function writeWorkspaceProviderPlugin(params: {
  workspaceDir: string;
  pluginId: string;
  providerId: string;
  markerDir: string;
}) {
  const pluginDir = path.join(params.workspaceDir, ".openclaw", "extensions", params.pluginId);
  mkdirSafeDir(pluginDir);
  writeJson(path.join(pluginDir, "openclaw.plugin.json"), {
    id: params.pluginId,
    name: "Setup Trust Provider",
    description: "Test workspace provider plugin",
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    providers: [params.providerId],
  });
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `const fs = require("node:fs");
const path = require("node:path");

const markerDir = ${JSON.stringify(params.markerDir)};
fs.mkdirSync(markerDir, { recursive: true });
fs.appendFileSync(
  path.join(markerDir, "top-level.txt"),
  JSON.stringify({ event: "top-level", registrationMode: "module-import" }) + "\\n",
);

module.exports = {
  id: ${JSON.stringify(params.pluginId)},
  register(api) {
    fs.appendFileSync(
      path.join(markerDir, "register.txt"),
      JSON.stringify({ event: "register", registrationMode: api.registrationMode }) + "\\n",
    );
    api.registerProvider({
      id: ${JSON.stringify(params.providerId)},
      label: "Setup Trust Provider",
      auth: [],
    });
  },
};
`,
    "utf-8",
  );
}

describe("setup provider workspace trust", () => {
  it("does not import untrusted workspace provider plugins during default setup discovery", () => {
    const runRoot = makeTempDir();
    const workspaceDir = path.join(runRoot, "workspace");
    const stateDir = path.join(runRoot, "state");
    const markerDir = path.join(runRoot, "markers");
    mkdirSafeDir(workspaceDir);
    mkdirSafeDir(stateDir);
    mkdirSafeDir(markerDir);
    writeWorkspaceProviderPlugin({
      workspaceDir,
      pluginId: "setup-autoload-provider",
      providerId: "setup-autoload",
      markerDir,
    });

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    };

    withEnv(env, () => {
      const providers = resolvePluginProviders({
        config: {
          plugins: {
            enabled: true,
          },
        },
        workspaceDir,
        env,
        mode: "setup",
        cache: false,
        onlyPluginIds: ["setup-autoload-provider"],
      });

      expect(providers).toStrictEqual([]);
    });
    expect(readMarkerLines(path.join(markerDir, "top-level.txt"))).toStrictEqual([]);
    expect(readMarkerLines(path.join(markerDir, "register.txt"))).toStrictEqual([]);
  });

  it("loads explicitly trusted workspace provider plugins during setup discovery", () => {
    const runRoot = makeTempDir();
    const workspaceDir = path.join(runRoot, "workspace");
    const stateDir = path.join(runRoot, "state");
    const markerDir = path.join(runRoot, "markers");
    mkdirSafeDir(workspaceDir);
    mkdirSafeDir(stateDir);
    mkdirSafeDir(markerDir);
    writeWorkspaceProviderPlugin({
      workspaceDir,
      pluginId: "setup-trusted-provider",
      providerId: "setup-trusted",
      markerDir,
    });

    const env: NodeJS.ProcessEnv = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
    };

    withEnv(env, () => {
      const providers = resolvePluginProviders({
        config: {
          plugins: {
            allow: ["setup-trusted-provider"],
          },
        },
        workspaceDir,
        env,
        mode: "setup",
        cache: false,
        onlyPluginIds: ["setup-trusted-provider"],
      });

      expect(providers).toEqual([
        {
          id: "setup-trusted",
          label: "Setup Trust Provider",
          auth: [],
          pluginId: "setup-trusted-provider",
        },
      ]);
    });
    expect(readMarkerLines(path.join(markerDir, "top-level.txt"))).toHaveLength(1);
    expect(readMarkerLines(path.join(markerDir, "register.txt"))).toHaveLength(1);
  });
});
