import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadBundledCapabilityRuntimeRegistry } from "./bundled-capability-runtime.js";
import type { PluginDiscoveryResult } from "./discovery.js";
import type { PluginManifest } from "./manifest.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeBundledToolPlugin(params: {
  pluginId: string;
  toolName: string;
  contracts?: PluginManifest["contracts"];
}): PluginDiscoveryResult {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-capability-"));
  tempDirs.push(rootDir);
  const source = path.join(rootDir, "index.cjs");
  const manifestPath = path.join(rootDir, "openclaw.plugin.json");
  const manifest: PluginManifest = {
    id: params.pluginId,
    configSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
    ...(params.contracts ? { contracts: params.contracts } : {}),
  };
  fs.writeFileSync(
    source,
    `module.exports = {
  register(api) {
    api.registerTool({
      name: ${JSON.stringify(params.toolName)},
      description: "test capability tool",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      execute: async () => ({ content: [] }),
    });
  },
};
`,
    "utf-8",
  );
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  return {
    candidates: [
      {
        idHint: params.pluginId,
        source,
        rootDir,
        origin: "bundled",
        bundledManifest: manifest,
        bundledManifestPath: manifestPath,
      },
    ],
    diagnostics: [],
  };
}

function loadFixtureRegistry(params: { pluginId: string; discovery: PluginDiscoveryResult }) {
  return loadBundledCapabilityRuntimeRegistry({
    pluginIds: [params.pluginId],
    discovery: params.discovery,
    env: {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
  });
}

describe("loadBundledCapabilityRuntimeRegistry", () => {
  it("uses manifest-owned contracts when validating bundled capability tools", () => {
    const pluginId = "bundled-contract-tool";
    const toolName = "bundled_contract_tool";
    const discovery = writeBundledToolPlugin({
      pluginId,
      toolName,
      contracts: { tools: [toolName] },
    });

    const registry = loadFixtureRegistry({ pluginId, discovery });

    expect(registry.plugins).toMatchObject([
      {
        id: pluginId,
        contracts: { tools: [toolName] },
        status: "loaded",
        toolNames: [toolName],
      },
    ]);
    expect(registry.tools.flatMap((tool) => tool.names)).toContain(toolName);
    expect(registry.diagnostics).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId,
          message: `plugin must declare contracts.tools for: ${toolName}`,
        }),
      ]),
    );
  });

  it("still rejects bundled capability tools that are missing manifest contracts", () => {
    const pluginId = "bundled-contract-missing-tool";
    const toolName = "undeclared_bundled_tool";
    const discovery = writeBundledToolPlugin({
      pluginId,
      toolName,
    });

    const registry = loadFixtureRegistry({ pluginId, discovery });

    expect(registry.plugins).toMatchObject([
      {
        id: pluginId,
        status: "loaded",
        toolNames: [toolName],
      },
    ]);
    expect(registry.tools.flatMap((tool) => tool.names)).not.toContain(toolName);
    expect(registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          pluginId,
          message: `plugin must declare contracts.tools for: ${toolName}`,
        }),
      ]),
    );
  });
});
