// Imessage provider module implements model/runtime integration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveAgentConfig, resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelInboundDebouncer,
  formatInboundMediaUnavailableText,
  resolveEnvelopeFormatOptions,
  runChannelInboundEvent,
  shouldDebounceTextInbound,
  type ChannelInboundTurnPlan,
  type ChannelInboundMediaInput,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelMessageReplyPipeline,
  resolveChannelStreamingBlockEnabled,
} from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit, type GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { getRuntimeConfig, type OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose, shouldLogVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import {
  getSessionEntry,
  readSessionUpdatedAt,
  resolveSendPolicy,
  resolveStorePath,
} from "openclaw/plugin-sdk/session-store-runtime";
import { sliceUtf16Safe, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveIMessageAccount } from "../accounts.js";
import { pollPendingIMessageApprovalReactions } from "../approval-reaction-poller.js";
import { maybeResolveIMessageApprovalReaction } from "../approval-reactions.js";
import { markIMessageChatRead, sendIMessageTyping } from "../chat.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "../client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../constants.js";
import {
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "../media-contract.js";
import {
  getCachedIMessagePrivateApiStatus,
  imessageRpcSupportsMethod,
  probeIMessage,
} from "../probe.js";
import {
  hasIMessageQuestionReactionTarget,
  maybeResolveIMessageQuestionReaction,
} from "../question-reactions.js";
import { sendMessageIMessage } from "../send.js";
import { normalizeIMessageHandle } from "../targets.js";
import { attachIMessageMonitorAbortHandler } from "./abort-handler.js";
import { runIMessageCatchup } from "./catchup-bridge.js";
import { advanceIMessageCatchupCursor, resolveCatchupConfig } from "./catchup.js";
import {
  combineIMessagePayloads,
  hasIMessageBalloonMetadata,
  hasIMessageUrlBalloonBundleID,
  isStandaloneIMessageUrlPreviewPayload,
  shouldCombineIMessagePayloadBucket,
} from "./coalesce.js";
import { repairIMessageConversationAnchor } from "./conversation-repair.js";
import { createIMessageEchoCachingSend, deliverReplies } from "./deliver.js";
import { resolveIMessageDmHistoryContext, resolveIMessageDmHistoryLimit } from "./dm-history.js";
import { createIMessageThrottledDropDiagnosticCache } from "./drop-diagnostic-cache.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";
import {
  IMESSAGE_RECOVERY_MAX_AGE_MS,
  IMESSAGE_RECOVERY_MAX_ROWS,
  IMESSAGE_STALE_INBOUND_THRESHOLD_MS,
  isStaleIMessageBacklog,
} from "./inbound-dedupe.js";
import {
  buildDirectIMessageReplyTarget,
  buildIMessageInboundContext,
  mergeIMessageGroupAllowFromWithLegacyChatTargets,
  rememberIMessageSkippedFromMeForSelfChatDedupe,
  resolveIMessageReactionContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import {
  buildIMessageFlushIngressLifecycle,
  createIMessageDurableIngress,
  type IMessageIngressLifecycle,
} from "./ingress.js";
import { createLoopRateLimiter } from "./loop-rate-limiter.js";
import { stageIMessageAttachments } from "./media-staging.js";
import { createPollCommentFolder } from "./poll-comment.js";
import { renderIMessagePollBody } from "./poll-render.js";
import { enqueueIMessageReactionSystemEvent } from "./reaction-system-event.js";
import {
  advanceIMessageRecoveryCursor,
  loadIMessageRecoveryCursor,
  resolveIMessageRecoveryCursorDbIdentity,
} from "./recovery-cursor.js";
import { normalizeAllowList, resolveRuntime } from "./runtime.js";
import { createSelfChatCache } from "./self-chat-cache.js";
import type { IMessageAttachment, IMessagePayload, MonitorIMessageOpts } from "./types.js";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;
const APPROVAL_REACTION_POLL_INTERVAL_MS = 2_000;
const APPROVAL_REACTION_DISCOVERY_INTERVAL_MS = 60_000;
const IMESSAGE_TYPING_KEEPALIVE_INTERVAL_MS = 8_000;
const IMESSAGE_TYPING_KEEPALIVE_MAX_DURATION_MS = 10 * 60_000;
const IMESSAGE_SPLIT_SEND_COMPAT_DEBOUNCE_MS = 7_000;
type IMessageTypingController = Parameters<NonNullable<GetReplyOptions["onTypingController"]>>[0];

function resolveConfiguredIMessageTypingMode(cfg: OpenClawConfig, agentId: string) {
  return resolveAgentConfig(cfg, agentId)?.typingMode ?? cfg.agents?.defaults?.typingMode;
}

function resolveIMessageSplitSendCompatDebounceMs(
  cfg: OpenClawConfig,
  coalesceSameSenderDms: boolean,
): number | undefined {
  if (!coalesceSameSenderDms) {
    return undefined;
  }
  const inbound = cfg.messages?.inbound;
  const channelOverride = inbound?.byChannel?.imessage;
  if (typeof channelOverride === "number" && Number.isFinite(channelOverride)) {
    return undefined;
  }
  if (typeof inbound?.debounceMs === "number" && Number.isFinite(inbound.debounceMs)) {
    return undefined;
  }
  return IMESSAGE_SPLIT_SEND_COMPAT_DEBOUNCE_MS;
}

function isIMessagePluginPayloadAttachment(attachment: {
  original_path?: string | null;
  transfer_name?: string | null;
  uti?: string | null;
}): boolean {
  const attachmentPath = attachment.original_path?.trim().toLowerCase() ?? "";
  const transferName = attachment.transfer_name?.trim().toLowerCase() ?? "";
  const uti = attachment.uti?.trim().toLowerCase() ?? "";
  return (
    attachmentPath.endsWith(".pluginpayloadattachment") ||
    transferName.endsWith(".pluginpayloadattachment") ||
    uti === "com.apple.messages.pluginpayloadattachment"
  );
}

function resolveIMessageInboundMediaInput(params: {
  messageText: string;
  attachments: IMessageAttachment[];
  effectiveAttachmentRoots: readonly string[];
  logVerbose?: (message: string) => void;
}) {
  // Apple rich-link previews are opaque plugin payloads; the useful URL stays
  // in message text. Treating them as media creates phantom attachments and
  // keeps split-send URL previews out of the text debounce path.
  const mediaCandidates = params.attachments.filter(
    (entry) => !isIMessagePluginPayloadAttachment(entry),
  );
  const mediaFacts = mediaCandidates.map((attachment): ChannelInboundMediaInput => {
    const contentType = attachment.mime_type?.trim() || undefined;
    return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
  });
  const rawMediaAttachments = mediaCandidates.map((attachment, index) => {
    const fact = mediaFacts[index] ?? { kind: "unknown" as const };
    const attachmentPath = attachment.original_path?.trim();
    if (!attachmentPath || attachment.missing) {
      return fact;
    }
    if (
      !isInboundPathAllowed({ filePath: attachmentPath, roots: params.effectiveAttachmentRoots })
    ) {
      params.logVerbose?.(
        `imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`,
      );
      return fact;
    }
    return { ...fact, path: attachmentPath };
  });
  return {
    bodyText: params.messageText,
    mediaFacts,
    mediaCandidates,
    rawMediaAttachments,
  };
}

function formatIMessageInboundMediaBody(params: {
  messageText: string;
  unavailableCount: number;
}): string {
  return formatInboundMediaUnavailableText({
    body: params.messageText,
    notice: `[imessage ${params.unavailableCount > 1 ? `${params.unavailableCount} attachments` : "attachment"} unavailable]`,
  });
}

async function detectRemoteHostFromCliPath(cliPath: string): Promise<string | undefined> {
  try {
    const expanded = cliPath.startsWith("~")
      ? cliPath.replace(/^~/, process.env.HOME ?? "")
      : cliPath;
    const content = await fs.readFile(expanded, "utf8");

    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
    if (userHostMatch) {
      return userHostMatch[1];
    }

    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      logVerbose(
        `imessage: failed to inspect cliPath ${cliPath} for remoteHost detection: ${String(err)}`,
      );
    }
    return undefined;
  }
}

function resolveLocalMessagesHomeDir(): string | undefined {
  const home = process.env.HOME?.trim();
  if (home) {
    return home;
  }
  try {
    return os.homedir().trim() || undefined;
  } catch {
    return undefined;
  }
}

function resolveLocalMessagesDbPath(dbPath: string): string {
  if (!dbPath.startsWith("~")) {
    return dbPath;
  }
  const home = resolveLocalMessagesHomeDir();
  return home ? path.join(home, dbPath.slice(1).replace(/^\/+/, "")) : dbPath;
}

// Local chat.db path to read MAX(ROWID) from for the startup since_rowid. Only
// available when the gateway can read the DB directly (no remote bridge). On a
// remote `cliPath`, returns undefined and the startup window relies on imsg's
// own self-fence (see watch.subscribe comment).
function resolveIMessageWatchSourceDbPath(params: {
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
}): string | undefined {
  if (params.remoteHost) {
    return undefined;
  }
  const configured = params.dbPath?.trim();
  if (configured) {
    return configured;
  }
  const cliPath = params.cliPath.trim();
  if (cliPath !== "imsg" && path.basename(cliPath) !== "imsg") {
    return undefined;
  }
  const home = resolveLocalMessagesHomeDir();
  return home ? path.join(home, "Library", "Messages", "chat.db") : undefined;
}

async function resolveIMessageStartupRowidWatermark(dbPath: string): Promise<number | null> {
  const resolvedDbPath = resolveLocalMessagesDbPath(dbPath);
  let database:
    | {
        close: () => void;
        prepare: (sql: string) => { get: () => unknown };
      }
    | undefined;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(resolvedDbPath, { readOnly: true });
    const row = database.prepare("SELECT MAX(ROWID) AS maxRowid FROM message").get() as
      | { maxRowid?: unknown }
      | undefined;
    return typeof row?.maxRowid === "number" && Number.isFinite(row.maxRowid) ? row.maxRowid : null;
  } catch (err) {
    logVerbose(`imessage: startup rowid watermark unavailable for db=${dbPath}: ${String(err)}`);
    return null;
  } finally {
    database?.close();
  }
}

const warnIfImsgUpgradeNeeded = (() => {
  let fired = false;
  return {
    fireOnce: (
      rpcMethods: readonly string[],
      runtime: { log?: (msg: string) => void; error?: (msg: string) => void },
    ) => {
      if (fired) {
        return;
      }
      fired = true;
      const detail =
        rpcMethods.length === 0
          ? "imsg build pre-dates the rpc_methods capability list"
          : `imsg rpc_methods=[${rpcMethods.join(", ")}] does not include typing/read`;
      runtime.log?.(
        warn(
          `imessage: typing indicators / read receipts gated off (${detail}). ` +
            `Upgrade imsg (current bridge needs typing+read in rpc_methods).`,
        ),
      );
    },
  };
})();

function isRetriableWatchSubscribeStartupError(error: unknown): boolean {
  return /imsg rpc timeout \(watch\.subscribe\)|imsg rpc (closed|exited|not running)/i.test(
    String(error),
  );
}

const IMESSAGE_DIAGNOSTIC_DROP_REASONS = new Set([
  "agent echo in self-chat",
  "echo",
  "from me",
  "reflected assistant content",
  "self-chat echo",
]);
const IMESSAGE_THROTTLED_DIAGNOSTIC_DROP_REASONS = new Set(["from me"]);

function shouldThrottleIMessageInboundDropDiagnostic(reason: string): boolean {
  return IMESSAGE_THROTTLED_DIAGNOSTIC_DROP_REASONS.has(reason);
}

function describeIMessageInboundDropDiagnostic(params: {
  accountId: string;
  reason: string;
  message: Pick<IMessagePayload, "chat_id" | "created_at" | "guid" | "id" | "is_group">;
}): string | null {
  if (!IMESSAGE_DIAGNOSTIC_DROP_REASONS.has(params.reason)) {
    return null;
  }
  const messageId =
    typeof params.message.id === "number" || typeof params.message.id === "string"
      ? String(params.message.id)
      : "unknown";
  return (
    `imessage: dropped inbound message account=${params.accountId} reason=${JSON.stringify(
      params.reason,
    )} ` +
    `chat_id=${params.message.chat_id ?? "unknown"} group=${params.message.is_group === true} ` +
    `message_id=${messageId} guid=${params.message.guid ? "present" : "missing"} ` +
    `created_at=${params.message.created_at ?? "unknown"}`
  );
}

function describeIMessageWatchSubscribeStartupFailure(params: {
  accountId: string;
  attempt: number;
  maxAttempts: number;
  cliPath: string;
  dbPath?: string;
  remoteHost?: string;
  includeAttachments: boolean;
  probeTimeoutMs: number;
  watchSinceRowid: number | null;
  error: unknown;
  retryDelayMs?: number;
}): string {
  const retry = params.retryDelayMs !== undefined ? ` retry_in_ms=${params.retryDelayMs}` : "";
  return (
    `imessage: watch.subscribe startup failed attempt=${params.attempt}/${params.maxAttempts} ` +
    `account=${params.accountId} cliPath=${params.cliPath} ` +
    `dbPath=${params.dbPath ? "configured" : "default"} remoteHost=${
      params.remoteHost ? "configured" : "none"
    } ` +
    `timeoutMs=${params.probeTimeoutMs} since_rowid=${params.watchSinceRowid ?? "none"} ` +
    `attachments=${params.includeAttachments} include_reactions=true${retry}: ${String(
      params.error,
    )}`
  );
}

async function waitForWatchSubscribeRetryDelay(params: {
  ms: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (params.ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      params.abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, params.ms);
    const onAbort = () => {
      clearTimeout(timer);
      params.abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function monitorIMessageProvider(opts: MonitorIMessageOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? getRuntimeConfig();
  const accountInfo = resolveIMessageAccount({
    cfg,
    accountId: opts.accountId,
  });
  const imessageCfg = accountInfo.config;
  const historyLimit = Math.max(
    0,
    imessageCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const sentMessageCache = createSentMessageCache();
  const selfChatCache = createSelfChatCache();
  const loopRateLimiter = createLoopRateLimiter();
  const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
  const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
  const configuredGroupAllowFrom = opts.groupAllowFrom ?? imessageCfg.groupAllowFrom;
  const groupAllowFrom = normalizeAllowList(
    configuredGroupAllowFrom ??
      (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []),
  );
  const allowLegacyConversationAllowFromForGroup = configuredGroupAllowFrom == null;
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.imessage !== undefined,
    groupPolicy: imessageCfg.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "imessage",
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });
  // Mirror the runtime gate's effective sender allowlist so the startup
  // warning fires only for configs where every group message actually drops.
  const effectiveGroupAllowFrom = mergeIMessageGroupAllowFromWithLegacyChatTargets({
    groupAllowFrom,
    allowFrom,
    allowLegacyConversationTargets: allowLegacyConversationAllowFromForGroup,
  });
  warnGroupAllowlistMisconfigOnce({
    groupPolicy,
    hasGroupAllowFrom: effectiveGroupAllowFrom.length > 0,
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });
  const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
  const catchupCfg = resolveCatchupConfig(imessageCfg.catchup);
  const includeAttachments = opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
  const mediaMaxBytes = (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
  const cliPath = opts.cliPath ?? imessageCfg.cliPath ?? "imsg";
  const dbPath = opts.dbPath ?? imessageCfg.dbPath;
  const probeTimeoutMs = imessageCfg.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
  const attachmentRoots = resolveIMessageAttachmentRoots({
    cfg,
    accountId: accountInfo.accountId,
  });
  const remoteAttachmentRoots = resolveIMessageRemoteAttachmentRoots({
    cfg,
    accountId: accountInfo.accountId,
  });

  // Resolve remoteHost: explicit config, or auto-detect from SSH wrapper script.
  // Accept only a safe host token to avoid option/argument injection into SCP.
  const configuredRemoteHost = normalizeScpRemoteHost(imessageCfg.remoteHost);
  if (imessageCfg.remoteHost && !configuredRemoteHost) {
    logVerbose("imessage: ignoring unsafe channels.imessage.remoteHost value");
  }

  let remoteHost = configuredRemoteHost;
  if (!remoteHost && cliPath && cliPath !== "imsg") {
    const detected = await detectRemoteHostFromCliPath(cliPath);
    const normalizedDetected = normalizeScpRemoteHost(detected);
    if (detected && !normalizedDetected) {
      logVerbose("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
    }
    remoteHost = normalizedDetected;
    if (remoteHost) {
      logVerbose(`imessage: detected remoteHost=${remoteHost} from cliPath`);
    }
  }
  let staleBacklogSuppressed = 0;
  const loggedThrottledDropDiagnostics = createIMessageThrottledDropDiagnosticCache();

  // Downtime recovery. We pass the persisted recovery cursor (the last durably
  // admitted rowid) to watch.subscribe as since_rowid so imsg replays the rows
  // that landed while the gateway was down — over the same RPC client, so this
  // works for remote SSH `cliPath` setups too — then tails live. GUID tombstones
  // reject anything already completed.
  //
  // `recoveryBoundaryRowid` (M) is the local MAX(ROWID) at startup, read before
  // the transport probe. It is only available when the gateway can read chat.db
  // (not a remote bridge). When present it (a) caps the replay span to the most
  // recent IMESSAGE_RECOVERY_MAX_ROWS, and (b) splits the age fence: rows at or
  // below M are replay (delivered up to IMESSAGE_RECOVERY_MAX_AGE_MS old), rows
  // above M are live (the tighter fence where #89237's Push-flush backlog
  // appears). Without it (remote) the replay is uncapped and every row uses the
  // live fence, so recovery still delivers recently-missed messages and still
  // suppresses old backlog, just with the narrower live window.
  const watchSourceDbPath = resolveIMessageWatchSourceDbPath({ cliPath, dbPath, remoteHost });
  const recoveryBoundaryRowid = watchSourceDbPath
    ? await resolveIMessageStartupRowidWatermark(watchSourceDbPath)
    : null;
  // Scope the cursor to the resolved database so a dbPath/remoteHost change
  // starts from the new DB's watermark instead of a stale high-water (#99638).
  const recoveryCursorDbIdentity = resolveIMessageRecoveryCursorDbIdentity({
    cliPath,
    dbPath,
    remoteHost,
  });
  const recoveryCursorRowid = loadIMessageRecoveryCursor(
    accountInfo.accountId,
    recoveryCursorDbIdentity,
    { migrateLegacyCatchup: !catchupCfg.enabled },
  );
  const watchSinceRowid = catchupCfg.enabled
    ? null
    : recoveryCursorRowid !== null
      ? recoveryBoundaryRowid !== null
        ? Math.max(recoveryCursorRowid, recoveryBoundaryRowid - IMESSAGE_RECOVERY_MAX_ROWS)
        : recoveryCursorRowid
      : recoveryBoundaryRowid;

  const coalesceSameSenderDms = false;
  const debounceMsOverride = resolveIMessageSplitSendCompatDebounceMs(cfg, coalesceSameSenderDms);
  // Session capability latch: flips true once any inbound row from this imsg
  // build carries balloon metadata. The coalesce flush gate needs a build-level
  // signal because imsg omits `balloon_bundle_id` for plain rows.
  let imsgEmitsBalloonMetadata = false;
  let latestAdvancedRecoveryCursorRowid = recoveryCursorRowid ?? -1;
  const durableRecoveryCursorRowids = new Set<number>();
  const failedRecoveryCursorRowids = new Set<number>();

  function minSetValue(values: ReadonlySet<number>): number | null {
    let min: number | null = null;
    for (const value of values) {
      min = min === null ? value : Math.min(min, value);
    }
    return min;
  }

  function advanceRecoveryCursorAfterDurableEnqueue(rowid: number): void {
    if (catchupCfg.enabled) {
      return;
    }
    failedRecoveryCursorRowids.delete(rowid);
    durableRecoveryCursorRowids.add(rowid);
    const maxDurableRowid = Math.max(...durableRecoveryCursorRowids);
    const holdFloor = minSetValue(failedRecoveryCursorRowids);
    const nextCursorRowid =
      holdFloor !== null && maxDurableRowid >= holdFloor ? holdFloor - 1 : maxDurableRowid;

    if (nextCursorRowid >= 0 && nextCursorRowid > latestAdvancedRecoveryCursorRowid) {
      advanceIMessageRecoveryCursor(
        accountInfo.accountId,
        recoveryCursorDbIdentity,
        nextCursorRowid,
      );
      latestAdvancedRecoveryCursorRowid = nextCursorRowid;
      for (const durableRowid of durableRecoveryCursorRowids) {
        if (durableRowid <= nextCursorRowid) {
          durableRecoveryCursorRowids.delete(durableRowid);
        }
      }
    }
  }

  function holdRecoveryCursorBeforeFailedEnqueue(rowid: number | null): void {
    if (catchupCfg.enabled || rowid === null || rowid <= latestAdvancedRecoveryCursorRowid) {
      return;
    }
    failedRecoveryCursorRowids.add(rowid);
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<{
    message: IMessagePayload;
    ingressLifecycle?: IMessageIngressLifecycle;
  }>({
    cfg,
    channel: "imessage",
    debounceMsOverride,
    buildKey: (entry) => {
      const msg = entry.message;
      const sender = msg.sender?.trim();
      if (!sender) {
        return null;
      }
      const conversationId =
        msg.chat_id != null
          ? `chat:${msg.chat_id}`
          : (msg.chat_guid ?? msg.chat_identifier ?? "unknown");

      if (coalesceSameSenderDms && msg.is_group !== true) {
        return `imessage:${accountInfo.accountId}:dm:${conversationId}:${sender}`;
      }

      return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const msg = entry.message;
      if (resolveIMessageReactionContext(msg, (msg.text ?? "").trim())) {
        return false;
      }
      // From-me messages are cached, not processed — never debounce.
      if (msg.is_from_me === true) {
        return false;
      }

      // Opt-in DM coalescing holds rows long enough for Apple's command+URL
      // split-send to arrive. Group chats keep instant per-message dispatch.
      if (coalesceSameSenderDms) {
        return msg.is_group !== true;
      }

      // General same-sender inbound debounce: text-only, no control commands,
      // no media. Off by default unless messages.inbound is configured.
      return shouldDebounceTextInbound({
        text: msg.text,
        cfg,
        hasMedia: Boolean(
          msg.attachments?.some((attachment) => !isIMessagePluginPayloadAttachment(attachment)),
        ),
      });
    },
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }
      // Dispatch one unit (a single row or merged bucket). Every raw queue
      // claim in that unit follows the merged turn's adoption lifecycle.
      const dispatchUnit = async (
        unitEntries: { message: IMessagePayload; ingressLifecycle?: IMessageIngressLifecycle }[],
        message: IMessagePayload,
      ) => {
        const { lifecycle, settle, abandon } = buildIMessageFlushIngressLifecycle(
          unitEntries.flatMap((entry) => (entry.ingressLifecycle ? [entry.ingressLifecycle] : [])),
        );
        try {
          if (lifecycle?.abortSignal.aborted) {
            await abandon();
            return;
          }
          await handleMessageNow(message, lifecycle);
          await settle();
        } catch (err) {
          await abandon();
          runtime.error?.(`imessage: inbound dispatch failed: ${String(err)}`);
        }
      };

      if (entries.length === 1) {
        await dispatchUnit(
          entries,
          expectDefined(entries[0], "single iMessage dispatch entry").message,
        );
        return;
      }

      const messages = entries.map((e) => e.message);
      if (!shouldCombineIMessagePayloadBucket(messages, imsgEmitsBalloonMetadata)) {
        for (const entry of entries) {
          await dispatchUnit([entry], entry.message);
        }
        return;
      }
      // The bucket-level gate only says this window contains URL-balloon work.
      // Standalone URL preview rows merge with the immediately preceding row;
      // already-complete URL messages flush any pending ordinary row first.
      if (messages.some(hasIMessageUrlBalloonBundleID)) {
        let pending: {
          message: IMessagePayload;
          ingressLifecycle?: IMessageIngressLifecycle;
        } | null = null;
        for (const entry of entries) {
          if (isStandaloneIMessageUrlPreviewPayload(entry.message) && pending) {
            const unitEntries = [pending, entry];
            await dispatchUnit(
              unitEntries,
              combineIMessagePayloads(unitEntries.map((e) => e.message)),
            );
            pending = null;
            continue;
          }
          if (hasIMessageUrlBalloonBundleID(entry.message)) {
            if (pending) {
              await dispatchUnit([pending], pending.message);
              pending = null;
            }
            await dispatchUnit([entry], entry.message);
            continue;
          }
          if (pending) {
            await dispatchUnit([pending], pending.message);
          }
          pending = entry;
        }
        if (pending) {
          await dispatchUnit([pending], pending.message);
        }
        return;
      }
      const combined = combineIMessagePayloads(messages);
      if (shouldLogVerbose()) {
        const text = combined.text ?? "";
        const preview = sliceUtf16Safe(text, 0, 50);
        const ellipsis = text.length > 50 ? "..." : "";
        logVerbose(
          `[imessage] merged ${entries.length} debounced messages: "${preview}${ellipsis}"`,
        );
      }
      await dispatchUnit(entries, combined);
    },
    onError: (err) => {
      runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
    },
  });

  let client: IMessageRpcClient | undefined;
  let detachAbortHandler = () => {};
  let liveCatchupCursorAdvanceEnabled = false;
  let startupCatchupInProgress = false;
  const pendingLiveCatchupCursorAdvances: Array<{ lastSeenMs: number; lastSeenRowid: number }> = [];
  const getActiveClient = () => {
    if (!client) {
      throw new Error("imessage monitor client not initialized");
    }
    return client;
  };

  async function repairMessageConversationAnchor(
    message: IMessagePayload,
  ): Promise<IMessagePayload | null> {
    return await repairIMessageConversationAnchor({
      client: getActiveClient(),
      message,
      runtime,
    });
  }

  function resolveLiveCatchupCursor(
    message: IMessagePayload,
  ): { lastSeenMs: number; lastSeenRowid: number } | null {
    const coalescedCursor = (
      message as {
        coalescedCatchupCursor?: { lastSeenMs?: unknown; lastSeenRowid?: unknown };
      }
    ).coalescedCatchupCursor;
    const rowid =
      typeof coalescedCursor?.lastSeenRowid === "number" &&
      Number.isFinite(coalescedCursor.lastSeenRowid)
        ? coalescedCursor.lastSeenRowid
        : typeof message.id === "number" && Number.isFinite(message.id)
          ? message.id
          : null;
    const dateMs =
      typeof coalescedCursor?.lastSeenMs === "number" && Number.isFinite(coalescedCursor.lastSeenMs)
        ? coalescedCursor.lastSeenMs
        : typeof message.created_at === "string"
          ? Date.parse(message.created_at)
          : Number.NaN;
    if (rowid === null || !Number.isFinite(dateMs)) {
      return null;
    }
    return { lastSeenMs: dateMs, lastSeenRowid: rowid };
  }

  async function maybeAdvanceLiveCatchupCursor(message: IMessagePayload): Promise<void> {
    if (!catchupCfg.enabled) {
      return;
    }
    const cursor = resolveLiveCatchupCursor(message);
    if (!cursor) {
      return;
    }
    if (!liveCatchupCursorAdvanceEnabled) {
      if (startupCatchupInProgress) {
        pendingLiveCatchupCursorAdvances.push(cursor);
      }
      return;
    }
    try {
      await advanceIMessageCatchupCursor(accountInfo.accountId, cursor, catchupCfg);
    } catch (err) {
      runtime.error?.(`imessage catchup: failed to advance live cursor: ${String(err)}`);
    }
  }

  async function flushPendingLiveCatchupCursorAdvances(): Promise<void> {
    for (const cursor of pendingLiveCatchupCursorAdvances.splice(0)) {
      try {
        await advanceIMessageCatchupCursor(accountInfo.accountId, cursor, catchupCfg);
      } catch (err) {
        runtime.error?.(`imessage catchup: failed to advance pending live cursor: ${String(err)}`);
      }
    }
  }

  async function handleMessageNow(
    message: IMessagePayload,
    ingressLifecycle?: IMessageIngressLifecycle,
  ) {
    await handleMessageNowInner(message, ingressLifecycle);
  }

  // iMessage delivers a poll's comment as a separate inline reply to the poll
  // balloon; fold it into the poll so the agent votes once instead of also
  // replying to the caption in prose (a redundant restatement of the vote).
  const pollCommentFolder = createPollCommentFolder();

  function resolveIMessageInboundBodyText(message: IMessagePayload) {
    // Native poll balloons carry only a 0xFFFD placeholder in `text`; render the
    // decoded poll (question/options/votes) so the agent sees the actual poll.
    const pollBody = message.poll ? renderIMessagePollBody(message.poll) : null;
    const messageText = (pollBody ?? message.text ?? "").trim();
    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    const effectiveAttachmentRoots = remoteHost ? remoteAttachmentRoots : attachmentRoots;
    const mediaInput = resolveIMessageInboundMediaInput({
      messageText,
      attachments,
      effectiveAttachmentRoots,
      logVerbose,
    });
    return {
      messageText,
      ...mediaInput,
      effectiveAttachmentRoots,
    };
  }

  async function handleMessageNowInner(
    rawMessage: IMessagePayload,
    ingressLifecycle?: IMessageIngressLifecycle,
  ) {
    const message = await repairMessageConversationAnchor(rawMessage);
    if (!message) {
      return;
    }

    // Remember native polls so a caption reply that lands WITH the poll is
    // recognized and folded. The poll balloon (rendered with options + a vote
    // cue) is still delivered; only the near-simultaneous comment is dropped so
    // the agent votes without also answering it as a standalone question. A
    // deliberate later inline reply to the poll falls outside the window and is
    // delivered normally.
    const pollFoldAtMs = message.created_at ? Date.parse(message.created_at) : Number.NaN;
    if (message.poll) {
      pollCommentFolder.rememberPoll(message.guid, pollFoldAtMs, message.sender);
    } else if (
      message.reply_to_guid != null &&
      pollCommentFolder.isPollComment(message.reply_to_guid, pollFoldAtMs, message.sender)
    ) {
      logVerbose(
        "imessage: folding poll comment (inline reply sent with a poll) into the poll; not delivering standalone",
      );
      return;
    }

    const {
      messageText,
      bodyText,
      mediaFacts,
      mediaCandidates,
      rawMediaAttachments,
      effectiveAttachmentRoots,
    } = resolveIMessageInboundBodyText(message);

    // Approval reaction shortcut: if the inbound tapback resolves a pending
    // approval prompt, route it through the gateway and skip the normal
    // dispatch pipeline. This bypasses reactionNotifications gating so
    // approvals still work when general reaction surfacing is off, and it
    // bypasses allowFrom/dmPolicy because the approval-reactions module
    // enforces its own actor authorization via channels.imessage.allowFrom.
    if (
      await maybeResolveIMessageApprovalReaction({
        cfg,
        accountId: accountInfo.accountId,
        message,
        bodyText,
        logVerboseMessage: logVerbose,
      })
    ) {
      return;
    }

    const storeAllowFrom = await readChannelAllowFromStore(
      "imessage",
      process.env,
      accountInfo.accountId,
    ).catch(() => []);
    const isQuestionReaction = hasIMessageQuestionReactionTarget({
      accountId: accountInfo.accountId,
      message,
      bodyText,
    });
    const decision = await resolveIMessageInboundDecision({
      cfg,
      accountId: accountInfo.accountId,
      message,
      opts,
      messageText,
      bodyText,
      mediaFacts,
      allowFrom,
      groupAllowFrom,
      allowLegacyConversationAllowFromForGroup,
      groupPolicy,
      dmPolicy,
      storeAllowFrom,
      historyLimit,
      groupHistories,
      echoCache: sentMessageCache,
      selfChatCache,
      reactionNotifications: isQuestionReaction ? "all" : imessageCfg.reactionNotifications,
      logVerbose,
    });

    // Build conversation key for rate limiting (used by both drop and dispatch paths).
    const chatId = message.chat_id ?? undefined;
    const senderForKey = (message.sender ?? "").trim();
    const conversationKey = chatId != null ? `group:${chatId}` : `dm:${senderForKey}`;
    const rateLimitKey = `${accountInfo.accountId}:${conversationKey}`;

    if (decision.kind === "drop") {
      // Record echo/reflection drops so the rate limiter can detect sustained loops.
      // Only loop-related drop reasons feed the counter; policy/mention/empty drops
      // are normal and should not escalate.
      const isLoopDrop =
        decision.reason === "echo" ||
        decision.reason === "self-chat echo" ||
        decision.reason === "reflected assistant content" ||
        decision.reason === "from me";
      if (isLoopDrop) {
        loopRateLimiter.record(rateLimitKey);
      }
      const diagnostic = describeIMessageInboundDropDiagnostic({
        accountId: accountInfo.accountId,
        reason: decision.reason,
        message,
      });
      if (diagnostic) {
        const throttleKey = `${rateLimitKey}:${decision.reason}`;
        const shouldThrottleDiagnostic = shouldThrottleIMessageInboundDropDiagnostic(
          decision.reason,
        );
        if (!shouldThrottleDiagnostic || !loggedThrottledDropDiagnostics.check(throttleKey)) {
          runtime.log?.(warn(diagnostic));
        }
      }
      // Surface the silent-allowlist drop once per chat. Without this, operators
      // who set groupPolicy="allowlist" without populating
      // channels.imessage.groups see every group message vanish at default log
      // level. See issue #78749.
      if (decision.reason === "group id not in allowlist") {
        warnGroupAllowlistDropPerChatOnce({
          accountId: accountInfo.accountId,
          chatId: message.chat_id ?? undefined,
          log: (msg) => runtime.log?.(warn(msg)),
        });
      }
      return;
    }

    // After repeated echo/reflection drops for a conversation, suppress all
    // remaining messages as a safety net against amplification that slips
    // through the primary guards.
    if (decision.kind === "dispatch" && loopRateLimiter.isRateLimited(rateLimitKey)) {
      logVerbose(`imessage: rate-limited conversation ${conversationKey} (echo loop detected)`);
      return;
    }

    if (decision.kind === "pairing") {
      const sender = (message.sender ?? "").trim();
      if (!sender) {
        return;
      }
      await createChannelPairingChallengeIssuer({
        channel: "imessage",
        accountId: accountInfo.accountId,
        upsertPairingRequest: async ({ id, meta }) =>
          await upsertChannelPairingRequest({
            channel: "imessage",
            id,
            accountId: accountInfo.accountId,
            meta,
          }),
      })({
        senderId: decision.senderId,
        senderIdLine: `Your iMessage sender id: ${decision.senderId}`,
        meta: {
          sender: decision.senderId,
          chatId: chatId ? String(chatId) : undefined,
        },
        onCreated: () => {
          logVerbose(`imessage pairing request sender=${decision.senderId}`);
        },
        sendPairingReply: async (text) => {
          await sendMessageIMessage(sender, text, {
            config: cfg,
            client: getActiveClient(),
            maxBytes: mediaMaxBytes,
            accountId: accountInfo.accountId,
            ...(chatId ? { chatId } : {}),
          });
        },
        onReplyError: (err) => {
          // Pairing relies on the user receiving the challenge — silent
          // failure here is the user's only "pairing seems broken" signal.
          runtime.error?.(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
        },
      });
      return;
    }

    if (decision.kind === "reaction") {
      if (
        await maybeResolveIMessageQuestionReaction({
          cfg,
          accountId: accountInfo.accountId,
          message,
          bodyText,
          senderId: decision.senderNormalized,
          logDebug: logVerbose,
        })
      ) {
        return;
      }
      enqueueIMessageReactionSystemEvent({ decision, runtime, logVerbose });
      return;
    }

    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: decision.route.agentId,
    });
    const privateApiStatus = getCachedIMessagePrivateApiStatus(cliPath);
    const supportsTyping = imessageRpcSupportsMethod(privateApiStatus, "typing");
    const supportsRead = imessageRpcSupportsMethod(privateApiStatus, "read");
    if (privateApiStatus?.available === true) {
      // Surface a single warning per restart when the bridge is up but we
      // had to gate off typing/read because the imsg build pre-dates the
      // capability list. Otherwise the user sees no typing bubble / no
      // "Read" receipt with no visible reason.
      if (!supportsTyping || !supportsRead) {
        warnIfImsgUpgradeNeeded.fireOnce(privateApiStatus.rpcMethods, runtime);
      }
    }
    const configuredTypingMode = resolveConfiguredIMessageTypingMode(cfg, decision.route.agentId);
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: getSessionEntry({ storePath, sessionKey: decision.route.sessionKey }),
      sessionKey: decision.route.sessionKey,
      channel: "imessage",
      chatType: decision.isGroup ? "group" : "direct",
    });
    const shouldUseDirectToolTypingOptions =
      !decision.isGroup &&
      sendPolicy !== "deny" &&
      (configuredTypingMode === undefined || configuredTypingMode === "instant");
    const shouldStartDirectTyping = supportsTyping && shouldUseDirectToolTypingOptions;
    const earlyDirectTypingTarget = shouldStartDirectTyping
      ? buildDirectIMessageReplyTarget({
          cfg,
          accountId: decision.route.accountId,
          sender: decision.sender,
        })
      : undefined;
    let stopEarlyDirectTyping: (() => void) | undefined;
    if (earlyDirectTypingTarget) {
      // Start channel-native feedback before the expensive history/context/model
      // path. Use a short-lived client so a slow typing RPC cannot block the
      // monitor client's watch stream. Stop is sequenced after start so fast
      // command replies cannot leave a late true after typing:false.
      const earlyDirectTypingStarted = sendIMessageTyping(earlyDirectTypingTarget, true, {
        cfg,
        accountId: accountInfo.accountId,
      }).then(
        () => true,
        (err: unknown) => {
          logTypingFailure({
            log: (msg) => logVerbose(msg),
            channel: "imessage",
            action: "start",
            target: earlyDirectTypingTarget,
            error: err,
          });
          return false;
        },
      );
      let earlyTypingStopQueued = false;
      stopEarlyDirectTyping = () => {
        if (earlyTypingStopQueued) {
          return;
        }
        earlyTypingStopQueued = true;
        void earlyDirectTypingStarted
          .then(async (started) => {
            if (!started) {
              return;
            }
            await sendIMessageTyping(earlyDirectTypingTarget, false, {
              cfg,
              accountId: accountInfo.accountId,
            });
          })
          .catch((err: unknown) => {
            logTypingFailure({
              log: (msg) => logVerbose(msg),
              channel: "imessage",
              action: "stop",
              target: earlyDirectTypingTarget,
              error: err,
            });
          });
      };
    }
    const staged = remoteHost
      ? {
          attachments: rawMediaAttachments,
          unavailableCount: rawMediaAttachments.filter((attachment) => !attachment.path).length,
        }
      : await stageIMessageAttachments(mediaCandidates, {
          maxBytes: mediaMaxBytes,
          allowedRoots: effectiveAttachmentRoots,
          deps: { logVerbose },
        });
    const mediaAttachments = staged.attachments;
    const unavailableCount = staged.unavailableCount;
    const contextDecision =
      unavailableCount > 0
        ? {
            ...decision,
            agentBodyText: formatIMessageInboundMediaBody({
              messageText,
              unavailableCount,
            }),
          }
        : decision;
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: decision.route.sessionKey,
    });
    const dmHistoryLimit = !decision.isGroup
      ? resolveIMessageDmHistoryLimit({
          config: imessageCfg,
          sender: decision.sender,
          senderNormalized: decision.senderNormalized,
        })
      : 0;
    const dmHistory =
      !decision.isGroup && dmHistoryLimit > 0 && !previousTimestamp
        ? await resolveIMessageDmHistoryContext({
            client: getActiveClient(),
            message,
            senderNormalized: decision.senderNormalized,
            limit: dmHistoryLimit,
            envelopeOptions: resolveEnvelopeFormatOptions(cfg),
            logVerbose,
          })
        : undefined;
    const { ctxPayload, chatTarget, imessageTo } = await buildIMessageInboundContext({
      cfg,
      decision: contextDecision,
      message,
      previousTimestamp,
      remoteHost,
      historyLimit,
      groupHistories,
      dmHistory,
      media: {
        facts: mediaAttachments,
      },
    });

    const updateTarget = chatTarget || imessageTo;
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom,
      normalizeEntry: normalizeIMessageHandle,
    });
    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(ctxPayload.Body ?? "", 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${
          (ctxPayload.Body ?? "").length
        } preview="${preview}"`,
      );
    }

    const sendReadReceipts = imessageCfg.sendReadReceipts !== false;
    const typingTarget = ctxPayload.To;

    if (supportsRead && sendReadReceipts && typingTarget) {
      // Read receipts are best-effort channel UI. Do not put them on the
      // critical path before model dispatch; slow private-API reads otherwise
      // make accepted iMessage turns feel stuck before the agent starts. Use
      // a short-lived client so a stuck read cannot block monitor-client typing.
      void markIMessageChatRead(typingTarget, {
        cfg,
        accountId: accountInfo.accountId,
      }).catch((err: unknown) => {
        runtime.error?.(`imessage: mark read failed: ${String(err)}`);
      });
    }

    const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
      cfg,
      agentId: decision.route.agentId,
      channel: "imessage",
      accountId: decision.route.accountId,
      typing:
        supportsTyping && typingTarget
          ? {
              start: async () => {
                await sendIMessageTyping(typingTarget, true, {
                  cfg,
                  accountId: accountInfo.accountId,
                  client: getActiveClient(),
                });
              },
              stop: async () => {
                await sendIMessageTyping(typingTarget, false, {
                  cfg,
                  accountId: accountInfo.accountId,
                  client: getActiveClient(),
                });
              },
              // Keep the native typing bubble alive through long tool chains.
              // The dispatcher idle path below still owns teardown on final,
              // error, abort, or monitor shutdown.
              keepaliveIntervalMs: IMESSAGE_TYPING_KEEPALIVE_INTERVAL_MS,
              maxDurationMs: IMESSAGE_TYPING_KEEPALIVE_MAX_DURATION_MS,
              onStartError: (err) => {
                logTypingFailure({
                  log: (msg) => logVerbose(msg),
                  channel: "imessage",
                  action: "start",
                  target: typingTarget,
                  error: err,
                });
              },
              onStopError: (err) => {
                logTypingFailure({
                  log: (msg) => logVerbose(msg),
                  channel: "imessage",
                  action: "stop",
                  target: typingTarget,
                  error: err,
                });
              },
            }
          : undefined,
    });

    const dispatcherOptions = {
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
    };
    const delivery: ChannelInboundTurnPlan["delivery"] = {
      durable: ctxPayload.To
        ? {
            to: ctxPayload.To,
            deps: {
              imessage: createIMessageEchoCachingSend({
                accountId: accountInfo.accountId,
                sentMessageCache,
              }),
            },
          }
        : false,
      deliver: async (payload: Parameters<typeof deliverReplies>[0]["replies"][number]) => {
        const target = ctxPayload.To;
        if (!target) {
          runtime.error?.(danger("imessage: missing delivery target"));
          return;
        }
        await deliverReplies({
          cfg,
          replies: [payload],
          target,
          accountId: accountInfo.accountId,
          runtime,
          maxBytes: mediaMaxBytes,
          textLimit,
          sentMessageCache,
        });
      },
      onError: (err, info) => {
        runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
      },
    };
    let directTypingController: IMessageTypingController | undefined;
    const directToolTypingOptions = shouldUseDirectToolTypingOptions
      ? ({
          // iMessage's native typing bubble is channel-owned UI, not a
          // visible tool-progress message. The suppress flag is what lets
          // dispatch forward this callback even when verbose progress is off;
          // allowProgress covers message_tool_only source delivery. Keep this on
          // the direct instant/default path even when older imsg builds do not
          // report native typing support.
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onTypingController: (typing: IMessageTypingController) => {
            directTypingController = typing;
          },
          // Keep the channel-owned progress lane present even when private-API
          // typing is unavailable. Fast-mode notices are then consumed here
          // instead of falling back to a durable iMessage bubble.
          onToolResult: async () => {
            await directTypingController?.startTypingLoop();
          },
          ...(supportsTyping
            ? {
                onToolStart: async () => {
                  await directTypingController?.startTypingLoop();
                },
              }
            : {}),
        } as const)
      : {};
    const configuredBlockStreaming = resolveChannelStreamingBlockEnabled(accountInfo.config);
    const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
      route: decision.route,
      sessionKey: decision.route.sessionKey,
    });

    await runChannelInboundEvent({
      channel: "imessage",
      accountId: decision.route.accountId,
      raw: decision,
      adapter: {
        ingest: () => ({
          id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
          timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : undefined,
          rawText: ctxPayload.RawBody ?? "",
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: decision,
        }),
        resolveTurn: () => ({
          cfg,
          channel: "imessage",
          accountId: decision.route.accountId,
          route: {
            agentId: decision.route.agentId,
            sessionKey: decision.route.sessionKey,
          },
          ctxPayload,
          record: {
            updateLastRoute:
              !decision.isGroup && updateTarget
                ? {
                    sessionKey: inboundLastRouteSessionKey,
                    channel: "imessage",
                    to: updateTarget,
                    accountId: decision.route.accountId,
                    mainDmOwnerPin:
                      inboundLastRouteSessionKey === decision.route.mainSessionKey &&
                      pinnedMainDmOwner &&
                      decision.senderNormalized
                        ? {
                            ownerRecipient: pinnedMainDmOwner,
                            senderRecipient: decision.senderNormalized,
                            onSkip: ({ ownerRecipient, senderRecipient }) => {
                              logVerbose(
                                `imessage: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                              );
                            },
                          }
                        : undefined,
                  }
                : undefined,
            onRecordError: (err) => {
              logVerbose(`imessage: failed updating session meta: ${String(err)}`);
            },
          },
          history: {
            isGroup: decision.isGroup,
            historyKey: decision.historyKey,
            historyMap: groupHistories,
            limit: historyLimit,
          },
          delivery,
          dispatcherOptions: {
            ...dispatcherOptions,
            onSettled: () => stopEarlyDirectTyping?.(),
          },
          replyOptions: {
            ...(ingressLifecycle ? bindIngressLifecycleToReplyOptions(ingressLifecycle) : {}),
            disableBlockStreaming:
              typeof configuredBlockStreaming === "boolean" ? !configuredBlockStreaming : undefined,
            onModelSelected,
            ...directToolTypingOptions,
          },
        }),
        onFinalize: () => stopEarlyDirectTyping?.(),
      },
    });
  }

  const ingress = createIMessageDurableIngress({
    accountId: accountInfo.accountId,
    runtime,
    dispatch: async (message, ingressLifecycle, receivedAt, provenance) => {
      if (!imsgEmitsBalloonMetadata && hasIMessageBalloonMetadata(message)) {
        imsgEmitsBalloonMetadata = true;
      }
      // Age fence with two windows, split on the recovery boundary:
      //  - rows at/below recoveryBoundaryRowid are the downtime-recovery replay
      //    imsg emits from since_rowid — deliver them up to the wider recovery
      //    age, suppressing only ancient history.
      //  - rows above it are genuinely live — suppress at the tighter live
      //    threshold, which is where #89237's Push-flush backlog (old send date,
      //    fresh rowid) appears.
      // Logged at default level so suppressed traffic is never silent (#89237).
      const isRecoveryReplay =
        recoveryCursorRowid !== null &&
        recoveryBoundaryRowid !== null &&
        typeof message.id === "number" &&
        message.id <= recoveryBoundaryRowid;
      const staleThresholdMs = isRecoveryReplay
        ? IMESSAGE_RECOVERY_MAX_AGE_MS
        : IMESSAGE_STALE_INBOUND_THRESHOLD_MS;
      // Catchup rows are operator-requested history: the catchup query's own
      // maxAge window is their age gate. Running them through the live fence
      // would suppress AND tombstone rows older than 15 minutes — losing
      // messages the operator explicitly asked to replay.
      if (!provenance?.catchup && isStaleIMessageBacklog(message, receivedAt, staleThresholdMs)) {
        staleBacklogSuppressed += 1;
        runtime.log?.(
          warn(
            `imessage: suppressed stale inbound backlog account=${accountInfo.accountId} ` +
              `sent=${message.created_at ?? "unknown"} recovery=${isRecoveryReplay} ` +
              `(${staleBacklogSuppressed} suppressed since start)`,
          ),
        );
        // Returning completes the durable GUID claim. A later restart cannot
        // reinterpret this live-fence suppression under the wider replay fence.
        // Accepted overlap: a legacy-catchup redelivery of this GUID stays
        // tombstone-blocked, so Push-flush backlog suppressed here is not
        // recoverable via catchup either. The window is narrow (downtime
        // backlog + catchup enabled) and preferring it over releasable
        // suppressions keeps restart replay deterministic.
        return { kind: "completed" };
      }
      const repairedMessage = await repairMessageConversationAnchor(message);
      if (!repairedMessage) {
        return { kind: "completed" };
      }
      await inboundDebouncer.enqueue({
        message: repairedMessage,
        ingressLifecycle,
      });
      // Debounce owns the claim until its eventual flush adopts or abandons.
      return { kind: "deferred" };
    },
    onDurableEnqueue: async (facts) => {
      advanceRecoveryCursorAfterDurableEnqueue(facts.rowid);
      await maybeAdvanceLiveCatchupCursor({ id: facts.rowid, created_at: facts.createdAt });
    },
    onDurableEnqueueFailure: (rowid) => {
      holdRecoveryCursorBeforeFailedEnqueue(rowid);
    },
  });

  await waitForTransportReady({
    label: "imsg rpc",
    timeoutMs: 30_000,
    logAfterMs: 10_000,
    logIntervalMs: 10_000,
    pollIntervalMs: 500,
    abortSignal: opts.abortSignal,
    runtime,
    check: async () => {
      const probe = await probeIMessage(probeTimeoutMs, { cliPath, dbPath, runtime });
      if (probe.ok) {
        return { ok: true };
      }
      if (probe.fatal) {
        throw new Error(probe.error ?? "imsg rpc unavailable");
      }
      return { ok: false, error: probe.error ?? "unreachable" };
    },
  });

  if (opts.abortSignal?.aborted) {
    return;
  }
  const abort = opts.abortSignal;
  const createWatchClient = async () =>
    await createIMessageRpcClient({
      cliPath,
      dbPath,
      runtime,
      onNotification: (msg) => {
        if (msg.method === "message") {
          void ingress.receive(msg.params).catch((err: unknown) => {
            runtime.error?.(`imessage: durable admission failed: ${String(err)}`);
          });
        } else if (msg.method === "error") {
          runtime.error?.(
            `imessage: watch error ${JSON.stringify(sanitizeIMessageWatchErrorPayload(msg.params))}`,
          );
        }
      },
    });

  const requireWatchClient = (
    watchClient: IMessageRpcClient | null | undefined,
  ): IMessageRpcClient => {
    if (!watchClient) {
      throw new Error("imessage monitor client not initialized");
    }
    return watchClient;
  };

  for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (abort?.aborted) {
      return;
    }
    let attemptClient: IMessageRpcClient | undefined;
    let attemptDetachAbortHandler = () => {};
    let keepAttemptClient = false;
    try {
      attemptClient = requireWatchClient(await createWatchClient());
      let attemptSubscriptionId: number | null = null;
      attemptDetachAbortHandler = attachIMessageMonitorAbortHandler({
        abortSignal: abort,
        client: attemptClient,
        getSubscriptionId: () => attemptSubscriptionId,
      });
      // since_rowid = the recovery cursor (last durably admitted rowid, capped),
      // captured before the transport-ready probe, so imsg replays messages that
      // landed while the gateway was down and during the startup window instead
      // of self-fencing them at subscribe-time MAX(ROWID). When unavailable
      // (remote bridge) imsg self-fences at the current MAX(ROWID)
      // (MessageWatcher.start: `if cursor == 0 { cursor = maxRowID() }`), so it
      // tails new rows only. The replay's age is bounded by the recovery age
      // window in handleMessage; backlog Apple writes *after* subscribe (fresh
      // rowid, old send date) is handled by the live age fence.
      const result = await attemptClient.request<{ subscription?: number }>(
        "watch.subscribe",
        {
          attachments: includeAttachments,
          include_reactions: true,
          ...(watchSinceRowid !== null ? { since_rowid: watchSinceRowid } : {}),
        },
        { timeoutMs: probeTimeoutMs },
      );
      attemptSubscriptionId = result?.subscription ?? null;
      client = attemptClient;
      detachAbortHandler = attemptDetachAbortHandler;
      keepAttemptClient = true;
      break;
    } catch (err) {
      if (abort?.aborted) {
        return;
      }
      const shouldRetry =
        attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS && isRetriableWatchSubscribeStartupError(err);
      if (!shouldRetry) {
        runtime.error?.(
          danger(
            `imessage: monitor failed: ${describeIMessageWatchSubscribeStartupFailure({
              accountId: accountInfo.accountId,
              attempt,
              maxAttempts: WATCH_SUBSCRIBE_MAX_ATTEMPTS,
              cliPath,
              dbPath,
              remoteHost,
              includeAttachments,
              probeTimeoutMs,
              watchSinceRowid,
              error: err,
            })}`,
          ),
        );
        throw err;
      }
      runtime.log?.(
        warn(
          describeIMessageWatchSubscribeStartupFailure({
            accountId: accountInfo.accountId,
            attempt,
            maxAttempts: WATCH_SUBSCRIBE_MAX_ATTEMPTS,
            cliPath,
            dbPath,
            remoteHost,
            includeAttachments,
            probeTimeoutMs,
            watchSinceRowid,
            error: err,
            retryDelayMs: WATCH_SUBSCRIBE_RETRY_DELAY_MS,
          }),
        ),
      );
      // Tear down the failed client before waiting so a slow subscribe attempt
      // cannot keep emitting notifications into the next retry window.
      attemptDetachAbortHandler();
      attemptDetachAbortHandler = () => {};
      await attemptClient?.stop();
      attemptClient = undefined;
      await waitForWatchSubscribeRetryDelay({
        ms: WATCH_SUBSCRIBE_RETRY_DELAY_MS,
        abortSignal: abort,
      });
      if (abort?.aborted) {
        return;
      }
    } finally {
      if (!keepAttemptClient) {
        attemptDetachAbortHandler();
        await attemptClient?.stop();
      }
    }
  }

  const activeClient = client;
  if (!activeClient) {
    return;
  }
  ingress.start();

  // Register the iMessage approval native runtime context with the gateway so
  // proactive exec/plugin approval prompts can be delivered through the
  // imessageApprovalCapability's lazy nativeRuntime adapter. Without this
  // registration the adapter's `Boolean(context)` gates always fail and the
  // gateway can never push native approval prompts to iMessage targets — only
  // the reaction shortcut and `/approve` text fallback would work.
  const approvalContextLease = opts.channelRuntime
    ? registerChannelRuntimeContext({
        channelRuntime: opts.channelRuntime,
        channelId: "imessage",
        accountId: accountInfo.accountId,
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: { accountId: accountInfo.accountId },
        abortSignal: abort,
      })
    : undefined;
  let approvalReactionPollInFlight = false;
  const pollApprovalReactions = async (allowRecentChatDiscovery = false) => {
    if (approvalReactionPollInFlight) {
      return;
    }
    approvalReactionPollInFlight = true;
    try {
      await pollPendingIMessageApprovalReactions({
        client: activeClient,
        cfg,
        accountId: accountInfo.accountId,
        allowRecentChatDiscovery,
        logVerboseMessage: logVerbose,
      });
    } catch (err) {
      logVerbose(`imessage: approval reaction poll failed: ${String(err)}`);
    } finally {
      approvalReactionPollInFlight = false;
    }
  };
  const approvalReactionPollTimer = setInterval(() => {
    void pollApprovalReactions();
  }, APPROVAL_REACTION_POLL_INTERVAL_MS);
  const approvalReactionDiscoveryTimer = setInterval(() => {
    void pollApprovalReactions(true);
  }, APPROVAL_REACTION_DISCOVERY_INTERVAL_MS);
  void pollApprovalReactions(true);

  // Legacy opt-in catchup remains the compatibility path for users who
  // explicitly enabled it, including remote SSH setups where the gateway
  // cannot read chat.db for the always-on local startup cursor.
  if (catchupCfg.enabled && !abort?.aborted) {
    startupCatchupInProgress = true;
    try {
      const catchupSummary = await runIMessageCatchup({
        client: activeClient,
        accountId: accountInfo.accountId,
        config: catchupCfg,
        includeAttachments,
        // Legacy history rows enter the same durable GUID queue as watch rows.
        // A watch/catchup overlap is therefore rejected before either copy can
        // dispatch, replacing the retired standalone GUID guard.
        dispatchPayload: async (_message, rawEnvelope) => {
          await ingress.receive(rawEnvelope, { catchup: true });
        },
        observeSkippedFromMePayload: (message) => {
          const { bodyText } = resolveIMessageInboundBodyText(message);
          rememberIMessageSkippedFromMeForSelfChatDedupe({
            accountId: accountInfo.accountId,
            message,
            bodyText,
            selfChatCache,
          });
        },
        runtime,
      });
      liveCatchupCursorAdvanceEnabled =
        catchupSummary.querySucceeded && catchupSummary.fullyCaughtUp;
      if (liveCatchupCursorAdvanceEnabled) {
        await flushPendingLiveCatchupCursorAdvances();
      } else {
        pendingLiveCatchupCursorAdvances.length = 0;
      }
    } catch (err) {
      pendingLiveCatchupCursorAdvances.length = 0;
      runtime.error?.(`imessage catchup: pass failed: ${String(err)}`);
    } finally {
      startupCatchupInProgress = false;
    }
  }

  try {
    await activeClient.waitForClose();
  } catch (err) {
    if (abort?.aborted) {
      return;
    }
    runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
    throw err;
  } finally {
    clearInterval(approvalReactionPollTimer);
    clearInterval(approvalReactionDiscoveryTimer);
    approvalContextLease?.dispose();
    detachAbortHandler();
    await activeClient.stop();
    await ingress.stop();
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
