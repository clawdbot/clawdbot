/**
 * Plugin Command Registry
 *
 * Compatibility wrappers for plugin command registration, matching, and execution.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginCommands, registerPluginCommand } from "./command-registration.js";
import {
  listRegisteredPluginAgentPromptGuidance,
  type RegisteredPluginCommand,
} from "./command-registry-state.js";
import {
  executeRegisteredPluginCommand,
  type PluginCommandExecutionParams,
} from "./plugin-command-execution.js";
import { matchRegisteredPluginCommand } from "./plugin-command-matcher.js";
import { listRegisteredPluginCommands } from "./plugin-command-registry.js";
import { requireActivePluginRegistry } from "./runtime.js";
import type { PluginCommandContext, PluginCommandResult } from "./types.js";

export { clearPluginCommands, listRegisteredPluginAgentPromptGuidance, registerPluginCommand };

/** Match one compatibility command invocation against the current command registry. */
export function matchPluginCommand(
  commandBody: string,
  options: { channel?: string } = {},
): { command: RegisteredPluginCommand; args?: string } | null {
  const registry = requireActivePluginRegistry();
  return matchRegisteredPluginCommand({
    commands: listRegisteredPluginCommands(registry),
    commandBody,
    channel: options.channel,
    aliasScope: { kind: "all" },
  });
}

export function executePluginCommand(params: {
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
  sessionTarget?: PluginCommandContext["sessionTarget"];
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
}): Promise<PluginCommandResult>;
export async function executePluginCommand(
  params: PluginCommandExecutionParams,
): Promise<PluginCommandResult> {
  return await executeRegisteredPluginCommand(requireActivePluginRegistry(), params);
}

/** List registered plugin commands for help and command discovery. */
export function listPluginCommands(): Array<{
  name: string;
  description: string;
  pluginId: string;
  acceptsArgs: boolean;
}> {
  return listRegisteredPluginCommands(requireActivePluginRegistry()).map((command) => ({
    name: command.name,
    description: command.description,
    pluginId: command.pluginId,
    acceptsArgs: command.acceptsArgs ?? false,
  }));
}
