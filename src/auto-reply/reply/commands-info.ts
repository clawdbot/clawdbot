/** Handles informational commands such as /help, /commands, /tools, and exports. */
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import {
  resolveEffectiveToolInventory,
  resolveEffectiveToolInventoryRuntimeModelContextAsync,
} from "../../agents/tools-effective-inventory.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import {
  listSkillCommandsForAgents,
  resolveSkillCommandInvocation,
} from "../../skills/discovery/chat-commands.js";
import {
  buildCommandsMessage,
  buildCommandsMessagePaginated,
  buildHelpMessage,
  buildToolsMessage,
} from "../status.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { resolveChannelAccountId } from "./channel-context.js";
import {
  commandReply,
  defineAuthorizedTextCommand,
  matchCommandPrefix,
  rejectUnauthorizedCommand,
} from "./command-gates.js";
import { buildExportSessionReply } from "./commands-export-session.js";
import { buildExportTrajectoryCommandReply } from "./commands-export-trajectory.js";
import { buildStatusPluginsReply, buildStatusReply } from "./commands-status.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";
import { extractExplicitGroupId } from "./group-id.js";
import { resolveReplyToMode } from "./reply-threading.js";

async function resolveSkillCommands(
  params: HandleCommandsParams,
  options?: { requireFullList?: boolean },
) {
  if (
    params.skillCommands !== undefined &&
    (!options?.requireFullList || params.skillCommands.length > 0 || !params.loadSkillCommands)
  ) {
    return params.skillCommands;
  }
  if (params.loadSkillCommands) {
    return params.loadSkillCommands();
  }
  const agentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : params.agentId;
  return listSkillCommandsForAgents({
    cfg: params.cfg,
    agentIds: agentId ? [agentId] : undefined,
    sessionEntry: params.sessionEntry,
    sessionKey: params.sessionKey,
  });
}

/** Command handler for /help. */
export const handleHelpCommand: CommandHandler = defineAuthorizedTextCommand(
  { label: "/help", match: (body) => (body === "/help" ? true : null), silentUnauthorized: true },
  (params) => commandReply(buildHelpMessage(params.cfg)),
);

/** Command handler for /commands. */
export const handleCommandsListCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/commands",
    match: (body) => (body === "/commands" ? true : null),
    silentUnauthorized: true,
  },
  async (params) => {
    const agentId = params.sessionKey
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : params.agentId;
    const skillCommands = await resolveSkillCommands(params);
    const surface = params.ctx.Surface;
    const commandPlugin = surface ? getChannelPlugin(surface) : null;
    const paginated = buildCommandsMessagePaginated(params.cfg, skillCommands, {
      page: 1,
      surface,
    });
    const channelData = commandPlugin?.commands?.buildCommandsListChannelData?.({
      currentPage: paginated.currentPage,
      totalPages: paginated.totalPages,
      agentId,
    });
    if (channelData) {
      return {
        shouldContinue: false,
        reply: {
          text: paginated.text,
          channelData,
        },
      };
    }

    return commandReply(buildCommandsMessage(params.cfg, skillCommands, { surface }));
  },
);

function buildSkillCommandUsage(skillCommands: NonNullable<HandleCommandsParams["skillCommands"]>) {
  const lines = ["Usage: /skill <name> [input]"];
  if (skillCommands.length > 0) {
    const names = skillCommands.slice(0, 8).map((command) => command.skillName || command.name);
    lines.push("", `Available: ${names.join(", ")}`);
    if (skillCommands.length > names.length) {
      lines.push(`More: /commands (${skillCommands.length - names.length} more)`);
    } else {
      lines.push("More: /commands");
    }
  } else {
    lines.push("", "Use /commands to list available skill commands.");
  }
  return lines.join("\n");
}

/** Command handler for /skill usage help. */
export const handleSkillCommandUsage: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/skill",
    match: (body) => matchCommandPrefix(body, "/skill"),
    silentUnauthorized: true,
  },
  async (params) => {
    const normalized = params.command.commandBodyNormalized;
    // Bare or unknown /skill commands are deterministic help responses; handling
    // them here avoids falling through into a full agent/model turn.
    const [, rawName] = normalized.match(/^\/skill(?:\s+([^\s]+))?/u) ?? [];
    const skillCommands = await resolveSkillCommands(params, { requireFullList: true });
    if (
      rawName &&
      resolveSkillCommandInvocation({ commandBodyNormalized: normalized, skillCommands })
    ) {
      return null;
    }
    const prefix = rawName ? `Unknown skill: ${rawName}\n\n` : "";
    return commandReply(`${prefix}${buildSkillCommandUsage(skillCommands)}`);
  },
);

/** Command handler for /tools. */
export const handleToolsCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  let verbose;
  if (normalized === "/tools" || normalized === "/tools compact") {
    verbose = false;
  } else if (normalized === "/tools verbose") {
    verbose = true;
  } else if (normalized.startsWith("/tools ")) {
    return { shouldContinue: false, reply: { text: "Usage: /tools [compact|verbose]" } };
  } else {
    return null;
  }
  if (rejectUnauthorizedCommand(params, "/tools")) {
    return { shouldContinue: false };
  }

  try {
    const effectiveAccountId = resolveChannelAccountId({
      cfg: params.cfg,
      ctx: params.ctx,
      command: params.command,
    });
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const sessionBound = Boolean(params.sessionKey);
    const agentId = sessionBound
      ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
      : params.agentId;
    const threadingContext = buildThreadingToolContext({
      sessionCtx: params.ctx,
      config: params.cfg,
      hasRepliedRef: undefined,
    });
    const runtimeModelContext = await resolveEffectiveToolInventoryRuntimeModelContextAsync({
      cfg: params.cfg,
      agentId,
      agentDir: sessionBound ? undefined : params.agentDir,
      workspaceDir: params.workspaceDir,
      modelProvider: params.provider,
      modelId: params.model,
    });
    const result = resolveEffectiveToolInventory({
      cfg: params.cfg,
      agentId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      agentDir: sessionBound ? undefined : params.agentDir,
      modelProvider: params.provider,
      modelId: params.model,
      modelApi: runtimeModelContext.modelApi,
      runtimeModel: runtimeModelContext.runtimeModel,
      messageProvider: params.command.channel,
      senderId: params.command.senderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      accountId: effectiveAccountId,
      currentChannelId: threadingContext.currentChannelId,
      currentThreadTs:
        typeof params.ctx.MessageThreadId === "string" ||
        typeof params.ctx.MessageThreadId === "number"
          ? String(params.ctx.MessageThreadId)
          : undefined,
      currentMessageId: threadingContext.currentMessageId,
      groupId: targetSessionEntry?.groupId ?? extractExplicitGroupId(params.ctx.From),
      groupChannel:
        targetSessionEntry?.groupChannel ?? params.ctx.GroupChannel ?? params.ctx.GroupSubject,
      groupSpace: targetSessionEntry?.space ?? params.ctx.GroupSpace,
      replyToMode: resolveReplyToMode(
        params.cfg,
        params.ctx.OriginatingChannel ?? params.ctx.Provider,
        effectiveAccountId,
        params.ctx.ChatType,
      ),
    });
    return commandReply(buildToolsMessage(result, { verbose }));
  } catch {
    // Inventory resolves in-process after sender authorization; this path cannot receive
    // gateway RPC scope errors, so failures here are local discovery failures.
    return commandReply("Couldn't load available tools right now. Try again in a moment.");
  }
};

/** Command handler for /status. */
export const handleStatusCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/status",
    match: (body, params) => {
      const normalized = body.trim();
      return params.directives.hasStatusDirective ||
        matchCommandPrefix(normalized, "/status") !== null
        ? normalized
        : null;
    },
    silentUnauthorized: true,
  },
  async (params, normalizedStatusCommand) => {
    if (normalizedStatusCommand === "/status plugins") {
      const reply = await buildStatusPluginsReply({
        cfg: params.cfg,
        command: params.command,
        workspaceDir: params.workspaceDir,
      });
      return { shouldContinue: false, reply };
    }
    if (normalizedStatusCommand.startsWith("/status ")) {
      return commandReply("⚠️ Unknown /status subcommand. Try /status or /status plugins.");
    }
    const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
    const reply = await buildStatusReply({
      cfg: params.cfg,
      command: params.command,
      sessionEntry: targetSessionEntry,
      sessionKey: params.sessionKey,
      parentSessionKey: targetSessionEntry?.parentSessionKey ?? params.ctx.ParentSessionKey,
      sessionScope: params.sessionScope,
      storePath: params.storePath,
      provider: params.provider,
      model: params.model,
      contextTokens: params.contextTokens,
      thinkingCatalog: params.thinkingCatalog,
      workspaceDir: params.workspaceDir,
      resolvedThinkLevel: params.resolvedThinkLevel,
      resolvedFastMode: params.resolvedFastMode,
      resolvedVerboseLevel: params.resolvedVerboseLevel,
      resolvedReasoningLevel: params.resolvedReasoningLevel,
      resolvedElevatedLevel: params.resolvedElevatedLevel,
      resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel,
      isGroup: params.isGroup,
      defaultGroupActivation: params.defaultGroupActivation,
      mediaDecisions: params.ctx.MediaUnderstandingDecisions,
    });
    return { shouldContinue: false, reply };
  },
);

/** Command handler for /export-session. */
export const handleExportSessionCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/export-session",
    match: (body) =>
      matchCommandPrefix(body, "/export-session") ?? matchCommandPrefix(body, "/export"),
    ownerOnly: true,
  },
  async (params) => ({ shouldContinue: false, reply: await buildExportSessionReply(params) }),
);

/** Command handler for /export-trajectory. */
export const handleExportTrajectoryCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: "/export-trajectory",
    match: (body) =>
      matchCommandPrefix(body, "/export-trajectory") ?? matchCommandPrefix(body, "/trajectory"),
    ownerOnly: true,
  },
  async (params) => ({
    shouldContinue: false,
    reply: await buildExportTrajectoryCommandReply(params),
  }),
);
