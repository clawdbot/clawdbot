import { createRequire } from "node:module";
import {
  writeBundleProbeMcpServer,
  writeClaudeBundle,
  writeExecutable,
} from "./bundle-mcp-shared.test-harness.js";

const require = createRequire(import.meta.url);
const SDK_CLIENT_INDEX_PATH = require.resolve("@modelcontextprotocol/sdk/client/index.js");
const SDK_CLIENT_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/client/stdio.js");

export { writeBundleProbeMcpServer, writeClaudeBundle };

export async function writeFakeClaudeLiveCli(params: {
  filePath: string;
  pidPath?: string;
}): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { Client } from ${JSON.stringify(SDK_CLIENT_INDEX_PATH)};
import { StdioClientTransport } from ${JSON.stringify(SDK_CLIENT_STDIO_PATH)};

const pidPath = ${JSON.stringify(params.pidPath ?? "")};
if (pidPath) {
  await fs.writeFile(pidPath, String(process.pid), "utf-8");
}

function readArg(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) {
      return args[i + 1];
    }
    if (arg.startsWith(name + "=")) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

async function readBundleProbeText(mcpConfigPath) {
  const raw = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
  const servers = raw?.mcpServers ?? raw?.servers ?? {};
  const server = servers.bundleProbe ?? Object.values(servers)[0];
  if (!server || typeof server !== "object") {
    throw new Error("missing bundleProbe MCP server");
  }
  const transport = new StdioClientTransport({
    command: server.command,
    args: Array.isArray(server.args) ? server.args : [],
    env: server.env && typeof server.env === "object" ? server.env : undefined,
    cwd:
      typeof server.cwd === "string"
        ? server.cwd
        : typeof server.workingDirectory === "string"
          ? server.workingDirectory
          : undefined,
  });
  const client = new Client({ name: "fake-live-claude", version: "1.0.0" });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name: "bundle_probe", arguments: {} });
    return Array.isArray(result.content)
      ? result.content
          .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
          .map((entry) => entry.text)
          .join("\\n")
      : "";
  } finally {
    await transport.close();
  }
}

const mcpConfigPath = readArg("--mcp-config");
if (!mcpConfigPath) {
  throw new Error("missing --mcp-config");
}

const keepAlive = setInterval(() => {}, 1000);
const input = readline.createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    if (!line.trim()) {
      continue;
    }
    const text = await readBundleProbeText(mcpConfigPath);
    process.stdout.write(
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: readArg("--session-id") ?? randomUUID(),
      }) + "\\n",
    );
    process.stdout.write(
      JSON.stringify({
        type: "result",
        session_id: readArg("--session-id") ?? randomUUID(),
        result: "LIVE BUNDLE MCP OK " + text,
      }) + "\\n",
    );
  }
} finally {
  input.close();
  clearInterval(keepAlive);
}
`,
  );
}

export async function writeFakeClaudeCli(filePath: string): Promise<void> {
  await writeExecutable(
    filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import readline from "node:readline/promises";
import { Client } from ${JSON.stringify(SDK_CLIENT_INDEX_PATH)};
import { StdioClientTransport } from ${JSON.stringify(SDK_CLIENT_STDIO_PATH)};

function readArg(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === name) {
      return args[i + 1];
    }
    if (arg.startsWith(name + "=")) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

const mcpConfigPath = readArg("--mcp-config");
if (!mcpConfigPath) {
  throw new Error("missing --mcp-config");
}

const input = readline.createInterface({ input: process.stdin });
try {
  for await (const line of input) {
    if (line.trim()) {
      break;
    }
  }
} finally {
  input.close();
}

const raw = JSON.parse(await fs.readFile(mcpConfigPath, "utf-8"));
const servers = raw?.mcpServers ?? raw?.servers ?? {};
const server = servers.bundleProbe ?? Object.values(servers)[0];
if (!server || typeof server !== "object") {
  throw new Error("missing bundleProbe MCP server");
}

const transport = new StdioClientTransport({
  command: server.command,
  args: Array.isArray(server.args) ? server.args : [],
  env: server.env && typeof server.env === "object" ? server.env : undefined,
  cwd:
    typeof server.cwd === "string"
      ? server.cwd
      : typeof server.workingDirectory === "string"
        ? server.workingDirectory
        : undefined,
});
const client = new Client({ name: "fake-claude", version: "1.0.0" });
await client.connect(transport);
const tools = await client.listTools();
if (!tools.tools.some((tool) => tool.name === "bundle_probe")) {
  throw new Error("bundle_probe tool not exposed");
}
const result = await client.callTool({ name: "bundle_probe", arguments: {} });
await transport.close();

const text = Array.isArray(result.content)
  ? result.content
      .filter((entry) => entry?.type === "text" && typeof entry.text === "string")
      .map((entry) => entry.text)
      .join("\\n")
  : "";

process.stdout.write(
  JSON.stringify({
    type: "result",
    session_id: readArg("--session-id") ?? randomUUID(),
    result: "BUNDLE MCP OK " + text,
  }) + "\\n",
);
`,
  );
}
