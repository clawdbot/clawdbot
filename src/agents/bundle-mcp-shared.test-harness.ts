/**
 * Shared test harness helpers for generating bundle MCP servers and plugin
 * fixture files.
 */
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");

/** Writes an executable fixture script with parent directories created. */
export async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}

/** Writes a stdio MCP server fixture exposing a `bundle_probe` tool. */
export async function writeBundleProbeMcpServer(
  filePath: string,
  params: {
    startupCounterPath?: string;
    startupDelayMs?: number;
    pidPath?: string;
    exitMarkerPath?: string;
  } = {},
): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};

const startupCounterPath = ${JSON.stringify(params.startupCounterPath ?? "")};
if (startupCounterPath) {
  let current = 0;
  try {
    current = Number.parseInt((await fsp.readFile(startupCounterPath, "utf8")).trim(), 10) || 0;
  } catch {}
  await fsp.writeFile(startupCounterPath, String(current + 1), "utf8");
}
const pidPath = ${JSON.stringify(params.pidPath ?? "")};
if (pidPath) {
  await fsp.writeFile(pidPath, String(process.pid), "utf8");
}
const exitMarkerPath = ${JSON.stringify(params.exitMarkerPath ?? "")};
if (exitMarkerPath) {
  process.once("exit", () => {
    try {
      fs.writeFileSync(exitMarkerPath, "exited", "utf8");
    } catch {}
  });
}
const startupDelayMs = ${JSON.stringify(params.startupDelayMs ?? 0)};
if (startupDelayMs > 0) {
  await delay(startupDelayMs);
}

const server = new McpServer({ name: "bundle-probe", version: "1.0.0" });
server.tool("bundle_probe", "Bundle MCP probe", async () => {
  return {
    content: [{ type: "text", text: process.env.BUNDLE_PROBE_TEXT ?? "missing-probe-text" }],
  };
});

await server.connect(new StdioServerTransport());
`,
  );
}

/** Writes a minimal Claude plugin bundle fixture with a bundled MCP config. */
export async function writeClaudeBundle(params: {
  pluginRoot: string;
  serverScriptPath: string;
}): Promise<void> {
  await fs.mkdir(path.join(params.pluginRoot, ".claude-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(params.pluginRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify({ name: "bundle-probe" }, null, 2)}\n`,
    "utf-8",
  );
  await fs.writeFile(
    path.join(params.pluginRoot, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          bundleProbe: {
            command: "node",
            args: [path.relative(params.pluginRoot, params.serverScriptPath)],
            env: {
              BUNDLE_PROBE_TEXT: "FROM-BUNDLE",
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}
