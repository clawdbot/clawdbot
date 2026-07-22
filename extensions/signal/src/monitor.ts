// Signal plugin module implements monitor behavior.
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { resolveChannelStreamingBlockEnabled } from "openclaw/plugin-sdk/channel-outbound";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  ReplyToMode,
  SignalReactionNotificationMode,
} from "openclaw/plugin-sdk/config-contracts";
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
  createReplyReferencePlanner,
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
  normalizeOptionalString,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveSignalAccount, resolveSignalReplyToMode } from "./accounts.js";
import { isSignalNativeApprovalHandlerConfigured } from "./approval-native.js";
import { addSignalApprovalReactionHintToStructuredPayload } from "./approval-reactions.js";
import { signalRpcRequest, signalCheck } from "./client-adapter.js";
import { formatSignalDaemonExit, spawnSignalDaemon, type SignalDaemonHandle } from "./daemon.js";
import { isSignalSenderAllowed, type resolveSignalSender } from "./identity.js";
import { createSignalEventHandler } from "./monitor/event-handler.js";
import type {
  SignalAttachment,
  SignalNativeReplyContext,
  SignalReactionMessage,
  SignalReactionTarget,
} from "./monitor/event-handler.types.js";
import { materializeSignalPresentationFallback } from "./presentation-fallback.js";
import { registerSignalReactionTargetsForDeliveredPayload } from "./reaction-targets.js";
import { sendMessageSignal } from "./send.js";
import { startSignalIngressMonitor, type SignalIngressMonitor } from "./signal-ingress.js";
import { runSignalSseLoop } from "./sse-reconnect.js";

export type MonitorSignalOpts = {
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  account?: string;
  accountId?: string;
  config?: OpenClawConfig;
  baseUrl?: string;
  channelRuntime?: ChannelRuntimeSurface;
  autoStart?: boolean;
  startupTimeoutMs?: number;
  cliPath?: string;
  configPath?: string;
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

function createSignalMonitorTaskRunner(runtime: RuntimeEnv) {
  const inFlight = new Set<Promise<void>>();
  return {
    runTask(task: () => Promise<void>): Promise<void> {
      const trackedTask = Promise.resolve().then(task);
      inFlight.add(trackedTask);
      void trackedTask.catch((err: unknown) =>
        runtime.error?.(`signal monitor task failed: ${String(err)}`),
      );
      void trackedTask.finally(() => inFlight.delete(trackedTask)).catch(() => undefined);
      return trackedTask;
    },
    async waitForIdle(): Promise<void> {
      while (inFlight.size > 0) {
        await Promise.allSettled(inFlight);
      }
    },
  };
}

function createSignalDaemonLifecycle(params: { abortSignal?: AbortSignal }) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonStopRequested = false;
  let daemonStopPromise: Promise<void> | undefined;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, daemonAbortController.signal])
    : daemonAbortController.signal;
  const stop = (): Promise<void> => {
    if (daemonStopPromise) {
      return daemonStopPromise;
    }
    daemonStopRequested = true;
    if (!daemonAbortController.signal.aborted) {
      daemonAbortController.abort(
        params.abortSignal?.reason ?? new Error("Signal monitor stopped"),
      );
    }
    daemonStopPromise = daemonHandle?.stop() ?? Promise.resolve();
    return daemonStopPromise;
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
    abortSignal,
  };
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

const SIGNAL_ATTACHMENT_RPC_RESPONSE_HEADROOM_BYTES = 64 * 1024;
const SIGNAL_BASE64_OVERHEAD_NUMERATOR = 4;
const SIGNAL_BASE64_OVERHEAD_DENOMINATOR = 3;

function deriveSignalAttachmentRpcMaxResponseBytes(maxBytes: number): number | undefined {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return undefined;
  }
  const base64Bytes = Math.ceil(
    (maxBytes * SIGNAL_BASE64_OVERHEAD_NUMERATOR) / SIGNAL_BASE64_OVERHEAD_DENOMINATOR,
  );
  return base64Bytes + SIGNAL_ATTACHMENT_RPC_RESPONSE_HEADROOM_BYTES;
}

async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  apiMode?: "native" | "container" | "auto";
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
    maxResponseBytes: deriveSignalAttachmentRpcMaxResponseBytes(params.maxBytes),
    apiMode: params.apiMode,
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

export async function deliverReplies(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  baseUrl: string;
  account?: string;
  accountUuid?: string;
  accountId?: string;
  runtime: RuntimeEnv;
  maxBytes: number;
  textLimit: number;
  chunkMode: "length" | "newline";
  replyContext?: SignalNativeReplyContext;
  chatType?: "direct" | "group";
}) {
  const {
    replies,
    target,
    baseUrl,
    account,
    accountUuid,
    accountId,
    runtime,
    maxBytes,
    textLimit,
    chunkMode,
  } = params;
  const replyToMode = resolveSignalReplyToMode({
    cfg: params.cfg,
    accountId,
    chatType: params.chatType,
  });
  for (const payload of replies) {
    const deliveryResults: Array<{
      channel: "signal";
      messageId: string;
      meta: { signalVisibleText: string };
    }> = [];
    const presentationPayload = materializeSignalPresentationFallback(payload);
    const deliveredPayload =
      addSignalApprovalReactionHintToStructuredPayload({
        cfg: params.cfg,
        accountId,
        to: target,
        payload: presentationPayload,
        targetAuthor: account,
        targetAuthorUuid: accountUuid,
      }) ?? presentationPayload;
    const reply = resolveSendableOutboundReplyParts(deliveredPayload);
    const nextNativeReply = createSignalNativeReplyResolver({
      payload: deliveredPayload,
      replyContext: params.replyContext,
      replyToMode,
    });
    const recordDeliveryResult = (
      result: Awaited<ReturnType<typeof sendMessageSignal>>,
      visibleText: string,
    ) => {
      const messageId =
        typeof result?.messageId === "string" && result.messageId.trim()
          ? result.messageId.trim()
          : null;
      if (messageId) {
        deliveryResults.push({
          channel: "signal",
          messageId,
          meta: { signalVisibleText: visibleText },
        });
      }
    };
    const delivered = await deliverTextOrMediaReply({
      payload: deliveredPayload,
      text: reply.text,
      chunkText: (value) => chunkTextWithMode(value, textLimit, chunkMode),
      sendText: async (chunk) => {
        recordDeliveryResult(
          await sendMessageSignal(target, chunk, {
            cfg: params.cfg,
            baseUrl,
            account,
            maxBytes,
            accountId,
            ...nextNativeReply(),
          }),
          chunk,
        );
      },
      sendMedia: async ({ mediaUrl, caption }) => {
        const visibleText = caption ?? "";
        recordDeliveryResult(
          await sendMessageSignal(target, visibleText, {
            cfg: params.cfg,
            baseUrl,
            account,
            mediaUrl,
            maxBytes,
            accountId,
            ...nextNativeReply(),
          }),
          visibleText,
        );
      },
    });
    if (delivered !== "empty") {
      registerSignalReactionTargetsForDeliveredPayload({
        cfg: params.cfg,
        target: {
          channel: "signal",
          to: target,
          accountId,
        },
        payload: deliveredPayload,
        results: deliveryResults,
        targetAuthor: account,
        targetAuthorUuid: accountUuid,
      });
      runtime.log?.(`delivered reply to ${target}`);
    }
  }
}

function resolveSignalNativeReplyOptions(params: {
  payload: ReplyPayload;
  replyContext?: SignalNativeReplyContext;
}): Pick<Parameters<typeof sendMessageSignal>[2], "replyToId" | "replyToAuthor" | "replyToBody"> {
  if (params.payload.replyToCurrent === false) {
    return {};
  }
  const payloadReplyToId = normalizeOptionalString(params.payload.replyToId);
  const isExplicitCurrentReply =
    params.payload.replyToTag === true || params.payload.replyToCurrent === true;
  if (
    !payloadReplyToId &&
    !isExplicitCurrentReply &&
    params.replyContext?.allowImplicitCurrentMessage === false
  ) {
    return {};
  }
  const contextReplyToId = normalizeOptionalString(params.replyContext?.replyToId);
  if (!contextReplyToId || (payloadReplyToId && payloadReplyToId !== contextReplyToId)) {
    return {};
  }
  const replyToId = payloadReplyToId ?? contextReplyToId;
  const replyToAuthor = normalizeOptionalString(params.replyContext?.author);
  if (!replyToAuthor) {
    return { replyToId };
  }
  return {
    replyToId,
    replyToAuthor,
    replyToBody: params.replyContext?.body ?? "",
  };
}

function isSignalStatusNoticePayload(payload: ReplyPayload): boolean {
  return Boolean(payload.isCompactionNotice || payload.isFallbackNotice || payload.isStatusNotice);
}

function createSignalNativeReplyResolver(params: {
  payload: ReplyPayload;
  replyContext?: SignalNativeReplyContext;
  replyToMode: ReplyToMode;
}): () => Pick<
  Parameters<typeof sendMessageSignal>[2],
  "replyToId" | "replyToAuthor" | "replyToBody"
> {
  const nativeReply = resolveSignalNativeReplyOptions(params);
  if (!nativeReply.replyToId) {
    return () => ({});
  }
  const isExplicitReply =
    params.payload.replyToTag === true || params.payload.replyToCurrent === true;
  const isStatusNotice = isSignalStatusNoticePayload(params.payload);
  if (isStatusNotice && params.replyToMode === "off") {
    return () => ({});
  }
  if (isExplicitReply) {
    return () => nativeReply;
  }
  if (isStatusNotice) {
    return () => nativeReply;
  }
  const planner = createReplyReferencePlanner({
    replyToMode: params.replyToMode,
    existingId: nativeReply.replyToId,
    hasReplied: params.replyContext?.state?.hasReplied,
  });
  return () => {
    const replyToId = planner.use();
    if (params.replyContext?.state && !isStatusNotice) {
      params.replyContext.state.hasReplied = planner.hasReplied();
    }
    return replyToId ? { ...nativeReply, replyToId } : {};
  };
}

export async function monitorSignalProvider(opts: MonitorSignalOpts = {}): Promise<void> {
  const runtime = opts.runtime ?? createNonExitingRuntime();
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
  const allowFrom = normalizeStringEntries(opts.allowFrom ?? accountInfo.config.allowFrom);
  const groupAllowFrom = normalizeStringEntries(
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
  const reactionAllowlist = normalizeStringEntries(accountInfo.config.reactionAllowlist);
  const mediaMaxBytes = (opts.mediaMaxMb ?? accountInfo.config.mediaMaxMb ?? 8) * 1024 * 1024;
  const ignoreAttachments = opts.ignoreAttachments ?? accountInfo.config.ignoreAttachments ?? false;
  const sendReadReceipts = Boolean(opts.sendReadReceipts ?? accountInfo.config.sendReadReceipts);
  const waitForTransportReadyFn = opts.waitForTransportReady ?? waitForTransportReady;

  const autoStart = opts.autoStart ?? accountInfo.config.autoStart ?? !accountInfo.config.httpUrl;
  const configuredApiMode = cfg.channels?.signal?.apiMode ?? "auto";
  const startupTimeoutMs = Math.min(
    120_000,
    Math.max(1_000, opts.startupTimeoutMs ?? accountInfo.config.startupTimeoutMs ?? 30_000),
  );
  const readReceiptsViaDaemon = autoStart && sendReadReceipts;
  const daemonLifecycle = createSignalDaemonLifecycle({ abortSignal: opts.abortSignal });
  const monitorTaskRunner = createSignalMonitorTaskRunner(runtime);
  let daemonHandle: SignalDaemonHandle | null = null;
  let ingressMonitor: SignalIngressMonitor | undefined;

  if (autoStart && configuredApiMode === "container") {
    throw new Error(
      "channels.signal.autoStart=true is incompatible with channels.signal.apiMode=container",
    );
  }

  if (autoStart) {
    const cliPath = opts.cliPath ?? accountInfo.config.cliPath ?? "signal-cli";
    const configPath =
      normalizeOptionalString(opts.configPath) ??
      normalizeOptionalString(accountInfo.config.configPath);
    const daemonUrl = new URL(baseUrl);
    const daemonHostname = daemonUrl.hostname;
    const httpHost =
      opts.httpHost ??
      (daemonHostname.startsWith("[") && daemonHostname.endsWith("]")
        ? daemonHostname.slice(1, -1)
        : daemonHostname);
    const httpPort =
      opts.httpPort ?? Number(daemonUrl.port || (daemonUrl.protocol === "https:" ? 443 : 80));
    daemonHandle = spawnSignalDaemon({
      cliPath,
      ...(configPath ? { configPath } : {}),
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

  const onAbort = () => void daemonLifecycle.stop();
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

    registerChannelRuntimeContext({
      channelRuntime: opts.channelRuntime,
      channelId: "signal",
      accountId: accountInfo.accountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: isSignalNativeApprovalHandlerConfigured({
        cfg,
        accountId: accountInfo.accountId,
      })
        ? {
            accountId: accountInfo.accountId,
            baseUrl,
            account,
            accountUuid: accountInfo.config.accountUuid,
          }
        : null,
      abortSignal: opts.abortSignal,
    });

    const handleEvent = createSignalEventHandler({
      runtime,
      abortSignal: daemonLifecycle.abortSignal,
      runTrackedTask: (task) => {
        void monitorTaskRunner.runTask(task);
      },
      cfg,
      baseUrl,
      account,
      accountUuid: accountInfo.config.accountUuid,
      accountId: accountInfo.accountId,
      blockStreaming: resolveChannelStreamingBlockEnabled(accountInfo.config),
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
      fetchAttachment: (params) => fetchAttachment({ ...params, apiMode: configuredApiMode }),
      deliverReplies: (params) => deliverReplies({ ...params, cfg, chunkMode }),
      resolveSignalReactionTargets,
      isSignalReactionMessage,
      shouldEmitSignalReactionNotification,
      buildSignalReactionSystemEventText,
    });

    ingressMonitor = await startSignalIngressMonitor({
      accountId: accountInfo.accountId,
      dispatch: handleEvent,
      runtime,
    });

    await runSignalSseLoop({
      baseUrl,
      account,
      abortSignal: daemonLifecycle.abortSignal,
      runtime,
      // signal-cli can keep the SSE event endpoint idle until the next inbound event.
      timeoutMs: 0,
      apiMode: configuredApiMode,
      policy: opts.reconnectPolicy,
      onEvent: (event) =>
        monitorTaskRunner.runTask(async () => await ingressMonitor?.receive(event)),
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
    await ingressMonitor?.stop();
    // Daemon attachment finishes before monitor tasks start. Keep teardown open until both the
    // child has exited and already-started reply work has drained.
    await Promise.all([daemonLifecycle.stop(), monitorTaskRunner.waitForIdle()]);
    opts.abortSignal?.removeEventListener("abort", onAbort);
  }
}
