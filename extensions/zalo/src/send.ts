import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveZaloAccount } from "./accounts.js";
import type { ZaloFetch } from "./api.js";
import { sendMessage, sendPhoto } from "./api.js";
import { resolveZaloProxyFetch } from "./proxy.js";
import { resolveZaloToken } from "./token.js";

export type ZaloSendOptions = {
  token?: string;
  accountId?: string;
  cfg?: OpenClawConfig;
  mediaUrl?: string;
  caption?: string;
  verbose?: boolean;
  proxy?: string;
};

export type ZaloSendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

function toZaloSendResult(response: {
  ok?: boolean;
  result?: { message_id?: string };
}): ZaloSendResult {
  if (response.ok && response.result) {
    return { ok: true, messageId: response.result.message_id };
  }
  return { ok: false, error: "Failed to send message" };
}

async function runZaloSend(
  failureMessage: string,
  send: () => Promise<{ ok?: boolean; result?: { message_id?: string } }>,
): Promise<ZaloSendResult> {
  try {
    const result = toZaloSendResult(await send());
    return result.ok ? result : { ok: false, error: failureMessage };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

function resolveSendContext(options: ZaloSendOptions): {
  token: string;
  fetcher?: ZaloFetch;
} {
  if (options.cfg) {
    const account = resolveZaloAccount({
      cfg: options.cfg,
      accountId: options.accountId,
    });
    const token = options.token || account.token;
    const proxy = options.proxy ?? account.config.proxy;
    return { token, fetcher: resolveZaloProxyFetch(proxy) };
  }

  const token = options.token ?? resolveZaloToken(undefined, options.accountId).token;
  const proxy = options.proxy;
  return { token, fetcher: resolveZaloProxyFetch(proxy) };
}

function resolveValidatedSendContext(
  chatId: string,
  options: ZaloSendOptions,
): { ok: true; chatId: string; token: string; fetcher?: ZaloFetch } | { ok: false; error: string } {
  const { token, fetcher } = resolveSendContext(options);
  if (!token) {
    return { ok: false, error: "No Zalo bot token configured" };
  }
  const trimmedChatId = chatId?.trim();
  if (!trimmedChatId) {
    return { ok: false, error: "No chat_id provided" };
  }
  return { ok: true, chatId: trimmedChatId, token, fetcher };
}

function resolveSendContextOrFailure(
  chatId: string,
  options: ZaloSendOptions,
):
  | { context: { chatId: string; token: string; fetcher?: ZaloFetch } }
  | { failure: ZaloSendResult } {
  const context = resolveValidatedSendContext(chatId, options);
  return context.ok
    ? { context }
    : {
        failure: { ok: false, error: context.error },
      };
}

export async function sendMessageZalo(
  chatId: string,
  text: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const resolved = resolveSendContextOrFailure(chatId, options);
  if ("failure" in resolved) {
    return resolved.failure;
  }
  const { context } = resolved;

  if (options.mediaUrl) {
    return sendPhotoZalo(context.chatId, options.mediaUrl, {
      ...options,
      token: context.token,
      caption: text || options.caption,
    });
  }

  return await runZaloSend("Failed to send message", () =>
    sendMessage(
      context.token,
      {
        chat_id: context.chatId,
        text: text.slice(0, 2000),
      },
      context.fetcher,
    ),
  );
}

export async function sendPhotoZalo(
  chatId: string,
  photoUrl: string,
  options: ZaloSendOptions = {},
): Promise<ZaloSendResult> {
  const resolved = resolveSendContextOrFailure(chatId, options);
  if ("failure" in resolved) {
    return resolved.failure;
  }
  const { context } = resolved;

  if (!photoUrl?.trim()) {
    return { ok: false, error: "No photo URL provided" };
  }

  return await runZaloSend("Failed to send photo", () =>
    sendPhoto(
      context.token,
      {
        chat_id: context.chatId,
        photo: photoUrl.trim(),
        caption: options.caption?.slice(0, 2000),
      },
      context.fetcher,
    ),
  );
}
