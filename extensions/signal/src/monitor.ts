import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { SignalReactionNotificationMode } from "openclaw/plugin-sdk/config-types";
import {
  detectMime,
  estimateBase64DecodedBytes,
  saveMediaBuffer,
} from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import {
  deliverTextOrMediaReply,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  createNonExitingRuntime,
  type BackoffPolicy,
  type RuntimeEnv,
} from "openclaw/plugin-sdk/runtime-env";
import {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import {
  normalizeE164,
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/text-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalCheck, signalRpcRequest } from "./client.js";
import { formatSignalDaemonExit, spawnSignalDaemon, type SignalDaemonHandle } from "./daemon.js";
import { isSignalSenderAllowed, type resolveSignalSender } from "./identity.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import type {
  SignalAttachment,
  SignalReactionMessage,
  SignalReactionTarget,
} from "./monitor/event-handler.types.js";
import { sendMessageSignal } from "./send.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

export type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  accountId?: string;
  config?: OpenClawConfig;
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
  reconnectPolicy?: Partial<BackoffPolicy>;
  waitForTransportReady?: typeof waitForTransportReady;
};

function resolveRuntime(opts: MonitorSignalOpts): RuntimeEnv {
  return opts.runtime ?? createNonExitingRuntime();
}

function mergeAbortSignals(
  a?: AbortSignal,
  b?: AbortSignal,
): { signal?: AbortSignal; dispose: () => void } {
  if (!a && !b) {
    return { signal: undefined, dispose: () => {} };
  }
  if (!a) {
    return { signal: b, dispose: () => {} };
  }
  if (!b) {
    return { signal: a, dispose: () => {} };
  }
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) {
      controller.abort(source.reason);
    }
  };
  if (a.aborted) {
    abortFrom(a);
    return { signal: controller.signal, dispose: () => {} };
  }
  if (b.aborted) {
    abortFrom(b);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onAbortA = () => abortFrom(a);
  const onAbortB = () => abortFrom(b);
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener("abort", onAbortA);
      b.removeEventListener("abort", onAbortB);
    },
  };
}

function createSignalDaemonLifecycle(params: { abortSignal?: AbortSignal }) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonStopRequested = false;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const mergedAbort = mergeAbortSignals(params.abortSignal, daemonAbortController.signal);
  const stop = () => {
    daemonStopRequested = true;
    daemonHandle?.stop();
  };
  const attach = (handle: SignalDaemonHandle) => {
    daemonHandle = handle;
    void handle.exited.then((exit) => {
      if (daemonStopRequested || params.abortSignal?.aborted) {
        return;
      }
      daemonExitError = new Error(formatSignalDaemonExit(exit));
      if (!daemonAbortController.signal.aborted) {
        daemonAbortController.abort(daemonExitError);
      }
    });
  };
  const getExitError = () => daemonExitError;
  return {
    attach,
    stop,
    getExitError,
    abortSignal: mergedAbort.signal,
    dispose: mergedAbort.dispose,
  };
}

function normalizeAllowList(raw?: Array<string | number>): string[] {
  return normalizeStringEntries(raw);
}

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
  if (!reaction) {
    return false;
  }
  const emoji = reaction.emoji?.trim();
  const timestamp = reaction.targetSentTimestamp;
  const hasTarget = Boolean(
    normalizeOptionalString(reaction.targetAuthor) ||
    normalizeOptionalString(reaction.targetAuthorUuid),
  );
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
  if (effectiveMode === "off") {
    return false;
  }
  if (effectiveMode === "own") {
    const accountId = account?.trim();
    if (!accountId || !targets || targets.length === 0) {
      return false;
    }
    const normalizedAccount = normalizeE164(accountId);
    return targets.some((target) => {
      if (target.kind === "uuid") {
        return accountId === target.id || accountId === `uuid:${target.id}`;
      }
      return normalizedAccount === target.id;
    });
  }
  if (effectiveMode === "allowlist") {
    if (!sender || !allowlist || allowlist.length === 0) {
      return false;
    }
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
  waitForTransportReadyFn?: typeof waitForTransportReady;
}): Promise<void> {
  const waitForTransportReadyFn = params.waitForTransportReadyFn ?? waitForTransportReady;
  await waitForTransportReadyFn({
    label: "signal daemon",
    timeoutMs: params.timeoutMs,
    logAfterMs: params.logAfterMs,
    logIntervalMs: params.logIntervalMs,
    pollIntervalMs: 150,
    abortSignal: params.abortSignal,
    runtime: params.runtime,
    check: async () => {
      const res = await signalCheck(params.baseUrl, 1000);
      if (res.ok) {
        return { ok: true };
      }
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
  if (!attachment?.id) {
    return null;
  }
  if (typeof attachment.size === "number" && attachment.size > params.maxBytes) {
    throw new Error(
      `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
    );
  }
  const rpcParams: Record<string, unknown> = {
    id: attachment.id,
  };
  if (params.account) {
    rpcParams.account = params.account;
  }
  if (params.groupId) {
    rpcParams.groupId = params.groupId;
  } else if (params.sender) {
    rpcParams.recipient = params.sender;
  } else {
    return null;
  }

  const result = await signalRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
  });
  if (!result?.data) {
    return null;
  }
  if (estimateBase64DecodedBytes(result.data) > params.maxBytes) {
    throw new Error(
      `Signal attachment ${attachment.id} exceeds ${(params.maxBytes / (1024 * 1024)).toFixed(0)}MB limit`,
    );
  }
  const buffer = Buffer.from(result.data, "base64");
  const originalFilename = normalizeOptionalString(attachment.filename ?? undefined);
  const contentType =
    normalizeOptionalString(attachment.contentType ?? undefined) ??
    (await detectMime({ buffer, filePath: originalFilename }));
  const saved = await saveMediaBuffer(
    buffer,
    contentType,
    "inbound",
    params.maxBytes,
    originalFilename,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverReplies(params: {
  cfg: OpenClawConfig;
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
    const reply = resolveSendableOutboundReplyParts(payload);
    const delivered = await deliverTextOrMediaReply({
      payload,
      text: reply.text,
      chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
      sendText: async (chunk) => {
        await sendMessageSignal(target, chunk, {
          cfg: params.cfg,
          baseUrl,
          account,
          maxBytes,
          accountId,
        });
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        await sendMessageSignal(target, caption ?? "", {
          cfg: params.cfg,
          baseUrl,
          account,
          mediaUrl,
          maxBytes,
          accountId,
        });
      },
    });
    if (delivered !== "empty") {
      runtime.log?.(`delivered reply to ${target}`);
    }
  }
}

export async function monitorSignalProvider(opts: MonitorSignalOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? getRuntimeConfig();
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
  const baseUrl = normalizeOptionalString(opts.baseUrl) ?? accountInfo.baseUrl;
  const account =
    normalizeOptionalString(opts.account) ?? normalizeOptionalString(accountInfo.config.account);
  const dmPolicy = accountInfo.config.dmPolicy ?? "pairing";
  const allowFrom = normalizeAllowList(opts.allowFrom ?? accountInfo.config.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      accountInfo.config.groupAllowFrom ??
      (accountInfo.config.allowFrom && accountInfo.config.allowFrom.length > 0
        ? accountInfo.config.allowFrom
        : []),
  );
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.signal !== undefined,
      groupPolicy: accountInfo.config.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "signal",
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(message),
  });
  const reactionMode = accountInfo.config.reactionNotifications ?? "own";
  const reactionAllowlist = normalizeAllowList(accountInfo.config.reactionAllowlist);
  const mediaMaxBytes = (opts.mediaMaxMb ?? accountInfo.config.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments = opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments ?? false;
  const sendReadReceipts = Boolean(opts.sendReadReceipts ?? accountInfo.config.sendReadReceipts);
  const waitForTransportReadyFn = opts.waitForTransportReady ?? waitForTransportReady;

  const autoStart = opts.autoStart ?? accountInfo.config.autoStart ?? !accountInfo.config.httpUrl;
  const startupTimeoutMs = Math.min(
    120_000,
    Math.max(1_000, opts.startupTimeoutMs ?? accountInfo.config.startupTimeoutMs ?? 30_000),
  );
  const readReceiptsViaDaemon = autoStart && sendReadReceipts;
  const daemonLifecycle = createSignalDaemonLifecycle({ abortSignal: opts.abortSignal });
  let daemonHandle: SignalDaemonHandle | null = null;

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
    daemonLifecycle.attach(daemonHandle);
  }

  const onAbort = () => {
    daemonLifecycle.stop();
  };
  opts.abortSignal?.addEventListener("abort", onAbort, { once: true });

  try {
    if (daemonHandle) {
      await waitForSignalDaemonReady({
        baseUrl,
        abortSignal: daemonLifecycle.abortSignal,
        timeoutMs: startupTimeoutMs,
        logAfterMs: 10_000,
        logIntervalMs: 10_000,
        runtime,
        waitForTransportReadyFn,
      });
      const daemonExitError = daemonLifecycle.getExitError();
      if (daemonExitError) {
        throw daemonExitError;
      }
    }

    const handleEvent = createSignalEventHandler({
      runtime,
      cfg,
      baseUrl,
      account,
      accountUuid: accountInfo.config.accountUuid,
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
      deliverReplies: (params) => deliverReplies({ ...params, cfg, chunkMode }),
      resolveSignalReactionTargets,
      isSignalReactionMessage,
      shouldEmitSignalReactionNotification,
      buildSignalReactionSystemEventText,
    });

    await runSignalSseLoop({
      baseUrl,
      account,
      abortSignal: daemonLifecycle.abortSignal,
      runtime,
      policy: opts.reconnectPolicy,
      onEvent: (event) => {
        void handleEvent(event).catch((err) => {
          runtime.error?.(`event handler failed: ${String(err)}`);
        });
      },
    });
    const daemonExitError = daemonLifecycle.getExitError();
    if (daemonExitError) {
      throw daemonExitError;
    }
  } catch (err) {
    const daemonExitError = daemonLifecycle.getExitError();
    if (opts.abortSignal?.aborted && !daemonExitError) {
      return;
    }
    throw err;
  } finally {
    daemonLifecycle.dispose();
    opts.abortSignal?.removeEventListener("abort", onAbort);
    daemonLifecycle.stop();
  }
}
