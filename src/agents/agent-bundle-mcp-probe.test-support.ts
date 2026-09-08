import fs from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

export async function probeMcpServer(runtime: SessionMcpRuntime, serverName: string, input = {}) {
  const result = await runtime.callTool(serverName, "probe", input);
  const text = result.content.find((item) => item.type === "text")?.text;
  return JSON.parse(String(text)) as { pid: number; label: string; lists: number };
}

export async function createMcpProbeFixture(tempDirs: string[]) {
  const workspaceDir = makeTempDir(tempDirs, "mcp-reload-");
  const serverPath = path.join(workspaceDir, "server.mjs");
  await fs.writeFile(
    serverPath,
    `
import readline from "node:readline";
import fs from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
let lists = 0;
let toolName = "probe";
async function handle(message) {
  let result;
  if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "reload-probe", version: "1" } };
  if (message.method === "tools/list") { lists++; result = { tools: [{ name: toolName, inputSchema: { type: "object" } }] }; }
  if (message.method === "tools/call") {
    if (message.params.arguments?.changeTools) {
      toolName = "updated_probe";
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }) + "\\n");
    }
    if (message.params.arguments?.hold) {
      const marker = message.params.arguments.hold;
      await fs.writeFile(marker + ".started", "started");
      while (!(await fs.stat(marker).catch(() => undefined))) await setTimeout(10);
    }
    result = { content: [{ type: "text", text: JSON.stringify({ pid: process.pid, label: process.argv[2], lists }) }] };
  }
  if (result) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
}
for await (const line of readline.createInterface({ input: process.stdin })) void handle(JSON.parse(line));
`,
  );
  const config = (label = "old"): OpenClawConfig => ({
    plugins: { enabled: false },
    mcp: {
      servers: {
        healthy: { command: process.execPath, args: [serverPath, "healthy"] },
        changed: { command: process.execPath, args: [serverPath, label] },
      },
    },
  });
  return {
    config,
    params: { sessionId: "reload-test", workspaceDir, manifestRegistry: { plugins: [] } },
  };
}
