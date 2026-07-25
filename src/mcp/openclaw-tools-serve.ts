/**
 * Standalone MCP server for selected built-in OpenClaw tools.
 *
 * Run via: node --import tsx src/mcp/openclaw-tools-serve.ts
 * Or: bun src/mcp/openclaw-tools-serve.ts
 */
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import { createSystemAgentTool } from "../agents/tools/system-agent-tool.js";
import type { SystemAgentToolOptions } from "../agents/tools/system-agent-tool.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV,
  resolveToolsMcpAgentSessionKey,
} from "./agent-session-env.js";
import {
  resolveOpenClawToolsMcpSystemAgentApproval,
  resolveOpenClawToolsMcpSystemAgentSurface,
  resolveOpenClawToolsMcpToolSelection,
  type OpenClawToolsMcpToolId,
} from "./openclaw-tools-serve-config.js";
import { connectToolsMcpServerToStdio, createToolsMcpServer } from "./tools-stdio-server.js";

export {
  OPENCLAW_TOOLS_MCP_SYSTEM_AGENT_SURFACE_ENV,
  OPENCLAW_TOOLS_MCP_TOOLS_ENV,
} from "./openclaw-tools-serve-config.js";

export { OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV } from "./agent-session-env.js";

export function resolveOpenClawToolsMcpAgentSessionKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return resolveToolsMcpAgentSessionKey(env);
}

export function resolveOpenClawToolsForMcp(
  params: {
    agentSessionKey?: string;
    tools?: OpenClawToolsMcpToolId[];
    systemAgentSurface?: SystemAgentToolOptions["surface"];
  } = {},
): AnyAgentTool[] {
  const selection = params.tools ?? resolveOpenClawToolsMcpToolSelection();
  return selection.map((tool) => {
    if (tool === "openclaw") {
      return createSystemAgentTool({
        surface: params.systemAgentSurface ?? resolveOpenClawToolsMcpSystemAgentSurface(),
        ...resolveOpenClawToolsMcpSystemAgentApproval(),
      });
    }
    const agentSessionKey = (
      params.agentSessionKey ?? resolveOpenClawToolsMcpAgentSessionKey()
    )?.trim();
    if (!agentSessionKey) {
      throw new Error(`${OPENCLAW_TOOLS_MCP_AGENT_SESSION_KEY_ENV} is required`);
    }
    return createCronTool({ agentSessionKey, creatorToolAllowlist: [{ name: "cron" }] });
  });
}

function createOpenClawToolsMcpServer(
  params: {
    tools?: AnyAgentTool[];
  } = {},
): Server {
  const tools = params.tools ?? resolveOpenClawToolsForMcp();
  return createToolsMcpServer({ name: "openclaw-tools", tools });
}

async function serveOpenClawToolsMcp(): Promise<void> {
  const server = createOpenClawToolsMcpServer();
  await connectToolsMcpServerToStdio(server);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  serveOpenClawToolsMcp().catch((err: unknown) => {
    process.stderr.write(`openclaw-tools-serve: ${formatErrorMessage(err)}\n`);
    process.exit(1);
  });
}
