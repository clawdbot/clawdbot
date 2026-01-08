import { loadConfig } from "../../config/config.js";
import { sendMessageDiscord, sendPollDiscord } from "../../discord/index.js";
import { shouldLogVerbose } from "../../globals.js";
import { sendMessageIMessage } from "../../imessage/index.js";
import { sendMessageSignal } from "../../signal/index.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { normalizeMessageProvider } from "../../utils/message-provider.js";
import { resolveDefaultWhatsAppAccountId } from "../../web/accounts.js";
import { sendMessageWhatsApp, sendPollWhatsApp } from "../../web/outbound.js";
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
      if (provider === "telegram") {
        const result = await sendMessageTelegram(to, message, {
          mediaUrl: request.mediaUrl,
          verbose: shouldLogVerbose(),
          accountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          chatId: result.chatId,
          provider,
        };
        context.dedupe.set(`send:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      } else if (provider === "discord") {
        const result = await sendMessageDiscord(to, message, {
          mediaUrl: request.mediaUrl,
          accountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          channelId: result.channelId,
          provider,
        };
        context.dedupe.set(`send:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      } else if (provider === "slack") {
        const result = await sendMessageSlack(to, message, {
          mediaUrl: request.mediaUrl,
          accountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          channelId: result.channelId,
          provider,
        };
        context.dedupe.set(`send:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      } else if (provider === "signal") {
        const result = await sendMessageSignal(to, message, {
          mediaUrl: request.mediaUrl,
          accountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          provider,
        };
        context.dedupe.set(`send:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      } else if (provider === "imessage") {
        const result = await sendMessageIMessage(to, message, {
          mediaUrl: request.mediaUrl,
          accountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          provider,
        };
        context.dedupe.set(`send:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      } else {
        const cfg = loadConfig();
        const targetAccountId =
          accountId ?? resolveDefaultWhatsAppAccountId(cfg);
        const result = await sendMessageWhatsApp(to, message, {
          mediaUrl: request.mediaUrl,
          verbose: shouldLogVerbose(),
          gifPlayback: request.gifPlayback,
          accountId: targetAccountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          toJid: result.toJid ?? `${to}@s.whatsapp.net`,
          provider,
        };
        context.dedupe.set(`send:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      }
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
    if (provider !== "whatsapp" && provider !== "discord") {
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
      if (provider === "discord") {
        const result = await sendPollDiscord(to, poll, { accountId });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          channelId: result.channelId,
          provider,
        };
        context.dedupe.set(`poll:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      } else {
        const cfg = loadConfig();
        const accountId =
          typeof request.accountId === "string" &&
          request.accountId.trim().length > 0
            ? request.accountId.trim()
            : resolveDefaultWhatsAppAccountId(cfg);
        const result = await sendPollWhatsApp(to, poll, {
          verbose: shouldLogVerbose(),
          accountId,
        });
        const payload = {
          runId: idem,
          messageId: result.messageId,
          toJid: result.toJid ?? `${to}@s.whatsapp.net`,
          provider,
        };
        context.dedupe.set(`poll:${idem}`, {
          ts: Date.now(),
          ok: true,
          payload,
        });
        respond(true, payload, undefined, { provider });
      }
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
