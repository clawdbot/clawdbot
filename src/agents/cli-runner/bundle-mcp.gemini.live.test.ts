import { execFile } from "node:child_process";
import http from "node:http";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { isLiveTestEnabled } from "../live-test-helpers.js";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";

const execFileAsync = promisify(execFile);
const LIVE = isLiveTestEnabled(["OPENCLAW_LIVE_CLI_MCP_GEMINI"]);
const describeLive = LIVE ? describe : describe.skip;

async function canRunGemini(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

async function startLocalStreamableHttpMcpServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const mcpServer = new McpServer({ name: "openclaw-gemini-live-probe", version: "1.0.0" });
  mcpServer.tool("openclaw_live_probe", "OpenClaw Gemini MCP live probe", async () => ({
    content: [{ type: "text", text: "ok" }],
  }));

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await mcpServer.connect(transport);
  const httpServer = http.createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) {
      res.writeHead(404).end();
      return;
    }
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: async () => {
      await transport.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describeLive("Gemini CLI MCP settings smoke", () => {
  it("connects to an OpenClaw-configured streamable-http server", async () => {
    const geminiCommand = process.env.OPENCLAW_LIVE_GEMINI_COMMAND ?? "gemini";
    if (!(await canRunGemini(geminiCommand))) {
      console.warn(`Skipping Gemini MCP live smoke: ${geminiCommand} is not runnable.`);
      return;
    }

    const probeServer = await startLocalStreamableHttpMcpServer();
    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "gemini-system-settings",
      backend: {
        command: geminiCommand,
        args: ["--prompt", "{prompt}"],
      },
      workspaceDir: process.cwd(),
      config: {
        plugins: { enabled: false },
        mcp: {
          servers: {
            openclawLiveProbe: {
              transport: "streamable-http",
              url: probeServer.url,
            },
          },
        },
      },
    });

    try {
      const result = await execFileAsync(geminiCommand, ["--debug", "mcp", "list"], {
        env: {
          ...process.env,
          ...prepared.env,
        },
        timeout: 45_000,
        maxBuffer: 1024 * 1024,
      });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output).toContain("openclawLiveProbe");
      expect(output).toMatch(/\(http\)|type:\s*http|http/i);
      expect(output).not.toContain("transport");
    } finally {
      await prepared.cleanup?.();
      await probeServer.close();
    }
  }, 60_000);
});
