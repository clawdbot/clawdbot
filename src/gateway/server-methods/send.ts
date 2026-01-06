import { loadConfig } from "../../config/config.js";
import { sendMessageDiscord, sendPollDiscord } from "../../discord/index.js";
import { shouldLogVerbose } from "../../globals.js";
import { sendMessageIMessage } from "../../imessage/index.js";
import { sendMessageSignal } from "../../signal/index.js";
import { sendMessageSlack } from "../../slack/send.js";
import { sendMessageTelegram } from "../../telegram/send.js";
import { resolveTelegramToken } from "../../telegram/token.js";
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
    const providerRaw = (request.provider ?? "whatsapp").toLowerCase();
    const provider = providerRaw === "imsg" ? "imessage" : providerRaw;
    try {
      if (provider === "telegram") {
        const cfg = loadConfig();
        const { token } = resolveTelegramToken(cfg);
        const result = await sendMessageTelegram(to, message, {
          mediaUrl: request.mediaUrl,
          verbose: shouldLogVerbose(),
          token: token || undefined,
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
          token: process.env.DISCORD_BOT_TOKEN,
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
        const cfg = loadConfig();
        const host = cfg.signal?.httpHost?.trim() || "127.0.0.1";
        const port = cfg.signal?.httpPort ?? 8080;
        const baseUrl = cfg.signal?.httpUrl?.trim() || `http://${host}:${port}`;
        const result = await sendMessageSignal(to, message, {
          mediaUrl: request.mediaUrl,
          baseUrl,
          account: cfg.signal?.account,
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
        const cfg = loadConfig();
        const result = await sendMessageIMessage(to, message, {
          mediaUrl: request.mediaUrl,
          cliPath: cfg.imessage?.cliPath,
          dbPath: cfg.imessage?.dbPath,
          maxBytes: cfg.imessage?.mediaMaxMb
            ? cfg.imessage.mediaMaxMb * 1024 * 1024
            : undefined,
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
        const result = await sendMessageWhatsApp(to, message, {
          mediaUrl: request.mediaUrl,
          verbose: shouldLogVerbose(),
          gifPlayback: request.gifPlayback,
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
    const providerRaw = (request.provider ?? "whatsapp").toLowerCase();
    const provider = providerRaw === "imsg" ? "imessage" : providerRaw;
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
    try {
      if (provider === "discord") {
        const result = await sendPollDiscord(to, poll);
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
        const result = await sendPollWhatsApp(to, poll, {
          verbose: shouldLogVerbose(),
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
