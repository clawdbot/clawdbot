// Signal plugin module implements send behavior.
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptPartKind,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { resolveOutboundAttachmentFromUrl } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveSignalAccount } from "./accounts.js";
import {
  appendSignalApprovalReactionHintForOutboundMessage,
  registerSignalApprovalReactionTargetForOutboundMessage,
} from "./approval-reactions.js";
import { signalRpcRequest } from "./client-adapter.js";
import { markdownToSignalText, type SignalTextStyleRange } from "./format.js";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { registerSignalReplyContext } from "./reply-authors.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalSendOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  account?: string;
  accountId?: string;
  mediaUrl?: string;
  mediaAccess?: {
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  };
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  maxBytes?: number;
  timeoutMs?: number;
  textMode?: "markdown" | "plain";
  textStyles?: SignalTextStyleRange[];
  replyToId?: string | null;
  replyToAuthor?: string | null;
  replyToBody?: string | null;
};

export type SignalSendResult = {
  messageId: string;
  timestamp?: number;
  receipt: MessageReceipt;
};

export type SignalRpcOpts = Pick<
  SignalSendOpts,
  "cfg" | "baseUrl" | "account" | "accountId" | "timeoutMs"
>;

export type SignalReceiptType = "read" | "viewed";

type SignalTarget =
  | { type: "recipient"; recipient: string }
  | { type: "group"; groupId: string }
  | { type: "username"; username: string };

async function resolveSignalRpcAccountInfo(opts: SignalRpcOpts) {
  if (opts.baseUrl?.trim() && opts.account?.trim()) {
    return undefined;
  }
  if (!opts.cfg) {
    throw new Error(
      "Signal RPC account resolution requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.",
    );
  }
  const cfg = requireRuntimeConfig(opts.cfg, "Signal RPC account resolution");
  return resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
}

function parseTarget(raw: string): SignalTarget {
  const value = normalizeSignalMessagingTarget(raw);
  if (!value) {
    throw new Error("Signal recipient is required");
  }
  const normalized = normalizeLowercaseStringOrEmpty(value);
  if (normalized.startsWith("group:")) {
    return { type: "group", groupId: value.slice("group:".length).trim() };
  }
  if (normalized.startsWith("username:")) {
    return {
      type: "username",
      username: value.slice("username:".length).trim(),
    };
  }
  return { type: "recipient", recipient: value };
}

type SignalTargetParams = {
  recipient?: string[];
  groupId?: string;
  username?: string[];
};

type SignalTargetAllowlist = {
  recipient?: boolean;
  group?: boolean;
  username?: boolean;
};

function buildTargetParams(
  target: SignalTarget,
  allow: SignalTargetAllowlist,
): SignalTargetParams | null {
  if (target.type === "recipient") {
    if (!allow.recipient) {
      return null;
    }
    return { recipient: [target.recipient] };
  }
  if (target.type === "group") {
    if (!allow.group) {
      return null;
    }
    return { groupId: target.groupId };
  }
  if (target.type === "username") {
    if (!allow.username) {
      return null;
    }
    return { username: [target.username] };
  }
  return null;
}

function createSignalSendReceipt(params: {
  messageId: string;
  timestamp?: number;
  target: SignalTarget;
  kind: MessageReceiptPartKind;
  replyToId?: string;
  nativeReplyStatus?: "sent" | "fallback";
}): MessageReceipt {
  const messageId = params.messageId.trim();
  const results: MessageReceiptSourceResult[] =
    messageId && messageId !== "unknown"
      ? [
          {
            channel: "signal",
            messageId,
            meta: {
              targetType: params.target.type,
              ...(params.replyToId
                ? {
                    replyToId: params.replyToId,
                    nativeReplyStatus: params.nativeReplyStatus ?? "sent",
                  }
                : {}),
            },
          },
        ]
      : [];
  if (results[0]) {
    if (params.timestamp != null) {
      results[0].timestamp = params.timestamp;
    }
    if (params.target.type === "group") {
      results[0].chatId = params.target.groupId;
    } else if (params.target.type === "recipient") {
      results[0].toJid = params.target.recipient;
    } else {
      results[0].toJid = params.target.username;
    }
  }
  return createMessageReceiptFromOutboundResults({
    results,
    kind: params.kind,
    ...(params.replyToId ? { replyToId: params.replyToId } : {}),
  });
}

function parseSignalReplyTimestamp(raw: string | null | undefined): number | undefined {
  const value = normalizeOptionalString(raw);
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return undefined;
  }
  return timestamp;
}

function resolveSignalQuoteParams(opts: SignalSendOpts):
  | {
      replyToId: string;
      params: Record<string, unknown>;
    }
  | undefined {
  const timestamp = parseSignalReplyTimestamp(opts.replyToId);
  const author = normalizeOptionalString(opts.replyToAuthor);
  if (timestamp === undefined || !author) {
    return undefined;
  }
  return {
    replyToId: String(timestamp),
    params: {
      quoteTimestamp: timestamp,
      quoteAuthor: author,
      quoteMessage: opts.replyToBody ?? "",
    },
  };
}

function isSignalQuoteMetadataRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = normalizeLowercaseStringOrEmpty(message);
  if (!normalized.includes("quote")) {
    return false;
  }
  return (
    normalized.includes("reject") ||
    normalized.includes("invalid") ||
    normalized.includes("unrecognized") ||
    normalized.includes("unsupported") ||
    normalized.includes("not found") ||
    normalized.includes("no such") ||
    normalized.includes("unknown")
  );
}

export async function sendMessageSignal(
  to: string,
  text: string,
  opts: SignalSendOpts,
): Promise<SignalSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Signal send");
  const apiMode = cfg.channels?.signal?.apiMode;
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const target = parseTarget(to);
  const targetAuthor = normalizeOptionalString(account);
  const targetAuthorUuid = normalizeOptionalString(accountInfo.config.accountUuid);
  const outboundText = appendSignalApprovalReactionHintForOutboundMessage({
    cfg,
    accountId: accountInfo.accountId,
    to,
    text: text ?? "",
    targetAuthor,
    targetAuthorUuid,
  });
  let message = outboundText;
  let messageFromPlaceholder = false;
  let textStyles: SignalTextStyleRange[] = [];
  const textMode = opts.textMode ?? "markdown";
  const maxBytes = (() => {
    if (typeof opts.maxBytes === "number") {
      return opts.maxBytes;
    }
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
    const resolved = await resolveOutboundAttachmentFromUrl(opts.mediaUrl.trim(), maxBytes, {
      mediaAccess: opts.mediaAccess,
      localRoots: opts.mediaLocalRoots,
      readFile: opts.mediaReadFile,
    });
    attachments = [resolved.path];
    const kind = kindFromMime(resolved.contentType ?? undefined);
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
      const tableMode = resolveMarkdownTableMode({
        cfg,
        channel: "signal",
        accountId: accountInfo.accountId,
      });
      const formatted = markdownToSignalText(message, { tableMode });
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
  if (account) {
    params.account = account;
  }
  if (attachments && attachments.length > 0) {
    params.attachments = attachments;
  }

  const targetParams = buildTargetParams(target, {
    recipient: true,
    group: true,
    username: true,
  });
  if (!targetParams) {
    throw new Error("Signal recipient is required");
  }
  Object.assign(params, targetParams);

  const quote = resolveSignalQuoteParams(opts);
  const sendOpts = {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode,
    maxAttachmentBytes: maxBytes,
  };
  let nativeReplyStatus: "sent" | "fallback" | undefined;
  let result: { timestamp?: number } | undefined;
  if (quote) {
    try {
      result = await signalRpcRequest<{ timestamp?: number }>(
        "send",
        { ...params, ...quote.params },
        sendOpts,
      );
      nativeReplyStatus = "sent";
    } catch (error) {
      if (!isSignalQuoteMetadataRejection(error)) {
        throw error;
      }
      result = await signalRpcRequest<{ timestamp?: number }>("send", params, sendOpts);
      nativeReplyStatus = "fallback";
    }
  } else {
    result = await signalRpcRequest<{ timestamp?: number }>("send", params, sendOpts);
  }
  const timestamp = result?.timestamp;
  const messageId = timestamp ? String(timestamp) : "unknown";
  const replyAuthor = targetAuthor ?? targetAuthorUuid;
  if (timestamp && replyAuthor) {
    await registerSignalReplyContext({
      accountId: accountInfo.accountId,
      to,
      replyToId: messageId,
      author: replyAuthor,
      body: message,
      sourceTimestamp: timestamp,
    });
  }
  registerSignalApprovalReactionTargetForOutboundMessage({
    cfg,
    accountId: accountInfo.accountId,
    to,
    messageId,
    text: outboundText,
    targetAuthor,
    targetAuthorUuid,
  });
  return {
    messageId,
    timestamp,
    receipt: createSignalSendReceipt({
      messageId,
      target,
      kind: attachments && attachments.length > 0 ? "media" : "text",
      ...(quote ? { replyToId: quote.replyToId, nativeReplyStatus } : {}),
      ...(timestamp != null ? { timestamp } : {}),
    }),
  };
}

export async function sendTypingSignal(
  to: string,
  opts: SignalRpcOpts & { stop?: boolean },
): Promise<boolean> {
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const cfg = requireRuntimeConfig(opts.cfg, "Signal typing");
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
    group: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = { ...targetParams };
  if (account) {
    params.account = account;
  }
  if (opts.stop) {
    params.stop = true;
  }
  await signalRpcRequest("sendTyping", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode: cfg.channels?.signal?.apiMode,
  });
  return true;
}

export async function sendReadReceiptSignal(
  to: string,
  targetTimestamp: number,
  opts: SignalRpcOpts & { type?: SignalReceiptType },
): Promise<boolean> {
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    return false;
  }
  const accountInfo = await resolveSignalRpcAccountInfo(opts);
  const cfg = requireRuntimeConfig(opts.cfg, "Signal read receipt");
  const { baseUrl, account } = resolveSignalRpcContext(opts, accountInfo);
  const targetParams = buildTargetParams(parseTarget(to), {
    recipient: true,
  });
  if (!targetParams) {
    return false;
  }
  const params: Record<string, unknown> = {
    ...targetParams,
    targetTimestamp,
    type: opts.type ?? "read",
  };
  if (account) {
    params.account = account;
  }
  await signalRpcRequest("sendReceipt", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
    apiMode: cfg.channels?.signal?.apiMode,
  });
  return true;
}
