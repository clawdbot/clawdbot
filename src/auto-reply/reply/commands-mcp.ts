/** Handles /mcp commands for showing and mutating configured MCP servers. */
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "../../agents/mcp-config-mutation.js";
import { listConfiguredMcpServers } from "../../config/mcp-config.js";
import { redactSensitiveArgv } from "../../config/redact-argv.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../../config/redact-snapshot.js";
import { buildConfigSchemaCore } from "../../config/schema.js";
import type { ReplyPayload } from "../types.js";
import {
  commandReply,
  defineAuthorizedTextCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import {
  buildPrivateCommandApprovalRequest,
  deliverPrivateCommandReply,
  resolvePrivateCommandRouteTargets,
} from "./commands-private-route.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { parseMcpCommand } from "./mcp-commands.js";

const MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner route for MCP configuration. Run /mcp show from an owner DM so sensitive server details are not posted in this chat.";
const MCP_SHOW_PRIVATE_ROUTE_REPLIES = {
  delivered: "MCP server configuration is sensitive. I sent the details to the owner privately.",
  pending:
    "MCP server configuration is sensitive. Private delivery is pending; I can't confirm receipt yet.",
  suppressed:
    "MCP server configuration is sensitive. Private delivery was suppressed; no details were sent.",
  failed: MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE,
};

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function redactMcpServerArgsForDisplay(server: unknown): unknown {
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    return server;
  }
  const record = server as Record<string, unknown>;
  if (!Array.isArray(record.args) || !record.args.every((arg) => typeof arg === "string")) {
    return server;
  }
  return {
    ...record,
    args: redactSensitiveArgv(record.args, REDACTED_SENTINEL),
  };
}

/** Redact MCP server secrets before chat display. */
function redactMcpServersForDisplay(servers: Record<string, unknown>): Record<string, unknown> {
  const argvRedacted = Object.fromEntries(
    Object.entries(servers).map(([name, server]) => [name, redactMcpServerArgsForDisplay(server)]),
  );
  const redactedRoot = redactConfigObject(
    { mcp: { servers: argvRedacted } },
    buildConfigSchemaCore().uiHints,
  ) as {
    mcp?: { servers?: Record<string, unknown> };
  };
  return redactedRoot.mcp?.servers ?? {};
}

async function buildMcpShowReply(name?: string): Promise<ReplyPayload> {
  const loaded = await listConfiguredMcpServers();
  if (!loaded.ok) {
    return { text: `⚠️ ${loaded.error}` };
  }
  if (name) {
    const server = loaded.mcpServers[name];
    if (!server) {
      return { text: `🔌 No MCP server named "${name}" in ${loaded.path}.` };
    }
    const redactedServer = redactMcpServersForDisplay({
      [name]: server,
    })[name];
    return {
      text: renderJsonBlock(`🔌 MCP server "${name}" (${loaded.path})`, redactedServer),
    };
  }
  if (Object.keys(loaded.mcpServers).length === 0) {
    return { text: `🔌 No MCP servers configured in ${loaded.path}.` };
  }
  return {
    text: renderJsonBlock(
      `🔌 MCP servers (${loaded.path})`,
      redactMcpServersForDisplay(loaded.mcpServers),
    ),
  };
}

async function deliverGroupMcpShowReplyPrivately(params: HandleCommandsParams, name?: string) {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  const targets = await resolvePrivateCommandRouteTargets({
    commandParams: params,
    request: buildPrivateCommandApprovalRequest({
      commandParams: params,
      id: "mcp-show-private-route",
      command: params.command.commandBodyNormalized,
      agentId,
      createdAtMs: now,
    }),
  });
  if (targets.length === 0) {
    return commandReply(MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE);
  }
  const privateReply = await buildMcpShowReply(name);
  const outcome = await deliverPrivateCommandReply({
    commandParams: params,
    targets,
    reply: privateReply,
  });
  return commandReply(MCP_SHOW_PRIVATE_ROUTE_REPLIES[outcome]);
}

/** Command handler for /mcp show/set/unset operations. */
export const handleMcpCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/mcp", match: parseMcpCommand, ownerOnly: true },
  async (params, mcpCommand) => {
    const disabled = requireCommandFlagEnabled(params.cfg, {
      label: "/mcp",
      configKey: "mcp",
    });
    if (disabled) {
      return disabled;
    }
    if (mcpCommand.action === "error") {
      return commandReply(`⚠️ ${mcpCommand.message}`);
    }

    if (mcpCommand.action === "show") {
      if (params.isGroup) {
        return await deliverGroupMcpShowReplyPrivately(params, mcpCommand.name);
      }
      return {
        shouldContinue: false,
        reply: await buildMcpShowReply(mcpCommand.name),
      };
    }

    const missingAdminScope = requireGatewayClientScope(params, {
      label: "/mcp write",
      allowedScopes: ["operator.admin"],
      missingText: "❌ /mcp set|unset requires operator.admin for gateway clients.",
    });
    if (missingAdminScope) {
      return missingAdminScope;
    }

    if (mcpCommand.action === "set") {
      const result = await setConfiguredMcpServer({
        name: mcpCommand.name,
        server: mcpCommand.value,
      });
      if (!result.ok) {
        return commandReply(`⚠️ ${result.error}`);
      }
      return commandReply(`🔌 MCP server "${mcpCommand.name}" saved to ${result.path}.`);
    }

    const result = await unsetConfiguredMcpServer({ name: mcpCommand.name });
    if (!result.ok) {
      return commandReply(`⚠️ ${result.error}`);
    }
    if (!result.removed) {
      return commandReply(`🔌 No MCP server named "${mcpCommand.name}" in ${result.path}.`);
    }
    return commandReply(`🔌 MCP server "${mcpCommand.name}" removed from ${result.path}.`);
  },
);
