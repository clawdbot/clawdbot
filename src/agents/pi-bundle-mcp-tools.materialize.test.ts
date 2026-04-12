import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  startSseProbeServer,
  writeBundleProbeMcpServer,
  writeClaudeBundle,
  writeExecutable,
} from "./pi-bundle-mcp-test-harness.js";
import { createBundleMcpToolRuntime } from "./pi-bundle-mcp-tools.js";

const require = createRequire(import.meta.url);
const SDK_SERVER_MCP_PATH = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
const SDK_SERVER_STDIO_PATH = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");

afterEach(async () => {
  await cleanupBundleMcpHarness();
});

async function createBundleProbeRuntime(params?: { reservedToolNames?: string[] }) {
  const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "bundle-probe");
  const serverScriptPath = path.join(pluginRoot, "servers", "bundle-probe.mjs");
  await writeBundleProbeMcpServer(serverScriptPath);
  await writeClaudeBundle({ pluginRoot, serverScriptPath });

  return await createBundleMcpToolRuntime({
    workspaceDir,
    cfg: {
      plugins: {
        entries: {
          "bundle-probe": { enabled: true },
        },
      },
    },
    reservedToolNames: params?.reservedToolNames,
  });
}

describe("createBundleMcpToolRuntime", () => {
  it("loads bundle MCP tools and executes them", async () => {
    const runtime = await createBundleProbeRuntime();

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
      const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-BUNDLE",
      });
      expect(result.details).toEqual({
        mcpServer: "bundleProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("disambiguates bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await createBundleProbeRuntime({
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured stdio MCP tools without a bundle", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
      const result = await runtime.tools[0].execute(
        "call-configured-probe",
        {},
        undefined,
        undefined,
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-CONFIG",
      });
      expect(result.details).toEqual({
        mcpServer: "configuredProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured SSE MCP tools via url", async () => {
    vi.useRealTimers();
    const sseServer = await startSseProbeServer();

    try {
      const workspaceDir = await makeTempDir("openclaw-bundle-mcp-sse-");
      const runtime = await createBundleMcpToolRuntime({
        workspaceDir,
        cfg: {
          mcp: {
            servers: {
              sseProbe: {
                url: `http://127.0.0.1:${sseServer.port}/sse`,
                transport: "sse",
              },
            },
          },
        },
      });

      try {
        expect(runtime.tools.map((tool) => tool.name)).toEqual(["sseProbe__sse_probe"]);
        const result = await runtime.tools[0].execute("call-sse-probe", {}, undefined, undefined);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: "FROM-SSE",
        });
        expect(result.details).toEqual({
          mcpServer: "sseProbe",
          mcpTool: "sse_probe",
        });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await sseServer.close();
    }
  });

  it("returns tools sorted alphabetically for stable prompt-cache keys", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverScriptPath = path.join(workspaceDir, "servers", "multi-tool.mjs");
    // Register tools in non-alphabetical order; runtime must sort them.
    await writeExecutable(
      serverScriptPath,
      `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(SDK_SERVER_MCP_PATH)};
import { StdioServerTransport } from ${JSON.stringify(SDK_SERVER_STDIO_PATH)};
const server = new McpServer({ name: "multi", version: "1.0.0" });
server.tool("zeta", "z", async () => ({ content: [{ type: "text", text: "z" }] }));
server.tool("alpha", "a", async () => ({ content: [{ type: "text", text: "a" }] }));
server.tool("mu", "m", async () => ({ content: [{ type: "text", text: "m" }] }));
await server.connect(new StdioServerTransport());
`,
    );

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            multi: { command: "node", args: [serverScriptPath] },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual([
        "multi__alpha",
        "multi__mu",
        "multi__zeta",
      ]);
    } finally {
      await runtime.dispose();
    }
  });
});
