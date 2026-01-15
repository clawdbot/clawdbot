import { loadConfig } from "../config/config.js";
import { mediaKindFromMime } from "../media/constants.js";
import { saveMediaBuffer } from "../media/store.js";
import { loadWebMedia } from "../web/media.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";

export type SignalSendOpts = {
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
};

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

function parseTarget(raw: string): SignalTarget {
  let value = raw.trim();
  if (!value) throw new Error("Signal recipient is required");
  const lower = value.toLowerCase();
  if (lower.startsWith("signal:")) {
    value = value.slice("signal:".length).trim();
  }
  const normalized = value.toLowerCase();
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  if (normalized.startsWith("u:")) {
    return { type: "username", username: value.trim() };
  }
  return { type: "recipient", recipient: value };
}

async function resolveAttachment(
  mediaUrl: string,
  maxBytes: number,
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(mediaUrl, maxBytes);
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts = {},
): Promise<SignalSendResult> {
  const cfg = loadConfig();
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const baseUrl = opts.baseUrl?.trim() || accountInfo.baseUrl;
  const account = opts.account?.trim() || accountInfo.config.account?.trim();
  const target = parseTarget(to);
  let message = text ?? "";
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") return opts.maxBytes;
    if (typeof accountInfo.config.mediaMaxMb === "number") {
      return accountInfo.config.mediaMaxMb * 1024 * 1024;
    }
    if (typeof cfg.agents?.defaults?.mediaMaxMb === "number") {
      return cfg.agents.defaults.mediaMaxMb * 1024 * 1024;
    }
    return 8 * 1024 * 1024;
  })();

  let attachments: string[] | undefined;
  if (opts.mediaUrl?.trim()) {
    const resolved = await resolveAttachment(opts.mediaUrl.trim(), maxBytes);
    attachments = [resolved.path];
    const kind = mediaKindFromMime(resolved.contentType ?? undefined);
    if (!message && kind) {
      // Avoid sending an empty body when only attachments exist.
      message = kind === "image" ? "<media:image>" : `<media:${kind}>`;
      messageFromPlaceholder = true;
    }
  }

  if (message.trim() && !messageFromPlaceholder) {
    if (textMode === "plain") {
      textStyles = opts.textStyles ?? [];
    } else {
      const formatted = markdownToSignalText(message);
      message = formatted.text;
      textStyles = formatted.styles;
    }
  }

  if (!message.trim() && (!attachments || attachments.length === 0)) {
    throw new Error("Signal send requires text or media");
  }

  const params: Record<string, unknown> = { message };
  if (textStyles.length > 0) {
    params["text-style"] = textStyles.map(
      (style) => `${style.start}:${style.length}:${style.style}`,
    );
  }
  if (account) params.account = account;
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  if (target.type === "recipient") {
    params.recipient = [target.recipient];
  } else if (target.type === "group") {
    params.groupId = target.groupId;
  } else if (target.type === "username") {
    params.username = [target.username];
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("send", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });
  const timestamp = result?.timestamp;
  return {
    messageId: timestamp ? String(timestamp) : "unknown",
    timestamp,
  };
}
