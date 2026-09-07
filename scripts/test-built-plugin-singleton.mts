// Smoke-tests the built plugin loader singleton and bundled plugin runtime overlay.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { installProcessWarningFilter } from "./process-warning-filter.mts";
import { stageBundledPluginRuntime } from "./stage-bundled-plugin-runtime.mts";

installProcessWarningFilter();

const repoRoot = resolveRepoRoot(import.meta.url);
const smokeEntryPath = path.join(repoRoot, "dist", "plugins", "build-smoke-entry.js");
assert.ok(fs.existsSync(smokeEntryPath), `missing build output: ${smokeEntryPath}`);

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
    "import { emptyPluginConfigSchema } from 'openclaw/plugin-sdk/plugin-entry';",
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
      workspaceDir: tempRoot,
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

// Exercise the real built load owner with omitted preferences, as provider and
// tool callers do. Source-owned metadata must not force source execution.
const { resolvePluginDiscoveryProvidersRuntime } = await import(
  pathToFileURL(path.join(repoRoot, "dist", "plugins", "provider-discovery.runtime.js")).href
);
const { createPluginMetadataSnapshotFixture } =
  await import("../src/plugins/plugin-metadata.test-support.js");
const { withPluginRuntimeGenerationScope } =
  await import("../src/plugins/runtime/generation-scope.js");
const { setPluginRuntimeLoadContext } = await import("../src/plugins/runtime/load-context.js");
const artifactPluginId = "build-artifact-selection";
const artifactSourceRoot = path.join(tempRoot, "extensions", artifactPluginId);
const artifactBuiltRoot = path.join(tempRoot, "dist", "extensions", artifactPluginId);
fs.mkdirSync(artifactSourceRoot, { recursive: true });
fs.mkdirSync(artifactBuiltRoot, { recursive: true });
fs.mkdirSync(path.join(artifactSourceRoot, "dist"));
const artifactEntry = (label: string) => `export default {
  id: ${JSON.stringify(artifactPluginId)},
  register(api) {
    api.registerProvider({ id: ${JSON.stringify(artifactPluginId)}, label: ${JSON.stringify(label)}, auth: [] });
    api.registerTool({ name: "artifact_probe", label: "Artifact", description: ${JSON.stringify(label)},
      parameters: { type: "object", properties: {} },
      async execute() { return { content: [{ type: "text", text: ${JSON.stringify(label)} }] }; }
    });
  }
};\n`;
const artifactSource = path.join(artifactSourceRoot, "index.ts");
fs.writeFileSync(artifactSource, artifactEntry("source"));
fs.writeFileSync(path.join(artifactBuiltRoot, "index.js"), artifactEntry("compiled"));
fs.writeFileSync(path.join(artifactSourceRoot, "dist", "index.js"), artifactEntry("package-local"));
fs.writeFileSync(path.join(artifactSourceRoot, "package.json"), JSON.stringify({ type: "module" }));
for (const [rootDir, extension, label] of [
  [artifactSourceRoot, ".ts", "source"],
  [artifactBuiltRoot, ".js", "compiled"],
] as const) {
  fs.writeFileSync(
    path.join(rootDir, `provider-discovery${extension}`),
    `export default {
    id: ${JSON.stringify(artifactPluginId)}, label: ${JSON.stringify(label)}, auth: [],
    catalog: { run: async () => ({ providers: {} }) }
  };\n`,
  );
}
fs.writeFileSync(
  path.join(artifactBuiltRoot, "package.json"),
  JSON.stringify({
    type: "module",
    openclaw: { extensions: ["./index.js"] },
  }),
);
const artifactConfig = {
  plugins: { allow: [artifactPluginId], entries: { [artifactPluginId]: { enabled: true } } },
};
const artifactManifest = {
  id: artifactPluginId,
  rootDir: artifactSourceRoot,
  source: artifactSource,
  origin: "bundled" as const,
  channels: [],
  providers: [artifactPluginId],
  cliBackends: [],
  skills: [],
  hooks: [],
  contracts: { tools: ["artifact_probe"] },
  manifestPath: path.join(artifactSourceRoot, "openclaw.plugin.json"),
  providerDiscoverySource: path.join(artifactSourceRoot, "provider-discovery.ts"),
  configSchema: { type: "object", properties: {}, additionalProperties: false },
  packageManifest: { extensions: ["./index.ts"], build: { bundledDist: false } },
};
const artifactManifestRegistry = {
  plugins: [artifactManifest],
  diagnostics: [],
};
const artifactMetadataSnapshot = createPluginMetadataSnapshotFixture(artifactManifestRegistry);
for (const toolDiscovery of [false, true]) {
  for (const preferBuiltPluginArtifacts of [undefined, false]) {
    const values = {
      config: artifactConfig,
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "artifact-state") },
      manifestRegistry: artifactManifestRegistry,
      installRecords: {},
      preferBuiltPluginArtifacts,
      workspaceDir: tempRoot,
    };
    const options = toolDiscovery
      ? buildPluginRuntimeLoadOptions(resolvePluginRuntimeLoadContext(values))
      : values;
    const selected = loadOpenClawPlugins({
      ...options,
      cache: false,
      activate: false,
      toolDiscovery,
      onlyPluginIds: [artifactPluginId],
    });
    const label = preferBuiltPluginArtifacts === false ? "source" : "compiled";
    assert.equal(selected.plugins[0]?.status, "loaded", selected.plugins[0]?.error);
    assert.equal(selected.providers[0]?.provider.label, label);
    const tool = selected.tools[0]?.factory({ config: artifactConfig });
    assert.equal(tool?.description, label);
    if (!toolDiscovery) {
      setPluginRuntimeLoadContext(selected, resolvePluginRuntimeLoadContext(values));
      const providers = withPluginRuntimeGenerationScope(
        { metadataSnapshot: artifactMetadataSnapshot, pluginRegistry: selected },
        () =>
          resolvePluginDiscoveryProvidersRuntime({
            config: artifactConfig,
            pluginMetadataSnapshot: artifactMetadataSnapshot,
            onlyPluginIds: [artifactPluginId],
            discoveryEntriesOnly: true,
          }),
      );
      assert.equal(
        providers[0]?.label,
        label,
        "provider discovery chose a different artifact policy",
      );
    }
  }
}

// Implicit built-host policy leaves installed source alone; explicit true can
// use its package-local output. Neither cache call order may contaminate the other.
for (const [orderIndex, preferences] of [
  [undefined, true],
  [true, undefined],
].entries()) {
  const options = {
    config: artifactConfig,
    env: { ...process.env, OPENCLAW_STATE_DIR: path.join(tempRoot, "artifact-state") },
    workspaceDir: path.join(tempRoot, `cache-order-${orderIndex}`),
    manifestRegistry: {
      ...artifactManifestRegistry,
      plugins: [{ ...artifactManifest, origin: "global" }],
    },
    installRecords: {},
    onlyPluginIds: [artifactPluginId],
    cache: true,
    activate: false,
  };
  const registries = preferences.map((preferBuiltPluginArtifacts) => {
    const selected = loadOpenClawPlugins({ ...options, preferBuiltPluginArtifacts });
    const label = preferBuiltPluginArtifacts ? "package-local" : "source";
    assert.equal(selected.plugins[0]?.status, "loaded", selected.plugins[0]?.error);
    assert.equal(selected.providers[0]?.provider.label, label, `cache call order ${orderIndex}`);
    assert.equal(selected.tools[0]?.factory({ config: artifactConfig })?.description, label);
    return selected;
  });
  for (const [index, preferBuiltPluginArtifacts] of preferences.entries()) {
    assert.equal(
      loadOpenClawPlugins({ ...options, preferBuiltPluginArtifacts }),
      registries[index],
      "repeated selection did not reuse its own cached registry",
    );
  }
}

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
