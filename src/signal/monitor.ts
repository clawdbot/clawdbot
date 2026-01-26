import { chunkTextWithMode, resolveChunkMode, resolveTextChunkLimit } from "../auto-reply/chunk.js";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "../auto-reply/reply/history.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { SignalReactionNotificationMode } from "../config/types.js";
import { saveMediaBuffer } from "../media/store.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeE164 } from "../utils.js";
import { waitForTransportReady } from "../infra/transport-ready.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalCheck, signalRpcRequest } from "./client.js";
import { spawnSignalDaemon } from "./daemon.js";
import { isSignalSenderAllowed, type resolveSignalSender } from "./identity.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import { sendMessageSignal } from "./send.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

type SignalReactionMessage = {
  emoji?: string | null;
  targetAuthor?: string | null;
  targetAuthorUuid?: string | null;
  targetSentTimestamp?: number | null;
  isRemove?: boolean | null;
  groupInfo?: {
    groupId?: string | null;
    groupName?: string | null;
  } | null;
};

type SignalAttachment = {
  id?: string | null;
  contentType?: string | null;
  filename?: string | null;
  size?: number | null;
};

export type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  accountId?: string;
  config?: ClawdbotConfig;
  baseUrl?: string;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  cliPath?: string;
  httpHost?: string;
  httpPort?: number;
  receiveMode?: "on-start" | "manual";
  ignoreAttachments?: boolean;
  ignoreStories?: boolean;
  sendReadReceipts?: boolean;
  allowFrom?: Array<string | number>;
  groupAllowFrom?: Array<string | number>;
  mediaMaxMb?: number;
};

function resolveRuntime(opts: MonitorSignalOpts): RuntimeEnv {
  return (
    opts.runtime ?? {
      log: console.log,
      error: console.error,
      exit: (code: number): never => {
        throw new Error(`exit ${code}`);
      },
    }
  );
}

function normalizeAllowList(raw?: Array<string | number>): string[] {
  return (raw ?? []).map((entry) => String(entry).trim()).filter(Boolean);
}

type SignalReactionTarget = {
  kind: "phone" | "uuid";
  id: string;
  display: string;
};

function resolveSignalReactionTargets(reaction: SignalReactionMessage): SignalReactionTarget[] {
  const targets: SignalReactionTarget[] = [];
  const uuid = reaction.targetAuthorUuid?.trim();
  if (uuid) {
    targets.push({ kind: "uuid", id: uuid, display: `uuid:${uuid}` });
  }
  const author = reaction.targetAuthor?.trim();
  if (author) {
    const normalized = normalizeE164(author);
    targets.push({ kind: "phone", id: normalized, display: normalized });
  }
  return targets;
}

function isSignalReactionMessage(
  reaction: SignalReactionMessage | null | undefined,
): reaction is SignalReactionMessage {
  if (!reaction) return false;
  const emoji = reaction.emoji?.trim();
  const timestamp = reaction.targetSentTimestamp;
  const hasTarget = Boolean(reaction.targetAuthor?.trim() || reaction.targetAuthorUuid?.trim());
  return Boolean(emoji && typeof timestamp === "number" && timestamp > 0 && hasTarget);
}

function shouldEmitSignalReactionNotification(params: {
  mode?: SignalReactionNotificationMode;
  account?: string | null;
  targets?: SignalReactionTarget[];
  sender?: ReturnType<typeof resolveSignalSender> | null;
  allowlist?: string[];
}) {
  const { mode, account, targets, sender, allowlist } = params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") return false;
  if (effectiveMode === "own") {
    const accountId = account?.trim();
    if (!accountId || !targets || targets.length === 0) return false;
    const normalizedAccount = normalizeE164(accountId);
    return targets.some((target) => {
      if (target.kind === "uuid") {
        return accountId === target.id || accountId === `uuid:${target.id}`;
      }
      return normalizedAccount === target.id;
    });
  }
  if (effectiveMode === "allowlist") {
    if (!sender || !allowlist || allowlist.length === 0) return false;
    return isSignalSenderAllowed(sender, allowlist);
  }
  return true;
}

function buildSignalReactionSystemEventText(params: {
  emojiLabel: string;
  actorLabel: string;
  messageId: string;
  targetLabel?: string;
  groupLabel?: string;
}) {
  const base = `Signal reaction added: ${params.emojiLabel} by ${params.actorLabel} msg ${params.messageId}`;
  const withTarget = params.targetLabel ? `${base} from ${params.targetLabel}` : base;
  return params.groupLabel ? `${withTarget} in ${params.groupLabel}` : withTarget;
}

async function waitForSignalDaemonReady(params: {
  baseUrl: string;
  abortSignal?: AbortSignal;
  timeoutMs: number;
  logAfterMs: number;
  logIntervalMs?: number;
  runtime: RuntimeEnv;
}): Promise<void> {
  await waitForTransportReady({
    label: "signal daemon",
    timeoutMs: params.timeoutMs,
    logAfterMs: params.logAfterMs,
    logIntervalMs: params.logIntervalMs,
    pollIntervalMs: 150,
    abortSignal: params.abortSignal,
    runtime: params.runtime,
    check: async () => {
      const res = await signalCheck(params.baseUrl, 1000);
      if (res.ok) return { ok: true };
      return {
        ok: false,
        error: res.error ?? (res.status ? `HTTP ${res.status}` : "unreachable"),
      };
    },
  });
}

async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  attachment: SignalAttachment;
  sender?: string;
  groupId?: string;
  maxBytes: number;
}): Promise<{ path: string; contentType?: string } | null> {
  const { attachment } = params;
  if (!attachment?.id) return null;
  if (attachment.size && attachment.size > params.maxBytes) {
    throw new Error(
      `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
    );
  }
  const rpcParams: Record<string, unknown> = {
    id: attachment.id,
  };
  if (params.account) rpcParams.account = params.account;
  if (params.groupId) rpcParams.groupId = params.groupId;
  else if (params.sender) rpcParams.recipient = params.sender;
  else return null;

  const result = await signalRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
  });
  if (!result?.data) return null;
  const buffer = Buffer.from(result.data, "base64");
  const saved = await saveMediaBuffer(
    buffer,
    attachment.contentType ?? undefined,
    "inbound",
    params.maxBytes,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverReplies(params: {
  replies: ReplyPayload[];
  target: string;
  baseUrl: string;
  account?: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  chunkMode: "length" | "newline";
}) {
  const { replies, target, baseUrl, account, accountId, runtime, maxBytes, textLimit, chunkMode } =
    params;
  for (const payload of replies) {
    const mediaList = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
    const text = payload.text ?? "";
    if (!text && mediaList.length === 0) continue;
    if (mediaList.length === 0) {
      for (const chunk of chunkTextWithMode(text, textLimit, chunkMode)) {
        await sendMessageSignal(target, chunk, {
          baseUrl,
          account,
          maxBytes,
          accountId,
        });
      }
    } else {
      let first = true;
      for (const url of mediaList) {
        const caption = first ? text : "";
        first = false;
        await sendMessageSignal(target, caption, {
          baseUrl,
          account,
          mediaUrl: url,
          maxBytes,
          accountId,
        });
      }
    }
    runtime.log?.(`delivered reply to ${target}`);
  }
}

export async function monitorSignalProvider(opts: MonitorSignalOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? loadConfig();
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: opts.accountId,
  });
  const historyLimit = Math.max(
    0,
    accountInfo.config.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const textLimit = resolveTextChunkLimit(cfg, "signal", accountInfo.accountId);
  const chunkMode = resolveChunkMode(cfg, "signal", accountInfo.accountId);
  const baseUrl = opts.baseUrl?.trim() || accountInfo.baseUrl;
  const account = opts.account?.trim() || accountInfo.config.account?.trim();
  const dmPolicy = accountInfo.config.dmPolicy ?? "pairing";
  const allowFrom = normalizeAllowList(opts.allowFrom ?? accountInfo.config.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      accountInfo.config.groupAllowFrom ??
      (accountInfo.config.allowFrom && accountInfo.config.allowFrom.length > 0
        ? accountInfo.config.allowFrom
        : []),
  );
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  const groupPolicy = accountInfo.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const reactionMode = accountInfo.config.reactionNotifications ?? "own";
  const reactionAllowlist = normalizeAllowList(accountInfo.config.reactionAllowlist);
  const mediaMaxBytes = (opts.mediaMaxMb ?? accountInfo.config.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments = opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments ?? false;
  const sendReadReceipts = Boolean(opts.sendReadReceipts ?? accountInfo.config.sendReadReceipts);

  const autoStart = opts.autoStart ?? accountInfo.config.autoStart ?? !accountInfo.config.httpUrl;
  const startupTimeoutMs = Math.min(
    120_000,
    Math.max(1_000, opts.startupTimeoutMs ?? accountInfo.config.startupTimeoutMs ?? 30_000),
  );
  const readReceiptsViaDaemon = Boolean(autoStart && sendReadReceipts);
  let daemonHandle: ReturnType<typeof spawnSignalDaemon> | null = null;

  if (autoStart) {
    const cliPath = opts.cliPath ?? accountInfo.config.cliPath ?? "signal-cli";
    const httpHost = opts.httpHost ?? accountInfo.config.httpHost ?? "127.0.0.1";
    const httpPort = opts.httpPort ?? accountInfo.config.httpPort ?? 8080;
    daemonHandle = spawnSignalDaemon({
      cliPath,
      account,
      httpHost,
      httpPort,
      receiveMode: opts.receiveMode ?? accountInfo.config.receiveMode,
      ignoreAttachments: opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments,
      ignoreStories: opts.ignoreStories ?? accountInfo.config.ignoreStories,
      sendReadReceipts,
      runtime,
    });
  }

  const onAbort = () => {
    daemonHandle?.stop();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (daemonHandle) {
      await waitForSignalDaemonReady({
        baseUrl,
        abortSignal: opts.abortSignal,
        timeoutMs: startupTimeoutMs,
        logAfterMs: 10_000,
        logIntervalMs: 10_000,
        runtime,
      });
    }

    const handleEvent = createSignalEventHandler({
      runtime,
      cfg,
      baseUrl,
      account,
      accountId: accountInfo.accountId,
      blockStreaming: accountInfo.config.blockStreaming,
      historyLimit,
      groupHistories,
      textLimit,
      dmPolicy,
      allowFrom,
      groupAllowFrom,
      groupPolicy,
      reactionMode,
      reactionAllowlist,
      mediaMaxBytes,
      ignoreAttachments,
      sendReadReceipts,
      readReceiptsViaDaemon,
      fetchAttachment,
      deliverReplies: (params) => deliverReplies({ ...params, chunkMode }),
      resolveSignalReactionTargets,
      isSignalReactionMessage,
      shouldEmitSignalReactionNotification,
      buildSignalReactionSystemEventText,
    });

    await runSignalSseLoop({
      baseUrl,
      account,
      abortSignal: opts.abortSignal,
      runtime,
      onEvent: (event) => {
        void handleEvent(event).catch((err) => {
          runtime.error?.(`event handler failed: ${String(err)}`);
        });
      },
    });
  } catch (err) {
    if (opts.abortSignal?.aborted) return;
    throw err;
  } finally {
    opts.abortSignal?.removeEventListener("abort", onAbort);
    daemonHandle?.stop();
  }
}
