import os from "node:os";
import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../infra/os-summary.js";
import { normalizeMessageChannel } from "../utils/message-channel.js";
import { resolveChannelMessageToolHints, resolveChannelReactionGuidance } from "./channel-tools.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { collectRuntimeChannelCapabilities } from "./runtime-capabilities.js";
import { detectRuntimeShell } from "./shell-utils.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";

export async function resolveAgentRuntimePrompt(params: {
  config?: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  cwd?: string;
  preparedRepoRoot?: string | null;
  sessionKey?: string;
  sessionId?: string;
  model: string;
  channel?: string;
  accountId?: string | null;
  chatType?: ChatType;
}) {
  const runtimeChannel = normalizeMessageChannel(params.channel);
  const channelPromptContext = {
    cfg: params.config,
    channel: runtimeChannel,
    accountId: params.accountId,
  };
  const runtimeCapabilities = collectRuntimeChannelCapabilities(channelPromptContext);
  const reactionGuidance =
    runtimeChannel && params.config
      ? resolveChannelReactionGuidance(channelPromptContext)
      : undefined;
  const messageToolHints = runtimeChannel
    ? resolveChannelMessageToolHints(channelPromptContext)
    : undefined;
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const machineName = await getMachineDisplayName();
  const systemPromptParams = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    ...(Object.hasOwn(params, "preparedRepoRoot")
      ? { preparedRepoRoot: params.preparedRepoRoot }
      : {}),
    runtime: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      host: machineName,
      os: resolveRuntimeOsLabel(),
      arch: os.arch(),
      node: process.version,
      model: params.model,
      defaultModel: `${defaultModel.provider}/${defaultModel.model}`,
      shell: detectRuntimeShell(),
      channel: runtimeChannel,
      chatType: params.chatType,
      capabilities: runtimeCapabilities,
    },
  });

  return {
    ...systemPromptParams,
    runtimeChannel,
    runtimeCapabilities,
    reactionGuidance,
    messageToolHints,
  };
}
