import {
  listConfiguredMcpServers,
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
} from "../../config/mcp-config.js";
import { isInternalMessageChannel } from "../../utils/message-channel.js";
import {
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { parseMcpCommand } from "./mcp-commands.js";

function renderJsonBlock(label: string, value: unknown): string {
  return `${label}\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

export const handleMcpCommand: CommandHandler = async (params, allowTextCommands) => {
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
  const allowInternalReadOnlyShow =
    mcpCommand.action === "show" && isInternalMessageChannel(params.command.channel);
  const nonOwner = allowInternalReadOnlyShow ? null : rejectNonOwnerCommand(params, "/mcp");
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
    const loaded = await listConfiguredMcpServers();
    if (!loaded.ok) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${loaded.error}` },
      };
    }
    if (mcpCommand.name) {
      const server = loaded.mcpServers[mcpCommand.name];
      if (!server) {
        return {
          shouldContinue: false,
          reply: { text: `🔌 No MCP server named "${mcpCommand.name}" in ${loaded.path}.` },
        };
      }
      return {
        shouldContinue: false,
        reply: {
          text: renderJsonBlock(`🔌 MCP server "${mcpCommand.name}" (${loaded.path})`, server),
        },
      };
    }
    if (Object.keys(loaded.mcpServers).length === 0) {
      return {
        shouldContinue: false,
        reply: { text: `🔌 No MCP servers configured in ${loaded.path}.` },
      };
    }
    return {
      shouldContinue: false,
      reply: {
        text: renderJsonBlock(`🔌 MCP servers (${loaded.path})`, loaded.mcpServers),
      },
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
