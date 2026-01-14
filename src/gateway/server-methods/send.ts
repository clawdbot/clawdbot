import {
  getChannelPlugin,
  normalizeChannelId,
} from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import { loadConfig } from "../../config/config.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { normalizePollInput } from "../../polls.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validatePollParams,
  validateSendParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

export const sendHandlers: GatewayRequestHandlers = {
  send: async ({ params, respond, context }) => {
    const p = params as Record<string, unknown>;
    if (!validateSendParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid send params: ${formatValidationErrors(validateSendParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      message: string;
      mediaUrl?: string;
      gifPlayback?: boolean;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const cached = context.dedupe.get(`send:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const to = request.to.trim();
    const message = request.message.trim();
    const channelInput =
      typeof request.channel === "string" ? request.channel : undefined;
    const normalizedChannel = channelInput
      ? normalizeChannelId(channelInput)
      : null;
    if (channelInput && !normalizedChannel) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unsupported channel: ${channelInput}`,
        ),
      );
      return;
    }
    const channel = normalizedChannel ?? DEFAULT_CHAT_CHANNEL;
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    try {
      const outboundChannel = channel as Exclude<OutboundChannel, "none">;
      const plugin = getChannelPlugin(channel as ChannelId);
      if (!plugin) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported channel: ${channel}`,
          ),
        );
        return;
      }
      const cfg = loadConfig();
      const resolved = resolveOutboundTarget({
        channel: outboundChannel,
        to,
        cfg,
        accountId,
        mode: "explicit",
      });
      if (!resolved.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
        );
        return;
      }
      const results = await deliverOutboundPayloads({
        cfg,
        channel: outboundChannel,
        to: resolved.to,
        accountId,
        payloads: [{ text: message, mediaUrl: request.mediaUrl }],
        gifPlayback: request.gifPlayback,
      });
      const result = results.at(-1);
      if (!result) {
        throw new Error("No delivery result");
      }
      const payload: Record<string, unknown> = {
        runId: idem,
        messageId: result.messageId,
        channel,
      };
      if ("chatId" in result) payload.chatId = result.chatId;
      if ("channelId" in result) payload.channelId = result.channelId;
      if ("toJid" in result) payload.toJid = result.toJid;
      if ("conversationId" in result) {
        payload.conversationId = result.conversationId;
      }
      context.dedupe.set(`send:${idem}`, {
        ts: Date.now(),
        ok: true,
        payload,
      });
      respond(true, payload, undefined, { channel });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      context.dedupe.set(`send:${idem}`, {
        ts: Date.now(),
        ok: false,
        error,
      });
      respond(false, undefined, error, { channel, error: formatForLog(err) });
    }
  },
  poll: async ({ params, respond, context }) => {
    const p = params as Record<string, unknown>;
    if (!validatePollParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid poll params: ${formatValidationErrors(validatePollParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      to: string;
      question: string;
      options: string[];
      maxSelections?: number;
      durationHours?: number;
      channel?: string;
      accountId?: string;
      idempotencyKey: string;
    };
    const idem = request.idempotencyKey;
    const cached = context.dedupe.get(`poll:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const to = request.to.trim();
    const channelInput =
      typeof request.channel === "string" ? request.channel : undefined;
    const normalizedChannel = channelInput
      ? normalizeChannelId(channelInput)
      : null;
    if (channelInput && !normalizedChannel) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `unsupported poll channel: ${channelInput}`,
        ),
      );
      return;
    }
    const channel = normalizedChannel ?? DEFAULT_CHAT_CHANNEL;
    const poll = {
      question: request.question,
      options: request.options,
      maxSelections: request.maxSelections,
      durationHours: request.durationHours,
    };
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    try {
      const plugin = getChannelPlugin(channel as ChannelId);
      const outbound = plugin?.outbound;
      if (!outbound?.sendPoll) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported poll channel: ${channel}`,
          ),
        );
        return;
      }
      const cfg = loadConfig();
      const resolved = resolveOutboundTarget({
        channel: channel as Exclude<OutboundChannel, "none">,
        to,
        cfg,
        accountId,
        mode: "explicit",
      });
      if (!resolved.ok) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, String(resolved.error)),
        );
        return;
      }
      const normalized = outbound.pollMaxOptions
        ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
        : normalizePollInput(poll);
      const result = await outbound.sendPoll({
        cfg,
        to: resolved.to,
        poll: normalized,
        accountId,
      });
      const payload: Record<string, unknown> = {
        runId: idem,
        messageId: result.messageId,
        channel,
      };
      if (result.toJid) payload.toJid = result.toJid;
      if (result.channelId) payload.channelId = result.channelId;
      if (result.conversationId) payload.conversationId = result.conversationId;
      if (result.pollId) payload.pollId = result.pollId;
      context.dedupe.set(`poll:${idem}`, {
        ts: Date.now(),
        ok: true,
        payload,
      });
      respond(true, payload, undefined, { channel });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      context.dedupe.set(`poll:${idem}`, {
        ts: Date.now(),
        ok: false,
        error,
      });
      respond(false, undefined, error, {
        channel,
        error: formatForLog(err),
      });
    }
  },
};
