/** Proves an installed Agent Plugins bundle can launch and execute a real stdio MCP tool. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getOrCreateSessionMcpRuntime } from "./agent-bundle-mcp-manager.test-support.js";
import {
  disposeAllSessionMcpRuntimes,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-tools.js";

const tempDirs: string[] = [];
const PLUGIN_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

afterEach(async () => {
  await disposeAllSessionMcpRuntimes();
  clearPluginMetadataLifecycleCaches();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function writeProbeServer(filePath: string): Promise<void> {
  await fs.writeFile(
    filePath,
    `import { existsSync } from "node:fs";

let buffer = "";
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-bundle-probe", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{
          name: "weather_probe",
          description: "Reports the Agent Plugins subprocess contract.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        content: [{
          type: "text",
          text: JSON.stringify({
            pluginRoot: process.env.PLUGIN_ROOT,
            pluginData: process.env.PLUGIN_DATA,
            pluginDataExists: existsSync(process.env.PLUGIN_DATA ?? ""),
            argv: process.argv.slice(2),
          }),
        }],
        isError: false,
      },
    });
  }
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
function shutdown() {
  process.exit(0);
}
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
`,
    "utf8",
  );
}

it("discovers an installed Agent Plugins bundle and executes its real stdio tool", async () => {
  const stateDir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-bundle-runtime-")),
  );
  tempDirs.push(stateDir);
  const pluginId = "agent-bundle-probe";
  const pluginRoot = path.join(stateDir, "extensions", pluginId);
  const workspaceDir = path.join(stateDir, "workspace");
  const bundledPluginsDir = path.join(stateDir, "bundled-plugins-disabled");
  const serverPath = path.join(pluginRoot, "probe-server.mjs");
  const expandedMarkerPath = path.join(pluginRoot, "expanded-marker.txt");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(bundledPluginsDir, { recursive: true });
  await writeProbeServer(serverPath);
  await fs.writeFile(
    path.join(pluginRoot, "plugin.json"),
    JSON.stringify({ $schema: PLUGIN_SCHEMA, name: pluginId }),
    "utf8",
  );
  await fs.writeFile(
    path.join(pluginRoot, "mcp.json"),
    JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        weatherProbe: {
          type: "stdio",
          command: "node",
          args: ["${PLUGIN_ROOT}/probe-server.mjs", "${PLUGIN_ROOT}/expanded-marker.txt"],
        },
      },
    }),
    "utf8",
  );

  const cfg: OpenClawConfig = {
    plugins: { entries: { [pluginId]: { enabled: true } } },
  };
  await withEnvAsync(
    {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_HOME: undefined,
      OPENCLAW_CONFIG_PATH: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledPluginsDir,
    },
    async () => {
      clearPluginMetadataLifecycleCaches();
      const loaded = loadEnabledBundleMcpConfig({ workspaceDir, cfg });
      expect(loaded.diagnostics).toStrictEqual([]);
      const loadedServer = expectDefined(
        loaded.config.mcpServers.weatherProbe,
        "Agent Plugins weather probe server",
      );
      const loadedEnv = expectDefined(
        isRecord(loadedServer.env) ? loadedServer.env : undefined,
        "Agent Plugins injected environment",
      );
      const expectedPluginRoot = await fs.realpath(pluginRoot);
      const expectedPluginData = path.join(stateDir, "plugin-data", pluginId);
      await expect(fs.stat(expectedPluginData)).rejects.toMatchObject({ code: "ENOENT" });
      expect(loadedServer.args).toEqual([serverPath, expandedMarkerPath]);
      expect(loadedEnv).toMatchObject({
        PLUGIN_ROOT: expectedPluginRoot,
        PLUGIN_DATA: expectedPluginData,
      });

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "agent-bundle-boundary",
        sessionKey: "agent:test:agent-bundle-boundary",
        workspaceDir,
        cfg,
      });
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      try {
        expect(await fs.realpath(expectedPluginData)).toBe(expectedPluginData);
        expect((await fs.stat(expectedPluginData)).isDirectory()).toBe(true);
        const tool = expectDefined(
          materialized.tools.find((entry) => entry.name === "weatherProbe__weather_probe"),
          "materialized Agent Plugins weather probe tool",
        );
        expect(getPluginToolMeta(tool)).toMatchObject({
          pluginId: "bundle-mcp",
          mcp: { serverName: "weatherProbe", toolName: "weather_probe" },
        });

        const result = await tool.execute("agent-bundle-boundary-call", {}, undefined, undefined);
        const text = result.content.find((entry) => entry.type === "text")?.text;
        const payload = JSON.parse(expectDefined(text, "weather probe text result")) as unknown;
        expect(isRecord(payload)).toBe(true);
        if (!isRecord(payload)) {
          return;
        }
        expect(payload).toEqual({
          pluginRoot: expectedPluginRoot,
          pluginData: expectedPluginData,
          pluginDataExists: true,
          argv: [expandedMarkerPath],
        });
      } finally {
        await materialized.dispose();
        await disposeAllSessionMcpRuntimes();
      }

      await fs.rm(expectedPluginData, { recursive: true });
      await fs.writeFile(expectedPluginData, "Agent data-dir collision", "utf8");
      const userDataPath = path.join(stateDir, "user-configured-data-file");
      await fs.writeFile(userDataPath, "user-owned path", "utf8");
      clearPluginMetadataLifecycleCaches();
      const collisionRuntime = await getOrCreateSessionMcpRuntime({
        sessionId: "agent-bundle-boundary-collision",
        sessionKey: "agent:test:agent-bundle-boundary-collision",
        workspaceDir,
        cfg: {
          ...cfg,
          mcp: {
            servers: {
              userProbe: {
                command: "node",
                args: [serverPath, expandedMarkerPath],
                env: { PLUGIN_ROOT: pluginRoot, PLUGIN_DATA: userDataPath },
              },
            },
          },
        },
      });
      try {
        const catalog = await collisionRuntime.getCatalog();

        expect(Object.keys(catalog.servers)).toEqual(["userProbe"]);
        expect(catalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual([
          "userProbe:weather_probe",
        ]);
        expect(catalog.diagnostics).toEqual([
          expect.objectContaining({
            serverName: "weatherProbe",
            message: expect.stringMatching(/unable to prepare PLUGIN_DATA.*EEXIST/iu),
          }),
        ]);
        expect((await fs.stat(expectedPluginData)).isFile()).toBe(true);
        expect((await fs.stat(userDataPath)).isFile()).toBe(true);
      } finally {
        await disposeAllSessionMcpRuntimes();
      }
    },
  );
});
