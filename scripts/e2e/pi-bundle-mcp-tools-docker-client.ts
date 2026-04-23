import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { materializeBundleMcpToolsForRun } from "../../src/agents/pi-bundle-mcp-materialize.ts";
import {
  disposeAllSessionMcpRuntimes,
  getOrCreateSessionMcpRuntime,
} from "../../src/agents/pi-bundle-mcp-runtime.ts";
import { applyFinalEffectiveToolPolicy } from "../../src/agents/pi-embedded-runner/effective-tool-policy.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { getPluginToolMeta } from "../../src/plugins/tools.ts";

const require = createRequire(import.meta.url);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function writeProbeServer(serverPath: string) {
  const sdkMcpServerPath = require.resolve("@modelcontextprotocol/sdk/server/mcp.js");
  const sdkStdioServerPath = require.resolve("@modelcontextprotocol/sdk/server/stdio.js");
  await fs.writeFile(
    serverPath,
    `#!/usr/bin/env node
import { McpServer } from ${JSON.stringify(sdkMcpServerPath)};
import { StdioServerTransport } from ${JSON.stringify(sdkStdioServerPath)};

const server = new McpServer({ name: "pi-bundle-mcp-tools-probe", version: "1.0.0" });
server.tool("docker_probe", "Docker Pi MCP tool availability probe", async () => ({
  content: [{ type: "text", text: "pi-bundle-mcp-tools-ok" }],
}));

await server.connect(new StdioServerTransport());
`,
    { encoding: "utf-8", mode: 0o755 },
  );
}

function applyPolicy(params: {
  tools: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>["tools"];
  config: OpenClawConfig;
}) {
  const warnings: string[] = [];
  return {
    tools: applyFinalEffectiveToolPolicy({
      bundledTools: params.tools,
      config: params.config,
      sessionKey: "agent:main:docker-pi-bundle-mcp",
      agentId: "main",
      senderIsOwner: true,
      warn: (message) => {
        warnings.push(message);
      },
    }),
    warnings,
  };
}

async function main() {
  const stateDir =
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    path.join(os.tmpdir(), `openclaw-pi-bundle-mcp-${process.pid}`);
  const probeDir = path.join(stateDir, "pi-bundle-mcp-tools");
  const serverPath = path.join(probeDir, "probe-server.mjs");
  await fs.mkdir(probeDir, { recursive: true });
  await writeProbeServer(serverPath);

  const cfg: OpenClawConfig = {
    tools: {
      profile: "coding",
    },
    mcp: {
      servers: {
        dockerProbe: {
          command: "node",
          args: [serverPath],
          cwd: probeDir,
          connectionTimeoutMs: 5000,
        },
      },
    },
  };

  try {
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: `docker-pi-bundle-mcp-${randomUUID()}`,
      sessionKey: "agent:main:docker-pi-bundle-mcp",
      workspaceDir: probeDir,
      cfg,
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    const probeTool = materialized.tools.find((tool) => tool.name === "dockerProbe__docker_probe");
    assert(probeTool, "expected dockerProbe__docker_probe to materialize");
    assert(
      getPluginToolMeta(probeTool)?.pluginId === "bundle-mcp",
      "expected materialized MCP tool to be tagged as bundle-mcp",
    );

    const result = await probeTool.execute("docker-mcp-probe", {}, undefined, undefined);
    assert(
      result.content.some((item) => item.type === "text" && item.text === "pi-bundle-mcp-tools-ok"),
      "expected materialized MCP tool execution result",
    );

    const coding = applyPolicy({ tools: materialized.tools, config: cfg });
    assert(
      coding.tools.some((tool) => tool.name === probeTool.name),
      "expected coding profile to keep bundle MCP tools",
    );

    const messaging = applyPolicy({
      tools: materialized.tools,
      config: { ...cfg, tools: { profile: "messaging" } },
    });
    assert(
      messaging.tools.some((tool) => tool.name === probeTool.name),
      "expected messaging profile to keep bundle MCP tools",
    );

    const minimal = applyPolicy({
      tools: materialized.tools,
      config: { ...cfg, tools: { profile: "minimal" } },
    });
    assert(minimal.tools.length === 0, "expected minimal profile to filter bundle MCP tools");

    const denied = applyPolicy({
      tools: materialized.tools,
      config: { ...cfg, tools: { profile: "coding", deny: ["bundle-mcp"] } },
    });
    assert(denied.tools.length === 0, "expected tools.deny bundle-mcp to filter MCP tools");

    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          tool: probeTool.name,
          profileCounts: {
            coding: coding.tools.length,
            messaging: messaging.tools.length,
            minimal: minimal.tools.length,
            denied: denied.tools.length,
          },
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    await disposeAllSessionMcpRuntimes();
  }
}

await main();
