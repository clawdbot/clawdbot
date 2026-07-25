/** Handles /mcp commands for showing and mutating configured MCP servers. */
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "../../config/mcp-config.js";
import { redactSensitiveArgv } from "../../config/redact-argv.js";
import { REDACTED_SENTINEL, redactConfigObject } from "../../config/redact-snapshot.js";
import { buildConfigSchema } from "../../config/schema.js";
import type { ExecApprovalRequest } from "../../infra/exec-approvals.js";
import type { ReplyPayload } from "../types.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import {
  deliverPrivateCommandReply,
  readCommandDeliveryTarget,
  readCommandMessageThreadId,
  resolvePrivateCommandApprovalRouteExpiresAtMs,
  resolvePrivateCommandRouteTargets,
  type PrivateCommandRouteTarget,
} from "./commands-private-route.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { parseMcpCommand } from "./mcp-commands.js";

const MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE =
  "I couldn't find a private owner route for MCP configuration. Run /mcp show from an owner DM so sensitive server details are not posted in this chat.";
const MCP_SHOW_PRIVATE_ROUTE_ACK =
  "MCP server configuration is sensitive. I sent the details to the owner privately.";

type McpCommandDeps = {
  resolvePrivateMcpTargets: (params: HandleCommandsParams) => Promise<PrivateCommandRouteTarget[]>;
  deliverPrivateMcpReply: (params: {
    commandParams: HandleCommandsParams;
    targets: PrivateCommandRouteTarget[];
    reply: ReplyPayload;
  }) => Promise<boolean>;
};

const defaultMcpCommandDeps: McpCommandDeps = {
  resolvePrivateMcpTargets: resolvePrivateMcpTargetsForCommand,
  deliverPrivateMcpReply: deliverPrivateCommandReply,
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
    buildConfigSchema().uiHints,
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

async function resolvePrivateMcpTargetsForCommand(
  params: HandleCommandsParams,
): Promise<PrivateCommandRouteTarget[]> {
  return await resolvePrivateCommandRouteTargets({
    commandParams: params,
    request: buildMcpShowPrivateRouteRequest(params),
  });
}

function buildMcpShowPrivateRouteRequest(params: HandleCommandsParams): ExecApprovalRequest {
  const now = Date.now();
  const agentId =
    params.agentId ??
    resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
    });
  return {
    id: "mcp-show-private-route",
    request: {
      command: params.command.commandBodyNormalized,
      agentId,
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      turnSourceChannel: params.command.channel,
      turnSourceTo: readCommandDeliveryTarget(params) ?? null,
      turnSourceAccountId: params.ctx.AccountId ?? null,
      turnSourceThreadId: readCommandMessageThreadId(params) ?? null,
    },
    createdAtMs: now,
    expiresAtMs: resolvePrivateCommandApprovalRouteExpiresAtMs(now),
  };
}

async function deliverGroupMcpShowReplyPrivately(
  deps: McpCommandDeps,
  params: HandleCommandsParams,
  name?: string,
) {
  const targets = await deps.resolvePrivateMcpTargets(params);
  if (targets.length === 0) {
    return {
      shouldContinue: false,
      reply: { text: MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE },
    };
  }
  const privateReply = await buildMcpShowReply(name);
  for (const target of targets) {
    if (
      await deps.deliverPrivateMcpReply({
        commandParams: params,
        targets: [target],
        reply: privateReply,
      })
    ) {
      return {
        shouldContinue: false,
        reply: { text: MCP_SHOW_PRIVATE_ROUTE_ACK },
      };
    }
  }
  return {
    shouldContinue: false,
    reply: { text: MCP_SHOW_PRIVATE_ROUTE_UNAVAILABLE },
  };
}

/** Creates an MCP command handler with injectable private-route dependencies. */
function createMcpCommandHandler(deps: Partial<McpCommandDeps> = {}): CommandHandler {
  const resolvedDeps: McpCommandDeps = {
    ...defaultMcpCommandDeps,
    ...deps,
  };
  return async (params, allowTextCommands) => {
    if (!allowTextCommands) {
      return null;
    }
    const mcpCommand = parseMcpCommand(params.command.commandBodyNormalized);
    if (!mcpCommand) {
      return null;
    }
    const unauthorized = rejectUnauthorizedCommand(params, "/mcp");
    if (unauthorized) {
      return unauthorized;
    }
    const nonOwner = rejectNonOwnerCommand(params, "/mcp");
    if (nonOwner) {
      return nonOwner;
    }
    const disabled = requireCommandFlagEnabled(params.cfg, {
      label: "/mcp",
      configKey: "mcp",
    });
    if (disabled) {
      return disabled;
    }
    if (mcpCommand.action === "error") {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${mcpCommand.message}` },
      };
    }

    if (mcpCommand.action === "show") {
      if (params.isGroup) {
        return await deliverGroupMcpShowReplyPrivately(resolvedDeps, params, mcpCommand.name);
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
        return {
          shouldContinue: false,
          reply: { text: `⚠️ ${result.error}` },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: `🔌 MCP server "${mcpCommand.name}" saved to ${result.path}.`,
        },
      };
    }

    const result = await unsetConfiguredMcpServer({ name: mcpCommand.name });
    if (!result.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${result.error}` },
      };
    }
    if (!result.removed) {
      return {
        shouldContinue: false,
        reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${result.path}.` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `🔌 MCP server "${mcpCommand.name}" removed from ${result.path}.` },
    };
  };
}

/** Command handler for /mcp show/set/unset operations. */
export const handleMcpCommand: CommandHandler = createMcpCommandHandler();
