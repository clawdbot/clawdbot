import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import type { ChannelId, ChannelThreadingToolContext } from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { appendAssistantMessageToSessionTranscript } from "../../config/sessions.js";
import type { GatewayClientMode, GatewayClientName } from "../../utils/message-channel.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";

export type OutboundGatewayContext = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type OutboundSendContext = {
  cfg: MoltbotConfig;
  channel: ChannelId;
  params: Record<string, unknown>;
  accountId?: string | null;
  gateway?: OutboundGatewayContext;
  toolContext?: ChannelThreadingToolContext;
  deps?: OutboundSendDeps;
  dryRun: boolean;
  mirror?: {
    sessionKey: string;
    agentId?: string;
    text?: string;
    mediaUrls?: string[];
  };
  abortSignal?: AbortSignal;
};

function extractToolPayload(result: AgentToolResult<unknown>): unknown {
  if (result.details !== undefined) return result.details;
  const textBlock = Array.isArray(result.content)
    ? result.content.find(
        (block) =>
          block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
    : undefined;
  const text = (textBlock as { text?: string } | undefined)?.text;
  if (text) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return result.content ?? result;
}

function throwIfAborted(abortSignal?: AbortSignal): void {
  if (abortSignal?.aborted) {
    const err = new Error("Message send aborted");
    err.name = "AbortError";
    throw err;
  }
}

export async function executeSendAction(params: {
  ctx: OutboundSendContext;
  to: string;
  message: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  gifPlayback?: boolean;
  bestEffort?: boolean;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  sendResult?: MessageSendResult;
}> {
  throwIfAborted(params.ctx.abortSignal);
  if (!params.ctx.dryRun) {
    const handled = await dispatchChannelMessageAction({
      channel: params.ctx.channel,
      action: "send",
      cfg: params.ctx.cfg,
      params: params.ctx.params,
      accountId: params.ctx.accountId ?? undefined,
      gateway: params.ctx.gateway,
      toolContext: params.ctx.toolContext,
      dryRun: params.ctx.dryRun,
    });
    if (handled) {
      if (params.ctx.mirror) {
        const mirrorText = params.ctx.mirror.text ?? params.message;
        const mirrorMediaUrls =
          params.ctx.mirror.mediaUrls ??
          params.mediaUrls ??
          (params.mediaUrl ? [params.mediaUrl] : undefined);
        await appendAssistantMessageToSessionTranscript({
          agentId: params.ctx.mirror.agentId,
          sessionKey: params.ctx.mirror.sessionKey,
          text: mirrorText,
          mediaUrls: mirrorMediaUrls,
        });
      }
      return {
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
      };
    }
  }

  throwIfAborted(params.ctx.abortSignal);
  const result: MessageSendResult = await sendMessage({
    cfg: params.ctx.cfg,
    to: params.to,
    content: params.message,
    mediaUrl: params.mediaUrl || undefined,
    mediaUrls: params.mediaUrls,
    channel: params.ctx.channel || undefined,
    accountId: params.ctx.accountId ?? undefined,
    gifPlayback: params.gifPlayback,
    dryRun: params.ctx.dryRun,
    bestEffort: params.bestEffort ?? undefined,
    deps: params.ctx.deps,
    gateway: params.ctx.gateway,
    mirror: params.ctx.mirror,
    abortSignal: params.ctx.abortSignal,
  });

  return {
    handledBy: "core",
    payload: result,
    sendResult: result,
  };
}

export async function executePollAction(params: {
  ctx: OutboundSendContext;
  to: string;
  question: string;
  options: string[];
  maxSelections: number;
  durationHours?: number;
}): Promise<{
  handledBy: "plugin" | "core";
  payload: unknown;
  toolResult?: AgentToolResult<unknown>;
  pollResult?: MessagePollResult;
}> {
  if (!params.ctx.dryRun) {
    const handled = await dispatchChannelMessageAction({
      channel: params.ctx.channel,
      action: "poll",
      cfg: params.ctx.cfg,
      params: params.ctx.params,
      accountId: params.ctx.accountId ?? undefined,
      gateway: params.ctx.gateway,
      toolContext: params.ctx.toolContext,
      dryRun: params.ctx.dryRun,
    });
    if (handled) {
      return {
        handledBy: "plugin",
        payload: extractToolPayload(handled),
        toolResult: handled,
      };
    }
  }

  const result: MessagePollResult = await sendPoll({
    cfg: params.ctx.cfg,
    to: params.to,
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
    durationHours: params.durationHours ?? undefined,
    channel: params.ctx.channel,
    dryRun: params.ctx.dryRun,
    gateway: params.ctx.gateway,
  });

  return {
    handledBy: "core",
    payload: result,
    pollResult: result,
  };
}
