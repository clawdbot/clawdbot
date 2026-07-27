/**
 * Plugin Command Registry
 *
 * Manages commands registered by plugins that bypass the LLM agent.
 * These commands are processed before built-in commands and before agent invocation.
 */

import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveBoundAgentIdForSession } from "../agents/session-agent-binding.js";
import { resolveConversationBindingContext } from "../channels/conversation-binding-context.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE, isOperatorScope } from "../gateway/operator-scopes.js";
import { logVerbose } from "../globals.js";
import {
  clearPluginCommands,
  isReservedCommandName,
  listPluginInvocationKeys,
  pluginCommandSupportsChannel,
  registerPluginCommand,
} from "./command-registration.js";
import {
  canExposeSenderIsOwner,
  isTrustedReservedCommandOwner,
  listRegisteredPluginAgentPromptGuidance,
  pluginCommands,
  setPluginCommandRegistryLocked,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { getActivePluginChannelRegistry } from "./runtime.js";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  PluginCommandResult,
} from "./types.js";

// Maximum allowed length for command arguments (defense in depth)
const MAX_ARGS_LENGTH = 4096;

export { clearPluginCommands, listRegisteredPluginAgentPromptGuidance, registerPluginCommand };

/**
 * Check if a command body matches a registered plugin command.
 * Returns the command definition and parsed args if matched.
 *
 * Note: If a command has `acceptsArgs: false` and the user provides arguments,
 * the command will not match. This allows the message to fall through to
 * built-in handlers or the agent. Document this behavior to plugin authors.
 */
export function matchPluginCommand(
  commandBody: string,
  options: { channel?: string } = {},
): { command: RegisteredPluginCommand; args?: string } | null {
  const trimmed = commandBody.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Accept whitespace after the slash so `/ pair qr` keeps `/pair` ownership.
  const commandMatch = trimmed.match(/^\/\s*([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!commandMatch) {
    return null;
  }
  const commandName = `/${commandMatch[1]}`;
  const args = commandMatch[2]?.trim();

  const key = normalizeLowercaseStringOrEmpty(commandName);
  const alternateKeys = [key];
  if (key.includes("_")) {
    alternateKeys.push(key.replace(/_/g, "-"));
  }
  if (key.includes("-")) {
    alternateKeys.push(key.replace(/-/g, "_"));
  }
  const command =
    alternateKeys
      .map(
        (candidateKey) =>
          pluginCommands.get(candidateKey) ??
          Array.from(pluginCommands.values()).find((candidate) =>
            listPluginInvocationNames(candidate).includes(candidateKey),
          ),
      )
      .filter((candidate) => candidate && pluginCommandSupportsChannel(candidate, options.channel))
      .find(Boolean) ?? null;

  if (!command) {
    return null;
  }

  // If command doesn't accept args but args were provided, don't match
  if (args && !command.acceptsArgs) {
    return null;
  }

  return { command, args: args || undefined };
}

/**
 * Sanitize command arguments to prevent injection attacks.
 * Removes control characters and enforces length limits.
 */
function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }

  // Remove control characters (except newlines and tabs which may be intentional)
  let sanitized = "";
  for (const char of truncateUtf16Safe(args, MAX_ARGS_LENGTH)) {
    const code = char.charCodeAt(0);
    const isControl = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || code === 0x7f;
    if (!isControl) {
      sanitized += char;
    }
  }
  return sanitized;
}

function resolveBindingConversationFromCommand(params: {
  config?: OpenClawConfig;
  channel: string;
  senderId?: string;
  from?: string;
  to?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
}): {
  channel: string;
  accountId: string;
  conversationId: string;
  parentConversationId?: string;
  threadId?: string | number;
} | null {
  const channelPlugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === params.channel,
  )?.plugin;
  if (!channelPlugin?.bindings?.resolveCommandConversation) {
    return null;
  }
  return resolveConversationBindingContext({
    cfg: params.config ?? ({} as OpenClawConfig),
    channel: params.channel,
    accountId: params.accountId,
    threadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    senderId: params.senderId,
    originatingTo: params.originatingTo ?? params.from,
    commandTo: params.to,
    fallbackTo: params.to ?? params.from,
  });
}

type PluginCommandRuntimeLlm = NonNullable<PluginCommandContext["runtimeContext"]>["llm"];
type PluginCommandLlmCompleteParams = Parameters<
  NonNullable<PluginCommandRuntimeLlm>["complete"]
>[0];

function buildPluginCommandRuntimeContext(params: {
  command: RegisteredPluginCommand;
  config: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  authProfileId?: string;
}): PluginCommandContext["runtimeContext"] {
  const sessionKey = params.sessionKey?.trim();
  const agentId = resolveBoundAgentIdForSession({
    config: params.config,
    agentId: params.agentId,
    sessionKey,
  });
  if (!sessionKey && !agentId) {
    return undefined;
  }
  return {
    llm: {
      complete: async (request: PluginCommandLlmCompleteParams) => {
        const { createRuntimeLlm } = await import("./runtime/runtime-llm.runtime.js");
        return await createRuntimeLlm({
          getConfig: () => params.config,
          authority: {
            caller: {
              kind: "plugin",
              id: params.command.pluginId,
              name: params.command.pluginName,
            },
            pluginIdForPolicy: params.command.pluginId,
            requiresBoundAgent: true,
            ...(sessionKey ? { sessionKey } : {}),
            ...(agentId ? { agentId } : {}),
            ...(params.authProfileId ? { preferredProfile: params.authProfileId } : {}),
            allowAgentIdOverride: false,
            allowModelOverride: false,
            allowComplete: true,
          },
        }).complete(request);
      },
    },
  };
}

/**
 * Execute a plugin command handler.
 *
 * Note: Plugin authors should still validate and sanitize ctx.args for their
 * specific use case. This function provides basic defense-in-depth sanitization.
 */
export async function executePluginCommand(params: {
  command: RegisteredPluginCommand;
  args?: string;
  senderId?: string;
  channel: string;
  channelId?: PluginCommandContext["channelId"];
  isAuthorizedSender: boolean;
  senderIsOwner?: boolean;
  gatewayClientScopes?: PluginCommandContext["gatewayClientScopes"];
  /** Host-resolved agent authority for plugin-owned or non-agent-shaped session keys. */
  agentId?: string;
  sessionKey?: PluginCommandContext["sessionKey"];
  sessionId?: PluginCommandContext["sessionId"];
  sessionFile?: PluginCommandContext["sessionFile"];
  authProfileId?: string;
  commandBody: string;
  config: OpenClawConfig;
  from?: PluginCommandContext["from"];
  to?: PluginCommandContext["to"];
  originatingTo?: string;
  accountId?: PluginCommandContext["accountId"];
  messageThreadId?: PluginCommandContext["messageThreadId"];
  threadParentId?: PluginCommandContext["threadParentId"];
  diagnosticsSessions?: PluginCommandContext["diagnosticsSessions"];
  diagnosticsUploadApproved?: PluginCommandContext["diagnosticsUploadApproved"];
  diagnosticsPreviewOnly?: PluginCommandContext["diagnosticsPreviewOnly"];
  diagnosticsPrivateRouted?: PluginCommandContext["diagnosticsPrivateRouted"];
}): Promise<PluginCommandResult> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;

  // Check authorization
  if (!pluginCommandSupportsChannel(command, channel)) {
    logVerbose(`Plugin command /${command.name} skipped on unsupported channel ${channel}`);
    return { continueAgent: true };
  }
  const requireAuth = command.requireAuth !== false; // Default to true
  if (requireAuth && !isAuthorizedSender) {
    logVerbose(
      `Plugin command /${command.name} blocked: unauthorized sender ${senderId || "<unknown>"}`,
    );
    return { text: "⚠️ This command requires authorization." };
  }
  if (command.requiredScopes !== undefined && !Array.isArray(command.requiredScopes)) {
    logVerbose(`Plugin command /${command.name} blocked: invalid requiredScopes configuration`);
    return { text: "⚠️ This command has invalid gateway scope configuration." };
  }
  const requiredScopes = command.requiredScopes ?? [];
  const unknownScope = (requiredScopes as readonly unknown[]).find(
    (scope) => !isOperatorScope(scope),
  );
  if (unknownScope) {
    logVerbose(`Plugin command /${command.name} blocked: unknown gateway scope`);
    return { text: "⚠️ This command has invalid gateway scope configuration." };
  }
  if (requiredScopes.length > 0) {
    const senderIsOwner = params.senderIsOwner === true;
    const scopes = Array.isArray(params.gatewayClientScopes)
      ? new Set(params.gatewayClientScopes)
      : undefined;
    const hasGatewayScopeContext = scopes !== undefined;
    const hasAdmin = scopes?.has(ADMIN_SCOPE) === true;
    const missingScope = scopes
      ? requiredScopes.find((scope) => !hasAdmin && !scopes.has(scope))
      : requiredScopes[0];
    if (missingScope && (hasGatewayScopeContext || !senderIsOwner)) {
      logVerbose(`Plugin command /${command.name} blocked: missing gateway scope ${missingScope}`);
      return { text: `⚠️ This command requires gateway scope: ${missingScope}.` };
    }
  }

  // Sanitize args before passing to handler
  const sanitizedArgs = sanitizeArgs(args);
  const bindingConversation = resolveBindingConversationFromCommand({
    config,
    channel,
    senderId,
    from: params.from,
    to: params.to,
    originatingTo: params.originatingTo,
    accountId: params.accountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
  });
  const effectiveAccountId = bindingConversation?.accountId ?? params.accountId;
  const senderIsOwnerForCommand =
    canExposeSenderIsOwner(command) ||
    (isTrustedReservedCommandOwner(command) &&
      command.ownership === "reserved" &&
      isReservedCommandName(command.name) &&
      command.pluginId === normalizeLowercaseStringOrEmpty(command.name))
      ? params.senderIsOwner
      : undefined;
  const diagnosticsPrivateRoutedForCommand =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name)
      ? params.diagnosticsPrivateRouted
      : undefined;
  const diagnosticsUploadApprovedForCommand =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name)
      ? params.diagnosticsUploadApproved
      : undefined;
  const diagnosticsPreviewOnlyForCommand =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name)
      ? params.diagnosticsPreviewOnly
      : undefined;

  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    ...(senderIsOwnerForCommand === undefined ? {} : { senderIsOwner: senderIsOwnerForCommand }),
    gatewayClientScopes: params.gatewayClientScopes,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    args: sanitizedArgs,
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: effectiveAccountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    diagnosticsSessions: params.diagnosticsSessions,
    runtimeContext: buildPluginCommandRuntimeContext({
      command,
      config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      authProfileId: params.authProfileId,
    }),
    ...(diagnosticsUploadApprovedForCommand === undefined
      ? {}
      : { diagnosticsUploadApproved: diagnosticsUploadApprovedForCommand }),
    ...(diagnosticsPreviewOnlyForCommand === undefined
      ? {}
      : { diagnosticsPreviewOnly: diagnosticsPreviewOnlyForCommand }),
    ...(diagnosticsPrivateRoutedForCommand === undefined
      ? {}
      : { diagnosticsPrivateRouted: diagnosticsPrivateRoutedForCommand }),
    requestConversationBinding: async (bindingParams) => {
      if (!command.pluginRoot || !bindingConversation) {
        return {
          status: "error",
          message: "This command cannot bind the current conversation.",
        };
      }
      return requestPluginConversationBinding({
        pluginId: command.pluginId,
        pluginName: command.pluginName,
        pluginRoot: command.pluginRoot,
        requestedBySenderId: senderId,
        conversation: bindingConversation,
        binding: bindingParams,
      });
    },
    detachConversationBinding: async () => {
      if (!command.pluginRoot || !bindingConversation) {
        return { removed: false };
      }
      return detachPluginConversationBinding({
        pluginRoot: command.pluginRoot,
        conversation: bindingConversation,
      });
    },
    getCurrentConversationBinding: async () => {
      if (!command.pluginRoot || !bindingConversation) {
        return null;
      }
      return getCurrentPluginConversationBinding({
        pluginRoot: command.pluginRoot,
        conversation: bindingConversation,
      });
    },
  };

  // Lock registry during execution to prevent concurrent modifications
  setPluginCommandRegistryLocked(true);
  try {
    const result = await command.handler(ctx);
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    if (!result || typeof result !== "object") {
      logVerbose(`Plugin command /${command.name} returned no reply payload`);
      return {};
    }
    return result;
  } catch (err) {
    const error = err as Error;
    logVerbose(`Plugin command /${command.name} error: ${error.message}`);
    // Don't leak internal error details - return a safe generic message
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    setPluginCommandRegistryLocked(false);
  }
}

/**
 * List all registered plugin commands.
 * Used for /help and /commands output.
 */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
  acceptsArgs: boolean;
}> {
  return Array.from(pluginCommands.values()).map((cmd) => ({
    name: cmd.name,
    description: cmd.description,
    pluginId: cmd.pluginId,
    acceptsArgs: cmd.acceptsArgs ?? false,
  }));
}

function listPluginInvocationNames(command: OpenClawPluginCommandDefinition): string[] {
  return listPluginInvocationKeys(command);
}
