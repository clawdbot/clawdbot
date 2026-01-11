import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { CliDeps } from "../cli/deps.js";
import { withProgress } from "../cli/progress.js";
import { loadConfig } from "../config/config.js";
import { success } from "../globals.js";
import type {
  OutboundDeliveryResult,
  OutboundSendDeps,
} from "../infra/outbound/deliver.js";
import { buildOutboundResultEnvelope } from "../infra/outbound/envelope.js";
import {
  buildOutboundDeliveryJson,
  formatGatewaySummary,
  formatOutboundDeliverySummary,
} from "../infra/outbound/format.js";
import {
  type MessagePollResult,
  type MessageSendResult,
  sendMessage,
  sendPoll,
} from "../infra/outbound/message.js";
import { resolveMessageProviderSelection } from "../infra/outbound/provider-selection.js";
import { dispatchProviderMessageAction } from "../providers/plugins/message-actions.js";
import type { ProviderMessageActionName } from "../providers/plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../utils/message-provider.js";

type MessageAction =
  | "send"
  | "poll"
  | "react"
  | "reactions"
  | "read"
  | "edit"
  | "delete"
  | "pin"
  | "unpin"
  | "list-pins"
  | "permissions"
  | "thread-create"
  | "thread-list"
  | "thread-reply"
  | "search"
  | "sticker"
  | "member-info"
  | "role-info"
  | "emoji-list"
  | "emoji-upload"
  | "sticker-upload"
  | "role-add"
  | "role-remove"
  | "channel-info"
  | "channel-list"
  | "voice-status"
  | "event-list"
  | "event-create"
  | "timeout"
  | "kick"
  | "ban";

type MessageCommandOpts = {
  action?: string;
  provider?: string;
  to?: string;
  message?: string;
  media?: string;
  buttonsJson?: string;
  messageId?: string;
  replyTo?: string;
  threadId?: string;
  account?: string;
  emoji?: string;
  remove?: boolean;
  limit?: string;
  before?: string;
  after?: string;
  around?: string;
  pollQuestion?: string;
  pollOption?: string[] | string;
  pollDurationHours?: string;
  pollMulti?: boolean;
  channelId?: string;
  channelIds?: string[] | string;
  guildId?: string;
  userId?: string;
  authorId?: string;
  authorIds?: string[] | string;
  roleId?: string;
  roleIds?: string[] | string;
  emojiName?: string;
  stickerId?: string[] | string;
  stickerName?: string;
  stickerDesc?: string;
  stickerTags?: string;
  threadName?: string;
  autoArchiveMin?: string;
  query?: string;
  eventName?: string;
  eventType?: string;
  startTime?: string;
  endTime?: string;
  desc?: string;
  location?: string;
  durationMin?: string;
  until?: string;
  reason?: string;
  deleteDays?: string;
  includeArchived?: boolean;
  participant?: string;
  fromMe?: boolean;
  dryRun?: boolean;
  json?: boolean;
  gifPlayback?: boolean;
};

type MessageSendOpts = {
  to: string;
  message: string;
  provider: string;
  json?: boolean;
  dryRun?: boolean;
  media?: string;
  gifPlayback?: boolean;
  account?: string;
};

function normalizeAction(value?: string): MessageAction {
  const raw = value?.trim().toLowerCase() || "send";
  return raw as MessageAction;
}

function parseIntOption(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} required`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} required`);
  }
  return trimmed;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

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

function logSendDryRun(opts: MessageSendOpts, runtime: RuntimeEnv) {
  runtime.log(
    `[dry-run] would send via ${opts.provider} -> ${opts.to}: ${opts.message}${
      opts.media ? ` (media ${opts.media})` : ""
    }`,
  );
}

function logPollDryRun(result: MessagePollResult, runtime: RuntimeEnv) {
  runtime.log(
    `[dry-run] would send poll via ${result.provider} -> ${result.to}:\n  Question: ${result.question}\n  Options: ${result.options.join(
      ", ",
    )}\n  Max selections: ${result.maxSelections}`,
  );
}

function logSendResult(
  result: MessageSendResult,
  opts: MessageSendOpts,
  runtime: RuntimeEnv,
) {
  if (result.via === "direct") {
    const directResult = result.result as OutboundDeliveryResult | undefined;
    const summary = formatOutboundDeliverySummary(
      result.provider,
      directResult,
    );
    runtime.log(success(summary));
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          buildOutboundDeliveryJson({
            provider: result.provider,
            via: "direct",
            to: opts.to,
            result: directResult,
            mediaUrl: opts.media ?? null,
          }),
          null,
          2,
        ),
      );
    }
    return;
  }

  const gatewayResult = result.result as { messageId?: string } | undefined;
  runtime.log(
    success(
      formatGatewaySummary({
        provider: result.provider,
        messageId: gatewayResult?.messageId ?? null,
      }),
    ),
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        buildOutboundResultEnvelope({
          delivery: buildOutboundDeliveryJson({
            provider: result.provider,
            via: "gateway",
            to: opts.to,
            result: gatewayResult,
            mediaUrl: opts.media ?? null,
          }),
        }),
        null,
        2,
      ),
    );
  }
}

export async function messageCommand(
  opts: MessageCommandOpts,
  deps: CliDeps,
  runtime: RuntimeEnv,
) {
  const cfg = loadConfig();
  const action = normalizeAction(opts.action);
  const providerSelection = await resolveMessageProviderSelection({
    cfg,
    provider: opts.provider,
  });
  const provider = providerSelection.provider;
  const accountId = optionalString(opts.account);
  const actionParams = opts as Record<string, unknown>;
  const outboundDeps: OutboundSendDeps = {
    sendWhatsApp: deps.sendMessageWhatsApp,
    sendTelegram: deps.sendMessageTelegram,
    sendDiscord: deps.sendMessageDiscord,
    sendSlack: deps.sendMessageSlack,
    sendSignal: deps.sendMessageSignal,
    sendIMessage: deps.sendMessageIMessage,
    sendMSTeams: (to, text, opts) =>
      deps.sendMessageMSTeams({ cfg, to, text, mediaUrl: opts?.mediaUrl }),
  };

  if (opts.dryRun && action !== "send" && action !== "poll") {
    runtime.log(`[dry-run] would run ${action} via ${provider}`);
    return;
  }

  if (action === "send") {
    const to = requireString(opts.to, "to");
    const message = requireString(opts.message, "message");
    const sendOpts: MessageSendOpts = {
      to,
      message,
      provider,
      json: opts.json,
      dryRun: opts.dryRun,
      media: optionalString(opts.media),
      gifPlayback: opts.gifPlayback,
      account: accountId,
    };

    if (opts.dryRun) {
      logSendDryRun(sendOpts, runtime);
      return;
    }

    const handled = await dispatchProviderMessageAction({
      provider,
      action: action as ProviderMessageActionName,
      cfg,
      params: actionParams,
      accountId,
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
      dryRun: opts.dryRun,
    });
    if (handled) {
      const payload = extractToolPayload(handled);
      if (opts.json) {
        runtime.log(JSON.stringify(payload, null, 2));
      } else {
        runtime.log(success(`Sent via ${provider}.`));
      }
      return;
    }

    const result = await withProgress(
      {
        label: `Sending via ${provider}...`,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await sendMessage({
          cfg,
          to,
          content: message,
          provider,
          mediaUrl: optionalString(opts.media),
          gifPlayback: opts.gifPlayback,
          accountId,
          dryRun: opts.dryRun,
          deps: outboundDeps,
          gateway: {
            clientName: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
          },
        }),
    );
    logSendResult(result, sendOpts, runtime);
    return;
  }

  if (action === "poll") {
    const to = requireString(opts.to, "to");
    const question = requireString(opts.pollQuestion, "poll-question");
    const options = toStringArray(opts.pollOption);
    if (options.length < 2) {
      throw new Error("poll-option requires at least two values");
    }
    const durationHours = parseIntOption(
      opts.pollDurationHours,
      "poll-duration-hours",
    );
    const allowMultiselect = Boolean(opts.pollMulti);
    const maxSelections = allowMultiselect ? Math.max(2, options.length) : 1;

    if (opts.dryRun) {
      const result = await sendPoll({
        cfg,
        to,
        question,
        options,
        maxSelections,
        durationHours,
        provider,
        dryRun: true,
        gateway: {
          clientName: GATEWAY_CLIENT_NAMES.CLI,
          mode: GATEWAY_CLIENT_MODES.CLI,
        },
      });
      logPollDryRun(result, runtime);
      return;
    }

    const handled = await dispatchProviderMessageAction({
      provider,
      action: action as ProviderMessageActionName,
      cfg,
      params: actionParams,
      accountId,
      gateway: {
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
      },
      dryRun: opts.dryRun,
    });
    if (handled) {
      const payload = extractToolPayload(handled);
      if (opts.json) {
        runtime.log(JSON.stringify(payload, null, 2));
      } else {
        runtime.log(success(`Poll sent via ${provider}.`));
      }
      return;
    }

    const result = await withProgress(
      {
        label: `Sending poll via ${provider}...`,
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await sendPoll({
          cfg,
          to,
          question,
          options,
          maxSelections,
          durationHours,
          provider,
          dryRun: opts.dryRun,
          gateway: {
            clientName: GATEWAY_CLIENT_NAMES.CLI,
            mode: GATEWAY_CLIENT_MODES.CLI,
          },
        }),
    );

    runtime.log(
      success(
        formatGatewaySummary({
          action: "Poll sent",
          provider,
          messageId: result.result?.messageId ?? null,
        }),
      ),
    );
    const pollId = (result.result as { pollId?: string } | undefined)?.pollId;
    if (pollId) {
      runtime.log(success(`Poll id: ${pollId}`));
    }
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            ...buildOutboundResultEnvelope({
              delivery: buildOutboundDeliveryJson({
                provider,
                via: "gateway",
                to,
                result: result.result,
                mediaUrl: null,
              }),
            }),
            question: result.question,
            options: result.options,
            maxSelections: result.maxSelections,
            durationHours: result.durationHours,
            pollId,
          },
          null,
          2,
        ),
      );
    }
    return;
  }

  const handled = await dispatchProviderMessageAction({
    provider,
    action: action as ProviderMessageActionName,
    cfg,
    params: actionParams,
    accountId,
    gateway: {
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    },
    dryRun: opts.dryRun,
  });
  if (handled) {
    runtime.log(JSON.stringify(extractToolPayload(handled), null, 2));
    return;
  }

  throw new Error(
    `Action ${action} is not supported for provider ${provider}.`,
  );
}
