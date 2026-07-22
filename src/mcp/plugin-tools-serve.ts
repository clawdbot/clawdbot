/**
 * Standalone MCP server that exposes OpenClaw plugin-registered tools
 * (e.g. memory-lancedb's memory_recall, memory_store, memory_forget)
 * so ACP sessions running Claude Code can use them.
 *
 * Run via: node --import tsx src/mcp/plugin-tools-serve.ts
 * Or: bun src/mcp/plugin-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { pickSandboxToolPolicy } from "../agents/sandbox-tool-policy.js";
import {
  collectExplicitAllowlist,
  collectExplicitDenylist,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
} from "../agents/tool-policy.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getRuntimeConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { routeLogsToStderr } from "../logging/console.js";
import { ensureStandalonePluginToolRegistryLoaded, resolvePluginTools } from "../plugins/tools.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
  resolveToolsMcpAgentSessionKey,
} from "./agent-session-env.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

function resolvePluginToolPolicy(config: OpenClawConfig): {
  toolAllowlist?: string[];
  toolDenylist?: string[];
} {
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(config.tools?.profile, config.tools?.profiles),
    config.tools?.alsoAllow,
  );
  const globalPolicy = pickSandboxToolPolicy(config.tools);
  const toolAllowlist = collectExplicitAllowlist([profilePolicy, globalPolicy]);
  const toolDenylist = collectExplicitDenylist([profilePolicy, globalPolicy]);
  return {
    ...(toolAllowlist.length > 0 ? { toolAllowlist } : {}),
    ...(toolDenylist.length > 0 ? { toolDenylist } : {}),
  };
}

export function resolvePluginToolsForMcp(params: {
  config: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool[] {
  const agentSessionKey = (params.agentSessionKey ?? resolveToolsMcpAgentSessionKey())?.trim();
  const parsedSession = agentSessionKey ? parseAgentSessionKey(agentSessionKey) : undefined;
  if (agentSessionKey && !parsedSession) {
    throw new Error(
      `${OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV} must be a canonical agent session key`,
    );
  }
  const context = {
    config: params.config,
    ...(parsedSession ? { agentId: parsedSession.agentId, sessionKey: agentSessionKey } : {}),
  };
  const pluginToolPolicy = resolvePluginToolPolicy(params.config);
  const runtimeRegistry = ensureStandalonePluginToolRegistryLoaded({
    context,
    ...pluginToolPolicy,
  });
  return resolvePluginTools({
    context,
    ...pluginToolPolicy,
    suppressNameConflicts: true,
    runtimeRegistry,
  });
}

export function createPluginToolsMcpServer(
  params: {
    config?: OpenClawConfig;
    tools?: AnyAgentTool[];
    agentSessionKey?: string;
  } = {},
): Server {
  const cfg = params.config ?? getRuntimeConfig();
  const tools =
    params.tools ??
    resolvePluginToolsForMcp({ config: cfg, agentSessionKey: params.agentSessionKey });
  return createToolsMcpServer({ name: "openclaw-plugin-tools", tools });
}

export async function servePluginToolsMcp(): Promise<void> {
  // MCP stdio requires stdout to stay protocol-only, including during plugin
  // tool discovery before the transport is connected.
  routeLogsToStderr();

  const config = getRuntimeConfig();
  const tools = resolvePluginToolsForMcp({ config });
  const server = createPluginToolsMcpServer({ config, tools });
  if (tools.length === 0) {
    process.stderr.write("plugin-tools-serve: no plugin tools found\n");
  }

  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  servePluginToolsMcp().catch((err: unknown) => {
    process.stderr.write(`plugin-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
