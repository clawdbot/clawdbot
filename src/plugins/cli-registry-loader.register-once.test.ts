// Pins one plugin register execution per CLI invocation across independent bootstrap stages.
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, onTestFinished } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginCliLoadSession,
  loadPluginCliDescriptors,
  resolvePluginCliRootOwnerIds,
} from "./cli-registry-loader.js";
import { getPluginCliCommandDescriptors } from "./cli-root-descriptors.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "./loader.test-fixtures.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

function countRegisterRuns(markerPath: string): number {
  return fs.existsSync(markerPath)
    ? fs.readFileSync(markerPath, "utf8").split("\n").filter(Boolean).length
    : 0;
}

function setupCountingCliPlugin(): { config: OpenClawConfig; markerPath: string } {
  useNoBundledPlugins();
  const pluginDir = makePluginLoaderTempDir();
  const markerPath = path.join(makePluginLoaderTempDir(), "register-runs.log");
  writePlugin({
    id: "counting-cli",
    dir: pluginDir,
    filename: "index.cjs",
    body: `const fs = require("node:fs");
module.exports = {
  id: "counting-cli",
  register(api) {
    fs.appendFileSync(${JSON.stringify(markerPath)}, "register\\n");
    api.registerCli(() => {}, {
      commands: ["counting-cli"],
      descriptors: [
        { name: "counting-cli", description: "Counting CLI", hasSubcommands: false },
      ],
    });
  },
};`,
  });
  return {
    config: {
      plugins: {
        load: { paths: [path.join(pluginDir, "index.cjs")] },
        allow: ["counting-cli"],
      },
    } as OpenClawConfig,
    markerPath,
  };
}

describe("plugin CLI metadata registration count", () => {
  it("runs a legacy external plugin register once across CLI bootstrap stages", async () => {
    const { config, markerPath } = setupCountingCliPlugin();

    const session = createPluginCliLoadSession();
    onTestFinished(() => session.close());
    // Stage order mirrors one `openclaw counting-cli --help` invocation: the unowned-primary
    // guard resolves plugin CLI root ownership, then command registration resolves descriptors
    // for the same primary. The CLI carries one preparation session through both stages.
    const ownerIds = await resolvePluginCliRootOwnerIds({
      cfg: config,
      env: process.env,
      primaryCommand: "counting-cli",
      session,
    });
    const descriptors = await loadPluginCliDescriptors({
      cfg: config,
      env: process.env,
      primaryCommand: "counting-cli",
      session,
    });

    expect(ownerIds).toEqual(["counting-cli"]);
    expect(descriptors.map((entry) => entry.name)).toContain("counting-cli");
    expect(countRegisterRuns(markerPath)).toBe(1);
  });

  it("keeps distinct load scopes on separate register passes", async () => {
    const { config, markerPath } = setupCountingCliPlugin();
    // Root help executes only the legacy external plugins it could not read from manifests, so
    // its narrower scope must not be served the full-scope registry (or vice versa).
    await loadPluginCliDescriptors({ cfg: config, env: process.env });
    await getPluginCliCommandDescriptors(config, process.env);

    expect(countRegisterRuns(markerPath)).toBe(2);
  });
});
