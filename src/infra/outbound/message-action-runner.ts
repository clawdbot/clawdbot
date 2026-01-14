import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { normalizeTargetForProvider } from "../../agents/pi-embedded-messaging.js";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import { dispatchChannelMessageAction } from "../../channels/plugins/message-actions.js";
import type {
  ChannelId,
  ChannelMessageActionName,
  ChannelThreadingToolContext,
} from "../../channels/plugins/types.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type {
  GatewayClientMode,
  GatewayClientName,
} from "../../utils/message-channel.js";
import { resolveMessageChannelSelection } from "./channel-selection.js";
import type { OutboundSendDeps } from "./deliver.js";
import type { MessagePollResult, MessageSendResult } from "./message.js";
import { sendMessage, sendPoll } from "./message.js";

export type MessageActionRunnerGateway = {
  url?: string;
  token?: string;
  timeoutMs?: number;
  clientName: GatewayClientName;
  clientDisplayName?: string;
  mode: GatewayClientMode;
};

export type RunMessageActionParams = {
  cfg: ClawdbotConfig;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  defaultAccountId?: string;
  toolContext?: ChannelThreadingToolContext;
  gateway?: MessageActionRunnerGateway;
  deps?: OutboundSendDeps;
  dryRun?: boolean;
};

export type MessageActionRunResult =
  | {
      kind: "send";
      channel: ChannelId;
      action: "send";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      sendResult?: MessageSendResult;
      dryRun: boolean;
    }
  | {
      kind: "poll";
      channel: ChannelId;
      action: "poll";
      to: string;
      handledBy: "plugin" | "core";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      pollResult?: MessagePollResult;
      dryRun: boolean;
    }
  | {
      kind: "action";
      channel: ChannelId;
      action: Exclude<ChannelMessageActionName, "send" | "poll">;
      handledBy: "plugin" | "dry-run";
      payload: unknown;
      toolResult?: AgentToolResult<unknown>;
      dryRun: boolean;
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

function readBooleanParam(
  params: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const raw = params[key];
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
  }
  return undefined;
}

function parseButtonsParam(params: Record<string, unknown>): void {
  const raw = params.buttons;
  if (typeof raw !== "string") return;
  const trimmed = raw.trim();
  if (!trimmed) {
    delete params.buttons;
    return;
  }
  try {
    params.buttons = JSON.parse(trimmed) as unknown;
  } catch {
    throw new Error("--buttons must be valid JSON");
  }
}

const CONTEXT_GUARDED_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "poll",
  "thread-create",
  "thread-reply",
  "sticker",
]);

function resolveContextGuardTarget(
  action: ChannelMessageActionName,
  params: Record<string, unknown>,
): string | undefined {
  if (!CONTEXT_GUARDED_ACTIONS.has(action)) return undefined;

  if (action === "thread-reply" || action === "thread-create") {
    return (
      readStringParam(params, "channelId") ?? readStringParam(params, "to")
    );
  }

  return readStringParam(params, "to") ?? readStringParam(params, "channelId");
}

function enforceContextIsolation(params: {
  channel: ChannelId;
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
  toolContext?: ChannelThreadingToolContext;
}): void {
  const currentTarget = params.toolContext?.currentChannelId?.trim();
  if (!currentTarget) return;
  if (!CONTEXT_GUARDED_ACTIONS.has(params.action)) return;

  const target = resolveContextGuardTarget(params.action, params.params);
  if (!target) return;

  const normalizedTarget =
    normalizeTargetForProvider(params.channel, target) ?? target.toLowerCase();
  const normalizedCurrent =
    normalizeTargetForProvider(params.channel, currentTarget) ??
    currentTarget.toLowerCase();

  if (!normalizedTarget || !normalizedCurrent) return;
  if (normalizedTarget === normalizedCurrent) return;

  throw new Error(
    `Cross-context messaging denied: action=${params.action} target="${target}" while bound to "${currentTarget}" (channel=${params.channel}).`,
  );
}

async function resolveChannel(
  cfg: ClawdbotConfig,
  params: Record<string, unknown>,
) {
  const channelHint = readStringParam(params, "channel");
  const selection = await resolveMessageChannelSelection({
    cfg,
    channel: channelHint,
  });
  return selection.channel;
}

export async function runMessageAction(
  input: RunMessageActionParams,
): Promise<MessageActionRunResult> {
  const cfg = input.cfg;
  const params = { ...input.params };
  parseButtonsParam(params);

  const action = input.action;
  const channel = await resolveChannel(cfg, params);
  const accountId =
    readStringParam(params, "accountId") ?? input.defaultAccountId;
  const dryRun = Boolean(input.dryRun ?? readBooleanParam(params, "dryRun"));

  enforceContextIsolation({
    channel,
    action,
    params,
    toolContext: input.toolContext,
  });

  const gateway = input.gateway
    ? {
        url: input.gateway.url,
        token: input.gateway.token,
        timeoutMs: input.gateway.timeoutMs,
        clientName: input.gateway.clientName,
        clientDisplayName: input.gateway.clientDisplayName,
        mode: input.gateway.mode,
      }
    : undefined;

  if (action === "send") {
    const to = readStringParam(params, "to", { required: true });
    let message = readStringParam(params, "message", {
      required: true,
      allowEmpty: true,
    });

    const parsed = parseReplyDirectives(message);
    message = parsed.text;
    params.message = message;
    if (!params.replyTo && parsed.replyToId) params.replyTo = parsed.replyToId;
    if (!params.media) {
      params.media = parsed.mediaUrls?.[0] || parsed.mediaUrl || undefined;
    }

    const mediaUrl = readStringParam(params, "media", { trim: false });
    const gifPlayback = readBooleanParam(params, "gifPlayback") ?? false;
    const bestEffort = readBooleanParam(params, "bestEffort");

    if (!dryRun) {
      const handled = await dispatchChannelMessageAction({
        channel,
        action,
        cfg,
        params,
        accountId: accountId ?? undefined,
        gateway,
        toolContext: input.toolContext,
        dryRun,
      });
      if (handled) {
        return {
          kind: "send",
          channel,
          action,
          to,
          handledBy: "plugin",
          payload: extractToolPayload(handled),
          toolResult: handled,
          dryRun,
        };
      }
    }

    const result: MessageSendResult = await sendMessage({
      cfg,
      to,
      content: message,
      mediaUrl: mediaUrl || undefined,
      channel: channel || undefined,
      accountId: accountId ?? undefined,
      gifPlayback,
      dryRun,
      bestEffort: bestEffort ?? undefined,
      deps: input.deps,
      gateway,
    });

    return {
      kind: "send",
      channel,
      action,
      to,
      handledBy: "core",
      payload: result,
      sendResult: result,
      dryRun,
    };
  }

  if (action === "poll") {
    const to = readStringParam(params, "to", { required: true });
    const question = readStringParam(params, "pollQuestion", {
      required: true,
    });
    const options =
      readStringArrayParam(params, "pollOption", { required: true }) ?? [];
    if (options.length < 2) {
      throw new Error("pollOption requires at least two values");
    }
    const allowMultiselect = readBooleanParam(params, "pollMulti") ?? false;
    const durationHours = readNumberParam(params, "pollDurationHours", {
      integer: true,
    });
    const maxSelections = allowMultiselect ? Math.max(2, options.length) : 1;

    if (!dryRun) {
      const handled = await dispatchChannelMessageAction({
        channel,
        action,
        cfg,
        params,
        accountId: accountId ?? undefined,
        gateway,
        toolContext: input.toolContext,
        dryRun,
      });
      if (handled) {
        return {
          kind: "poll",
          channel,
          action,
          to,
          handledBy: "plugin",
          payload: extractToolPayload(handled),
          toolResult: handled,
          dryRun,
        };
      }
    }

    const result: MessagePollResult = await sendPoll({
      cfg,
      to,
      question,
      options,
      maxSelections,
      durationHours: durationHours ?? undefined,
      channel,
      dryRun,
      gateway,
    });

    return {
      kind: "poll",
      channel,
      action,
      to,
      handledBy: "core",
      payload: result,
      pollResult: result,
      dryRun,
    };
  }

  if (dryRun) {
    return {
      kind: "action",
      channel,
      action,
      handledBy: "dry-run",
      payload: { ok: true, dryRun: true, channel, action },
      dryRun: true,
    };
  }

  const handled = await dispatchChannelMessageAction({
    channel,
    action,
    cfg,
    params,
    accountId: accountId ?? undefined,
    gateway,
    toolContext: input.toolContext,
    dryRun,
  });
  if (!handled) {
    throw new Error(
      `Message action ${action} not supported for channel ${channel}.`,
    );
  }
  return {
    kind: "action",
    channel,
    action,
    handledBy: "plugin",
    payload: extractToolPayload(handled),
    toolResult: handled,
    dryRun,
  };
}
