import { loadConfig } from "../../config/config.js";
import { deliverOutboundPayloads } from "../../infra/outbound/deliver.js";
import type { OutboundProvider } from "../../infra/outbound/targets.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import { normalizePollInput } from "../../polls.js";
import { getProviderPlugin } from "../../providers/plugins/index.js";
import type { ProviderId } from "../../providers/plugins/types.js";
import { normalizeMessageProvider } from "../../utils/message-provider.js";
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
      provider?: string;
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
    const provider = normalizeMessageProvider(request.provider) ?? "whatsapp";
    const accountId =
      typeof request.accountId === "string" && request.accountId.trim().length
        ? request.accountId.trim()
        : undefined;
    try {
      if (provider === "none") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "unsupported provider: none"),
        );
        return;
      }
      const outboundProvider = provider as Exclude<OutboundProvider, "none">;
      const plugin = getProviderPlugin(provider as ProviderId);
      if (!plugin) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported provider: ${provider}`,
          ),
        );
        return;
      }
      const cfg = loadConfig();
      const resolved = resolveOutboundTarget({
        provider: outboundProvider,
        to,
        allowFrom: cfg.whatsapp?.allowFrom ?? [],
        cfg,
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
        provider: outboundProvider,
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
        provider,
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
      respond(true, payload, undefined, { provider });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      context.dedupe.set(`send:${idem}`, {
        ts: Date.now(),
        ok: false,
        error,
      });
      respond(false, undefined, error, {
        provider,
        error: formatForLog(err),
      });
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
      provider?: string;
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
    const provider = normalizeMessageProvider(request.provider) ?? "whatsapp";
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
      if (provider === "none") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "unsupported poll provider: none",
          ),
        );
        return;
      }
      const plugin = getProviderPlugin(provider as ProviderId);
      const outbound = plugin?.outbound;
      if (!outbound?.sendPoll) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `unsupported poll provider: ${provider}`,
          ),
        );
        return;
      }
      const cfg = loadConfig();
      const resolved = resolveOutboundTarget({
        provider: provider as Exclude<OutboundProvider, "none">,
        to,
        allowFrom: cfg.whatsapp?.allowFrom ?? [],
        cfg,
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
        : poll;
      const result = await outbound.sendPoll({
        cfg,
        to: resolved.to,
        poll: normalized,
        accountId,
      });
      const payload: Record<string, unknown> = {
        runId: idem,
        messageId: result.messageId,
        provider,
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
      respond(true, payload, undefined, { provider });
    } catch (err) {
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      context.dedupe.set(`poll:${idem}`, {
        ts: Date.now(),
        ok: false,
        error,
      });
      respond(false, undefined, error, {
        provider,
        error: formatForLog(err),
      });
    }
  },
};
