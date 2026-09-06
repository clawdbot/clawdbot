/** Exact-registry plugin command execution shared by focused and compatibility runtimes. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveBoundAgentIdForSession } from "../agents/session-agent-binding.js";
import { resolveCommandConversationResolution } from "../channels/conversation-resolution.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE, isOperatorScope } from "../gateway/operator-scopes.js";
import { logVerbose } from "../globals.js";
import { withPluginCommandExecution } from "./command-execution-lock.js";
import { isReservedCommandName } from "./command-registration.js";
import {
  canExposeSenderIsOwner,
  isTrustedReservedCommandOwner,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  detachPluginConversationBinding,
  getCurrentPluginConversationBinding,
  requestPluginConversationBinding,
} from "./conversation-binding.js";
import { pluginCommandSupportsChannel } from "./plugin-command-metadata.js";
import type { PluginCommandDispatchContext } from "./plugin-command-runtime.js";
import type { PluginRegistry } from "./registry-types.js";
import type { PluginCommandContext, PluginCommandResult } from "./types.js";

const MAX_ARGS_LENGTH = 4096;
const blockedCompaction = (reason: string) => ({ compacted: false, reason });

export type PluginCommandExecutionParams = PluginCommandDispatchContext & {
  command: RegisteredPluginCommand;
  args?: string;
};

function sanitizeArgs(args: string | undefined): string | undefined {
  if (!args) {
    return undefined;
  }
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

function resolveBindingConversation(params: {
  registry: PluginRegistry;
  config: OpenClawConfig;
  channel: string;
  senderId?: string;
  from?: string;
  to?: string;
  originatingTo?: string;
  accountId?: string;
  messageThreadId?: string | number;
  threadParentId?: string;
}) {
  const channelPlugin = params.registry.channels.find(
    (entry) => entry.plugin.id === params.channel,
  )?.plugin;
  if (!channelPlugin?.bindings?.resolveCommandConversation) {
    return null;
  }
  return resolveCommandConversationResolution({
    cfg: params.config,
    plugin: channelPlugin,
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

function buildRuntimeContext(
  command: RegisteredPluginCommand,
  params: PluginCommandDispatchContext,
  invocationSignal: AbortSignal,
): PluginCommandContext["runtimeContext"] {
  const sessionKey = params.sessionKey?.trim();
  const agentId = resolveBoundAgentIdForSession({
    config: params.config,
    agentId: params.agentId,
    sessionKey,
  });
  const compactCurrent = params.runtimeContext?.compactCurrent;
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
              id: command.pluginId,
              name: command.pluginName,
            },
            pluginIdForPolicy: command.pluginId,
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
    ...(compactCurrent && params.sessionTarget
      ? {
          // Command capabilities require this live invocation; retained references fail closed.
          compactCurrent: async () => {
            if (invocationSignal.aborted) {
              return blockedCompaction("command invocation closed");
            }
            const result = await compactCurrent(invocationSignal);
            return invocationSignal.aborted
              ? blockedCompaction("command invocation closed")
              : result;
          },
        }
      : {}),
  };
}

export async function executeRegisteredPluginCommand(
  registry: PluginRegistry,
  params: PluginCommandExecutionParams,
): Promise<PluginCommandResult> {
  const { command, args, senderId, channel, isAuthorizedSender, commandBody, config } = params;
  if (!pluginCommandSupportsChannel(command, channel)) {
    logVerbose(`Plugin command /${command.name} skipped on unsupported channel ${channel}`);
    return { continueAgent: true };
  }
  if (command.requireAuth !== false && !isAuthorizedSender) {
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
    const scopes = Array.isArray(params.gatewayClientScopes)
      ? new Set(params.gatewayClientScopes)
      : undefined;
    const hasAdmin = scopes?.has(ADMIN_SCOPE) === true;
    const missingScope = scopes
      ? requiredScopes.find((scope) => !hasAdmin && !scopes.has(scope))
      : requiredScopes[0];
    if (missingScope && (scopes !== undefined || params.senderIsOwner !== true)) {
      logVerbose(`Plugin command /${command.name} blocked: missing gateway scope ${missingScope}`);
      return { text: `⚠️ This command requires gateway scope: ${missingScope}.` };
    }
  }

  const bindingConversation = resolveBindingConversation({
    registry,
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
  const trustedReservedOwner =
    isTrustedReservedCommandOwner(command) &&
    command.ownership === "reserved" &&
    isReservedCommandName(command.name) &&
    command.pluginId === normalizeLowercaseStringOrEmpty(command.name);
  const senderIsOwner =
    canExposeSenderIsOwner(command) || trustedReservedOwner ? params.senderIsOwner : undefined;
  const commandInvocationAbort = new AbortController();
  const ctx: PluginCommandContext = {
    senderId,
    channel,
    channelId: params.channelId,
    isAuthorizedSender,
    ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
    gatewayClientScopes: params.gatewayClientScopes,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    sessionTarget: params.sessionTarget,
    sessionFile: params.sessionFile,
    args: sanitizeArgs(args),
    commandBody,
    config,
    from: params.from,
    to: params.to,
    accountId: bindingConversation?.accountId ?? params.accountId,
    messageThreadId: params.messageThreadId,
    threadParentId: params.threadParentId,
    diagnosticsSessions: params.diagnosticsSessions,
    runtimeContext: buildRuntimeContext(command, params, commandInvocationAbort.signal),
    ...(trustedReservedOwner && params.diagnosticsUploadApproved !== undefined
      ? { diagnosticsUploadApproved: params.diagnosticsUploadApproved }
      : {}),
    ...(trustedReservedOwner && params.diagnosticsPreviewOnly !== undefined
      ? { diagnosticsPreviewOnly: params.diagnosticsPreviewOnly }
      : {}),
    ...(trustedReservedOwner && params.diagnosticsPrivateRouted !== undefined
      ? { diagnosticsPrivateRouted: params.diagnosticsPrivateRouted }
      : {}),
    requestConversationBinding: async (bindingParams) => {
      if (!command.pluginRoot || !bindingConversation) {
        return { status: "error", message: "This command cannot bind the current conversation." };
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
    detachConversationBinding: async () =>
      command.pluginRoot && bindingConversation
        ? detachPluginConversationBinding({
            pluginRoot: command.pluginRoot,
            conversation: bindingConversation,
          })
        : { removed: false },
    getCurrentConversationBinding: async () =>
      command.pluginRoot && bindingConversation
        ? getCurrentPluginConversationBinding({
            pluginRoot: command.pluginRoot,
            conversation: bindingConversation,
          })
        : null,
  };

  try {
    const execution = await withPluginCommandExecution(registry, () => command.handler(ctx));
    if (!execution.admitted) {
      return {
        text: "⚠️ This command is no longer available after the plugin registry changed. Please try again.",
      };
    }
    const result = execution.value;
    logVerbose(
      `Plugin command /${command.name} executed successfully for ${senderId || "unknown"}`,
    );
    if (!result || typeof result !== "object") {
      logVerbose(`Plugin command /${command.name} returned no reply payload`);
      return {};
    }
    return result;
  } catch (error) {
    logVerbose(`Plugin command /${command.name} error: ${(error as Error).message}`);
    return { text: "⚠️ Command failed. Please try again later." };
  } finally {
    commandInvocationAbort.abort("command invocation closed");
  }
}
