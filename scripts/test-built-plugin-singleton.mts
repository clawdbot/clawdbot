// Smoke-tests the built plugin loader singleton and bundled plugin runtime overlay.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createState } from "./lib/openclaw-test-state.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { installProcessWarningFilter } from "./process-warning-filter.mts";

installProcessWarningFilter();

const repoRoot = resolveRepoRoot(import.meta.url);
const smokeEntryPath = path.join(repoRoot, "dist", "plugins", "build-smoke-entry.js");
assert.ok(fs.existsSync(smokeEntryPath), `missing build output: ${smokeEntryPath}`);

// Registry retirement can open session stores. Isolate before importing the runtime,
// while keeping source runtime helpers out of this cold built-loader proof.
const testState = await createState({ label: "build-smoke", scenario: "minimal" });
Object.assign(process.env, testState.env);
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.PI_CODING_AGENT_DIR;
const pluginId = "build-smoke-plugin";
const distPluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
const runtimePluginDir = path.join(repoRoot, "dist-runtime", "extensions", pluginId);

function cleanup() {
  fs.rmSync(distPluginDir, { recursive: true, force: true });
  fs.rmSync(runtimePluginDir, { recursive: true, force: true });
  fs.rmSync(testState.root, { recursive: true, force: true });
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

const {
  buildPluginRuntimeLoadOptions,
  clearPluginCommands,
  getPluginCommandSpecs,
  getPluginModuleLoaderStats,
  loadOpenClawPlugins,
  matchPluginCommand,
  resolvePluginRuntimeLoadContext,
} = await import(pathToFileURL(smokeEntryPath).href);

assert.equal(typeof loadOpenClawPlugins, "function", "built loader export missing");
assert.equal(typeof clearPluginCommands, "function", "clearPluginCommands missing");
assert.equal(typeof getPluginCommandSpecs, "function", "getPluginCommandSpecs missing");
assert.equal(typeof getPluginModuleLoaderStats, "function", "plugin loader stats missing");
assert.equal(typeof matchPluginCommand, "function", "matchPluginCommand missing");

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
      providers: [pluginId],
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
    "import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';",
    "",
    "export default {",
    `  id: ${JSON.stringify(pluginId)},`,
    "  configSchema: emptyPluginConfigSchema(),",
    "  register(api) {",
    "    api.registerProvider({",
    `      id: ${JSON.stringify(pluginId)},`,
    "      label: 'Build smoke provider',",
    "      auth: [],",
    "      normalizeModelId: ({ modelId }) => `normalized-${modelId}`,",
    "    });",
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

// The full build owns existing runtime artifacts; copy only this smoke's synthetic plugin.
fs.cpSync(distPluginDir, runtimePluginDir, { recursive: true });

const runtimeEntryPath = path.join(runtimePluginDir, "index.js");
assert.ok(fs.existsSync(runtimeEntryPath), "runtime overlay entry missing");
const smsRuntimeEntryPath = path.join(repoRoot, "dist-runtime", "extensions", "sms", "index.js");
assert.ok(fs.existsSync(smsRuntimeEntryPath), "compiled SMS runtime entry missing");
assert.ok(
  fs.existsSync(path.join(repoRoot, "dist-runtime", "extensions", "mxc", "mxc-spawn-launcher.mjs")),
  "compiled MXC runtime asset missing",
);
assert.equal(
  fs.existsSync(path.join(repoRoot, "dist-runtime", "plugins", "commands.js")),
  false,
  "dist-runtime must not stage a duplicate commands module",
);

clearPluginCommands();

const smsStatsBefore = getPluginModuleLoaderStats();
// Prepared runtimes carry this context into late, plugin-scoped loads. Prove that the load-options
// projection retains the built-artifact choice instead of reopening source transformation.
const smsRegistry = loadOpenClawPlugins(
  buildPluginRuntimeLoadOptions(
    resolvePluginRuntimeLoadContext({
      config: {
        plugins: {
          enabled: true,
          allow: ["sms"],
          entries: { sms: { enabled: true } },
        },
      },
      env: {
        ...process.env,
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "extensions"),
      },
      preferBuiltPluginArtifacts: true,
      workspaceDir: testState.workspaceDir,
    }),
    { cache: false, onlyPluginIds: ["sms"] },
  ),
);
const smsRecord = smsRegistry.plugins.find((entry: { id: string }) => entry.id === "sms");
assert.ok(smsRecord, "SMS plugin missing from registry");
assert.equal(smsRecord.status, "loaded", smsRecord.error ?? "SMS plugin failed to load");
const smsStatsAfter = getPluginModuleLoaderStats();
assert.ok(
  smsStatsAfter.nativeHits > smsStatsBefore.nativeHits,
  "compiled SMS runtime did not use native loading",
);
for (const counter of [
  "nativeMisses",
  "sourceTransformForced",
  "sourceTransformFallbacks",
] as const) {
  assert.equal(
    smsStatsAfter[counter],
    smsStatsBefore[counter],
    `compiled SMS runtime changed ${counter}`,
  );
}
assert.equal(
  smsStatsAfter.topSourceTransformTargets.some(({ target }: { target: string }) =>
    target.replaceAll("\\", "/").includes("/extensions/sms/"),
  ),
  false,
  "compiled SMS runtime reached the source transformer",
);

clearPluginCommands();

const config = {
  plugins: {
    enabled: true,
    allow: [pluginId],
    entries: {
      [pluginId]: { enabled: true },
    },
  },
};
const registry = loadOpenClawPlugins({
  cache: false,
  workspaceDir: testState.workspaceDir,
  env: {
    ...process.env,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(repoRoot, "dist-runtime", "extensions"),
  },
  config,
});

const record = registry.plugins.find((entry: { id: string }) => entry.id === pluginId);
assert.ok(record, "smoke plugin missing from registry");
assert.equal(record.status, "loaded", record.error ?? "smoke plugin failed to load");

assert.deepEqual(
  getPluginCommandSpecs().filter((command: { name: string }) => command.name === "pair"),
  [{ name: "pair", description: "Pair a device", acceptsArgs: true }],
);

const match = matchPluginCommand("/pair now");
assert.ok(match, "canonical built command registry did not receive the command");
assert.equal(match.args, "now");
const result = await match.command.handler({ args: match.args });
assert.deepEqual(result, { text: "paired:now" });

const { parseModelRef } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "plugin-sdk", "model-ref-parse.js")).href
);
const normalizationOptions = {
  config,
  workspaceDir: testState.workspaceDir,
  allowManifestNormalization: false,
};
assert.deepEqual(
  parseModelRef("first", pluginId, {
    ...normalizationOptions,
    allowPluginNormalization: false,
  }),
  { provider: pluginId, model: "first" },
);
const normalizationStatsBefore = getPluginModuleLoaderStats();
assert.deepEqual(parseModelRef("first", pluginId, normalizationOptions), {
  provider: pluginId,
  model: "normalized-first",
});
const normalizationStatsAfter = getPluginModuleLoaderStats();
for (const counter of [
  "nativeMisses",
  "sourceTransformForced",
  "sourceTransformFallbacks",
] as const) {
  assert.equal(
    normalizationStatsAfter[counter],
    normalizationStatsBefore[counter],
    `built model normalization changed ${counter}`,
  );
}
assert.deepEqual(parseModelRef("second", pluginId, normalizationOptions), {
  provider: pluginId,
  model: "normalized-second",
});
assert.equal(
  getPluginModuleLoaderStats().calls,
  normalizationStatsAfter.calls,
  "warm model normalization reloaded the provider runtime",
);

// Keep these imports after the cold native checks so they cannot prewarm the loader.
const { buildBundleMcpToolsFromCatalog } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "agents", "agent-bundle-mcp-materialize.js")).href
);
const { getPluginToolMeta } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "plugins", "tool-metadata.js")).href
);
const { getPluginToolMeta: getSdkPluginToolMeta } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "plugin-sdk", "agent-harness-runtime.js")).href
);
const [mcpTool] = buildBundleMcpToolsFromCatalog({
  catalog: {
    version: 1,
    generatedAt: 0,
    servers: {
      "build-smoke-mcp": {
        serverName: "build-smoke-mcp",
        safeServerName: "build-smoke-mcp",
        launchSummary: "build smoke inventory fixture",
        toolCount: 1,
      },
    },
    tools: [
      {
        serverName: "build-smoke-mcp",
        safeServerName: "build-smoke-mcp",
        toolName: "lookup",
        inputSchema: { type: "object", properties: {} },
        fallbackDescription: "Look up a build smoke inventory item",
      },
    ],
  },
});
assert.ok(mcpTool, "compiled MCP materializer did not produce a tool");
const mcpMetadata = getPluginToolMeta(mcpTool);
assert.ok(mcpMetadata, "canonical built metadata owner did not receive MCP tool metadata");
assert.equal(mcpMetadata.pluginId, "bundle-mcp");
assert.equal(mcpMetadata.mcp?.serverName, "build-smoke-mcp");
assert.equal(mcpMetadata.mcp?.safeServerName, "build-smoke-mcp");
assert.equal(mcpMetadata.mcp?.toolName, "lookup");
assert.equal(mcpMetadata.mcp?.operation, "tool");
assert.strictEqual(
  getSdkPluginToolMeta(mcpTool),
  mcpMetadata,
  "public agent-harness-runtime SDK did not read the canonical MCP metadata record",
);

process.stdout.write("[build-smoke] built plugin singleton smoke passed\n");
