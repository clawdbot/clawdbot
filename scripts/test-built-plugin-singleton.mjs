import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installProcessWarningFilter } from "./process-warning-filter.mjs";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mjs";

installProcessWarningFilter();

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeEntryPath = path.join(repoRoot, "dist", "plugins", "build-smoke-entry.js");
assert.ok(fs.existsSync(smokeEntryPath), `missing build output: ${smokeEntryPath}`);

const { clearPluginCommands, getPluginCommandSpecs, loadOpenClawPlugins, matchPluginCommand } =
  await import(pathToFileURL(smokeEntryPath).href);

assert.equal(typeof loadOpenClawPlugins, "function", "built loader export missing");
assert.equal(typeof clearPluginCommands, "function", "clearPluginCommands missing");
assert.equal(typeof getPluginCommandSpecs, "function", "getPluginCommandSpecs missing");
assert.equal(typeof matchPluginCommand, "function", "matchPluginCommand missing");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-build-smoke-"));
const pluginId = "build-smoke-plugin";
const distPluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
const runtimePluginDir = path.join(repoRoot, "dist-runtime", "extensions", pluginId);

function cleanup() {
  clearPluginCommands();
  fs.rmSync(distPluginDir, { recursive: true, force: true });
  fs.rmSync(runtimePluginDir, { recursive: true, force: true });
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

fs.mkdirSync(distPluginDir, { recursive: true });
fs.writeFileSync(
  path.join(distPluginDir, "package.json"),
  JSON.stringify(
    {
      name: "@openclaw/build-smoke-plugin",
      type: "module",
      openclaw: {
        extensions: ["./index.js"],
      },
    },
    null,
    2,
  ),
  "utf8",
);
fs.writeFileSync(
  path.join(distPluginDir, "openclaw.plugin.json"),
  JSON.stringify(
    {
      id: pluginId,
      configSchema: {
        type: "object",
        additionalProperties: false,
        properties: {},
      },
    },
    null,
    2,
  ),
  "utf8",
);
fs.writeFileSync(
  path.join(distPluginDir, "index.js"),
  [
    "import sdk from 'openclaw/plugin-sdk';",
    "const { emptyPluginConfigSchema } = sdk;",
    "",
    "export default {",
    `  id: ${JSON.stringify(pluginId)},`,
    "  configSchema: emptyPluginConfigSchema(),",
    "  register(api) {",
    "    api.registerCommand({",
    "      name: 'pair',",
    "      description: 'Pair a device',",
    "      acceptsArgs: true,",
    "      nativeNames: { telegram: 'pair', discord: 'pair' },",
    "      async handler({ args }) {",
    "        return { text: `paired:${args ?? ''}` };",
    "      },",
    "    });",
    "  },",
    "};",
    "",
  ].join("\n"),
  "utf8",
);

stageBundledPluginRuntime({ repoRoot });

const runtimeEntryPath = path.join(runtimePluginDir, "index.js");
assert.ok(fs.existsSync(runtimeEntryPath), "runtime overlay entry missing");
assert.equal(
  fs.existsSync(path.join(repoRoot, "dist-runtime", "plugins", "commands.js")),
  false,
  "dist-runtime must not stage a duplicate commands module",
);

clearPluginCommands();

const registry = loadOpenClawPlugins({
  cache: false,
  workspaceDir: tempRoot,
  env: {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "dist-runtime", "extensions"),
  },
  config: {
    plugins: {
      enabled: true,
      allow: [pluginId],
      entries: {
        [pluginId]: { enabled: true },
      },
    },
  },
});

const record = registry.plugins.find((entry) => entry.id === pluginId);
assert.ok(record, "smoke plugin missing from registry");
assert.equal(record.status, "loaded", record.error ?? "smoke plugin failed to load");

assert.deepEqual(
  getPluginCommandSpecs().filter((command) => command.name === "pair"),
  [{ name: "pair", description: "Pair a device", acceptsArgs: true }],
);

const match = matchPluginCommand("/pair now");
assert.ok(match, "canonical built command registry did not receive the command");
assert.equal(match.args, "now");
const result = await match.command.handler({ args: match.args });
assert.deepEqual(result, { text: "paired:now" });

process.stdout.write("[build-smoke] built plugin singleton smoke passed\n");
