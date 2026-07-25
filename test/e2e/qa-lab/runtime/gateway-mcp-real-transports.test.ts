import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { testing } from "./gateway-mcp-real-transports.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRepoRoot() {
  return tempDirs.make("openclaw-qalab-cli-entry-");
}

async function writeEntry(root: string, relativePath: string) {
  const entryPath = path.join(root, relativePath);
  await mkdir(path.dirname(entryPath), { recursive: true });
  await writeFile(entryPath, "", "utf8");
  return entryPath;
}

describe("gateway MCP real transport producer", () => {
  it("uses the source channel MCP module when build output is absent", async () => {
    const root = createRepoRoot();
    const channelServerPath = await writeEntry(root, "src/mcp/channel-server.ts");

    const mcp = testing.resolveChannelMcpInvocation({
      gatewayToken: "secret-token",
      gatewayUrl: "ws://127.0.0.1:12345",
      repoRoot: root,
      tokenFile: "/tmp/token-file",
    });

    expect(mcp.command).toBe(process.execPath);
    expect(mcp.args.slice(0, 3)).toStrictEqual(["--import", "tsx", "--eval"]);
    expect(mcp.args[3]).toContain(channelServerPath);
    expect(mcp.args[3]).toContain("serveOpenClawChannelMcp");
    expect(mcp.cwd).toBe(root);
    expect(mcp.envPatch).toStrictEqual({
      OPENCLAW_QA_GATEWAY_TOKEN: "secret-token",
      OPENCLAW_QA_GATEWAY_URL: "ws://127.0.0.1:12345",
    });
  });

  it("uses the packaged CLI for channel MCP when build output exists", async () => {
    const root = createRepoRoot();
    const distEntry = await writeEntry(root, "dist/index.js");
    await writeEntry(root, "src/mcp/channel-server.ts");

    const mcp = testing.resolveChannelMcpInvocation({
      gatewayToken: "secret-token",
      gatewayUrl: "ws://127.0.0.1:12345",
      repoRoot: root,
      tokenFile: "/tmp/token-file",
    });

    expect(mcp.args).toStrictEqual([
      distEntry,
      "mcp",
      "serve",
      "--url",
      "ws://127.0.0.1:12345",
      "--token-file",
      "/tmp/token-file",
      "--claude-channel-mode",
      "off",
      "--verbose",
    ]);
    expect(mcp.envPatch).toStrictEqual({});
  });

  it("isolates the source plugin-tools MCP invocation", () => {
    const root = createRepoRoot();
    const invocation = testing.resolvePluginToolsMcpInvocation({
      configPath: "/tmp/plugin-tools/openclaw.json",
      homeDir: "/tmp/plugin-tools/home",
      repoRoot: root,
      stateDir: "/tmp/plugin-tools/state",
    });

    expect(invocation).toStrictEqual({
      command: process.execPath,
      args: [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        path.join(root, "src/mcp/plugin-tools-serve.ts"),
      ],
      cwd: root,
      env: {
        HOME: "/tmp/plugin-tools/home",
        OPENCLAW_CONFIG_PATH: "/tmp/plugin-tools/openclaw.json",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_HOME: "/tmp/plugin-tools/home",
        OPENCLAW_STATE_DIR: "/tmp/plugin-tools/state",
      },
    });
  });

  it("sets explicit timeouts for each plugin-tools MCP request", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const listTools = vi.fn().mockResolvedValue({
      tools: [{ name: "memory_search" }],
    });
    const callTool = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "MCP fact: the codename is ORBIT-9." }],
      isError: false,
    });
    const client = { callTool, connect, listTools } as unknown as Client;
    const transport = { pid: 42 } as StdioClientTransport;

    await expect(testing.runMcpPluginToolsClientProof({ client, transport })).resolves.toContain(
      "real plugin-tools pid=42",
    );

    expect(connect).toHaveBeenCalledWith(transport, { timeout: 180_000 });
    expect(listTools).toHaveBeenCalledWith({}, { timeout: 180_000 });
    expect(callTool).toHaveBeenCalledWith(
      {
        name: "memory_search",
        arguments: { query: "ORBIT-9 codename", maxResults: 3 },
      },
      undefined,
      { timeout: 180_000 },
    );
  });
});
