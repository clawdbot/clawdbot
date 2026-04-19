import fs from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  writeBundleProbeMcpServer,
  writeClaudeBundle,
  writeExecutable,
} from "./bundle-mcp-shared.test-harness.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_SSE_PATH = require.resolve("@modelcontextprotocol/sdk/server/sse.js");

const tempDirs: string[] = [];

export async function cleanupBundleMcpHarness(): Promise<void> {
  const { __testing } = await import("./pi-bundle-mcp-tools.js");
  await __testing.resetSessionMcpRuntimeManager();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
}

export async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export { writeBundleProbeMcpServer, writeClaudeBundle, writeExecutable };

export async function waitForFileText(filePath: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const content = await fs.readFile(filePath, "utf8").catch(() => undefined);
    if (content != null) {
      return content;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

export async function startSseProbeServer(
  probeText = "FROM-SSE",
): Promise<{ port: number; close: () => Promise<void> }> {
  const { McpServer } = await import(SDK_SERVER_MCP_PATH);
  const { SSEServerTransport } = await import(SDK_SERVER_SSE_PATH);

  const mcpServer = new McpServer({ name: "sse-probe", version: "1.0.0" });
  mcpServer.tool("sse_probe", "SSE MCP probe", async () => {
    return {
      content: [{ type: "text", text: probeText }],
    };
  });

  let sseTransport:
    | {
        handlePostMessage: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
      }
    | undefined;
  const httpServer = http.createServer(async (req, res) => {
    if (req.url === "/sse") {
      sseTransport = new SSEServerTransport("/messages", res);
      await mcpServer.connect(sseTransport);
    } else if (req.url?.startsWith("/messages") && req.method === "POST") {
      if (sseTransport) {
        await sseTransport.handlePostMessage(req, res);
      } else {
        res.writeHead(400).end("No SSE session");
      }
    } else {
      res.writeHead(404).end();
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
