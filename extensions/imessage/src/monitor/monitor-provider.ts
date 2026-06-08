// Imessage provider module implements model/runtime integration.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelInboundDebouncer,
  resolveEnvelopeFormatOptions,
  runChannelInboundEvent,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  deliverInboundReplyWithMessageSendContext,
  createChannelMessageReplyPipeline,
} from "openclaw/plugin-sdk/channel-outbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit, type GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
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
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
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
import { sendMessageIMessage } from "../send.js";
import { normalizeIMessageHandle } from "../targets.js";
import { attachIMessageMonitorAbortHandler } from "./abort-handler.js";
import { runIMessageCatchup } from "./catchup-bridge.js";
import { advanceIMessageCatchupCursor, resolveCatchupConfig } from "./catchup.js";
import {
  combineIMessagePayloads,
  hasIMessageBalloonMetadata,
  shouldCombineIMessagePayloadBucket,
} from "./coalesce.js";
import { repairIMessageConversationAnchor } from "./conversation-repair.js";
import { createIMessageEchoCachingSend, deliverReplies } from "./deliver.js";
import { resolveIMessageDmHistoryContext, resolveIMessageDmHistoryLimit } from "./dm-history.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";
import {
  buildIMessageInboundReplayKey,
  claimIMessageInboundReplay,
  commitIMessageInboundReplay,
  createIMessageInboundReplayGuard,
  IMESSAGE_RECOVERY_MAX_AGE_MS,
  IMESSAGE_RECOVERY_MAX_ROWS,
  IMESSAGE_STALE_INBOUND_THRESHOLD_MS,
  isStaleIMessageBacklog,
  releaseIMessageInboundReplay,
} from "./inbound-dedupe.js";
import {
  buildIMessageInboundContext,
  resolveIMessageReactionContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createLoopRateLimiter } from "./loop-rate-limiter.js";
import { stageIMessageAttachments } from "./media-staging.js";
import { parseIMessageNotification } from "./parse-notification.js";
import { enqueueIMessageReactionSystemEvent } from "./reaction-system-event.js";
import { advanceIMessageRecoveryCursor, loadIMessageRecoveryCursor } from "./recovery-cursor.js";
import { normalizeAllowList, resolveRuntime } from "./runtime.js";
import { createSelfChatCache } from "./self-chat-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;
const APPROVAL_REACTION_POLL_INTERVAL_MS = 2_000;
const APPROVAL_REACTION_DISCOVERY_INTERVAL_MS = 60_000;
const IMESSAGE_TYPING_KEEPALIVE_INTERVAL_MS = 8_000;
const IMESSAGE_TYPING_KEEPALIVE_MAX_DURATION_MS = 10 * 60_000;
type IMessageTypingController = Parameters<NonNullable<GetReplyOptions["onTypingController"]>>[0];

function resolveConfiguredIMessageTypingMode(cfg: OpenClawConfig) {
  return cfg.session?.typingMode ?? cfg.agents?.defaults?.typingMode;
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
  warnGroupAllowlistMisconfigOnce({
    groupPolicy,
    groups: imessageCfg.groups,
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
  // Inbound replay guard: dedupes already-seen messages (imsg re-emitting a
  // recent row on reconnect, or the downtime-recovery replay overlapping rows we
  // already handled) so nothing is dispatched twice. This is what lets recovery
  // replay aggressively without the old catchup cursor/retry bookkeeping.
  const inboundReplayGuard = createIMessageInboundReplayGuard();
  let staleBacklogSuppressed = 0;

  // Downtime recovery. We pass the persisted recovery cursor (the last
  // dispatched rowid) to watch.subscribe as since_rowid so imsg replays the rows
  // that landed while the gateway was down — over the same RPC client, so this
  // works for remote SSH `cliPath` setups too — then tails live. The GUID dedupe
  // drops anything already handled.
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
  const recoveryCursorRowid = loadIMessageRecoveryCursor(accountInfo.accountId, {
    migrateLegacyCatchup: !catchupCfg.enabled,
  });
  const watchSinceRowid = catchupCfg.enabled
    ? null
    : recoveryCursorRowid !== null
      ? recoveryBoundaryRowid !== null
        ? Math.max(recoveryCursorRowid, recoveryBoundaryRowid - IMESSAGE_RECOVERY_MAX_ROWS)
        : recoveryCursorRowid
      : recoveryBoundaryRowid;

  // When `coalesceSameSenderDms` is enabled and the user has not set an
  // explicit inbound debounce for this channel, widen the window to 2500 ms.
  // Apple's split-send for `<command> <URL>` arrives ~0.8-2.0 s apart on most
  // setups, so the legacy 0 ms default would flush the command alone before
  // the URL row reaches the debouncer.
  const coalesceSameSenderDms = imessageCfg.coalesceSameSenderDms === true;
  const inboundCfg = cfg.messages?.inbound;
  const hasExplicitInboundDebounce =
    typeof inboundCfg?.debounceMs === "number" ||
    typeof inboundCfg?.byChannel?.imessage === "number";
  const debounceMsOverride =
    coalesceSameSenderDms && !hasExplicitInboundDebounce ? 2500 : undefined;

  // Session capability latch: flips true once any inbound row from this imsg
  // build carries balloon metadata. The coalesce flush gate needs a build-level
  // (not per-bucket) signal because imsg omits `balloon_bundle_id` for plain
  // rows, so a bucket of plain text looks identical on old and new builds.
  let imsgEmitsBalloonMetadata = false;
  let recoveryCursorHoldBeforeRowid: number | null = null;
  let latestAdvancedRecoveryCursorRowid = recoveryCursorRowid ?? -1;
  const pendingRecoveryReplayRowids = new Set<number>();
  const handledRecoveryCursorRowids = new Set<number>();

  function collectFiniteRowids(
    entries: readonly { message: Pick<IMessagePayload, "id"> }[],
  ): number[] {
    const rowids: number[] = [];
    for (const entry of entries) {
      if (typeof entry.message.id === "number" && Number.isFinite(entry.message.id)) {
        rowids.push(entry.message.id);
      }
    }
    return rowids;
  }

  function holdRecoveryCursorBeforeFailedRows(
    entries: readonly { message: Pick<IMessagePayload, "id"> }[],
  ): void {
    if (catchupCfg.enabled || recoveryCursorRowid === null) {
      return;
    }
    if (recoveryBoundaryRowid === null) {
      return;
    }
    const failedReplayRowids = collectFiniteRowids(entries).filter(
      (rowid) => rowid <= recoveryBoundaryRowid,
    );
    if (failedReplayRowids.length === 0) {
      return;
    }

    const firstFailedRowid = Math.min(...failedReplayRowids);
    for (const rowid of failedReplayRowids) {
      pendingRecoveryReplayRowids.delete(rowid);
    }
    recoveryCursorHoldBeforeRowid =
      recoveryCursorHoldBeforeRowid === null
        ? firstFailedRowid
        : Math.min(recoveryCursorHoldBeforeRowid, firstFailedRowid);
  }

  function trackPendingRecoveryReplayRow(message: Pick<IMessagePayload, "id">): void {
    if (catchupCfg.enabled || recoveryCursorRowid === null || recoveryBoundaryRowid === null) {
      return;
    }
    if (
      typeof message.id === "number" &&
      Number.isFinite(message.id) &&
      message.id <= recoveryBoundaryRowid
    ) {
      pendingRecoveryReplayRowids.add(message.id);
    }
  }

  function minSetValue(values: ReadonlySet<number>): number | null {
    let min: number | null = null;
    for (const value of values) {
      min = min === null ? value : Math.min(min, value);
    }
    return min;
  }

  function resolveRecoveryCursorHoldFloor(): number | null {
    const pendingFloor = minSetValue(pendingRecoveryReplayRowids);
    if (pendingFloor === null) {
      return recoveryCursorHoldBeforeRowid;
    }
    if (recoveryCursorHoldBeforeRowid === null) {
      return pendingFloor;
    }
    return Math.min(pendingFloor, recoveryCursorHoldBeforeRowid);
  }

  function advanceRecoveryCursorAfterHandled(
    entries: readonly { message: Pick<IMessagePayload, "id"> }[],
  ): void {
    if (catchupCfg.enabled) {
      return;
    }
    const rowids = collectFiniteRowids(entries);
    if (rowids.length === 0) {
      return;
    }
    for (const rowid of rowids) {
      pendingRecoveryReplayRowids.delete(rowid);
      handledRecoveryCursorRowids.add(rowid);
    }

    const maxHandledRowid = Math.max(...handledRecoveryCursorRowids);
    const holdFloor = resolveRecoveryCursorHoldFloor();
    const nextCursorRowid =
      holdFloor !== null && maxHandledRowid >= holdFloor ? holdFloor - 1 : maxHandledRowid;

    if (nextCursorRowid >= 0 && nextCursorRowid > latestAdvancedRecoveryCursorRowid) {
      advanceIMessageRecoveryCursor(accountInfo.accountId, nextCursorRowid);
      latestAdvancedRecoveryCursorRowid = nextCursorRowid;
      for (const rowid of handledRecoveryCursorRowids) {
        if (rowid <= nextCursorRowid) {
          handledRecoveryCursorRowids.delete(rowid);
        }
      }
    }
  }

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<{
    message: IMessagePayload;
    // Exact replay-guard key claimed for this row at ingestion (GUID or, for a
    // GUID-less row, the composite fallback). Carried through so flush commits
    // or releases the same key it claimed, even after coalescing rewrites the
    // payload identity. null when the row had no derivable key (fail open).
    replayKey: string | null;
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

      // With coalesceSameSenderDms enabled, DMs key on chat:sender so Apple's
      // split text row and URL-balloon row land in the same bucket. The flush
      // path still requires imsg's structural balloon metadata before merging.
      // Group chats keep the legacy key to preserve multi-user turn structure.
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

      // Hold opt-in DMs long enough for a following URL-balloon row to arrive.
      // The flush gate (shouldCombineIMessagePayloadBucket) decides merge vs.
      // separate: it merges precisely on imsg's balloon marker, and falls back
      // to a legacy merge only when the build emits no balloon metadata at all.
      if (coalesceSameSenderDms) {
        return msg.is_group !== true;
      }

      // Legacy gate: text-only, no control commands, no media.
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
      // Dispatch one unit (a single row or a coalesced bucket), then commit the
      // exact replay keys that were claimed at ingestion, or release them if
      // dispatch throws so a transient failure can retry on a later re-emit. Per
      // unit so a failure in one bucket entry cannot strand another's claim.
      const dispatchUnit = async (
        unitEntries: { message: IMessagePayload; replayKey: string | null }[],
        message: IMessagePayload,
      ) => {
        const keys = unitEntries
          .map((entry) => entry.replayKey)
          .filter((key): key is string => key !== null);
        try {
          await handleMessageNow(message);
          await commitIMessageInboundReplay({
            guard: inboundReplayGuard,
            accountId: accountInfo.accountId,
            keys,
          });
          advanceRecoveryCursorAfterHandled(unitEntries);
        } catch (err) {
          holdRecoveryCursorBeforeFailedRows(unitEntries);
          releaseIMessageInboundReplay({
            guard: inboundReplayGuard,
            accountId: accountInfo.accountId,
            keys,
            error: err,
          });
          runtime.error?.(`imessage: inbound dispatch failed: ${String(err)}`);
        }
      };

      if (entries.length === 1) {
        await dispatchUnit(entries, entries[0].message);
        return;
      }

      const messages = entries.map((e) => e.message);
      if (!shouldCombineIMessagePayloadBucket(messages, imsgEmitsBalloonMetadata)) {
        for (const entry of entries) {
          await dispatchUnit([entry], entry.message);
        }
        return;
      }

      const combined = combineIMessagePayloads(messages);
      if (shouldLogVerbose()) {
        const text = combined.text ?? "";
        const preview = text.slice(0, 50);
        const ellipsis = text.length > 50 ? "..." : "";
        logVerbose(`[imessage] coalesced ${entries.length} messages: "${preview}${ellipsis}"`);
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
    options: { advanceCatchupCursor?: boolean } = {},
  ) {
    await handleMessageNowInner(message);
    if (options.advanceCatchupCursor !== false) {
      await maybeAdvanceLiveCatchupCursor(message);
    }
  }

  async function handleMessageNowInner(rawMessage: IMessagePayload) {
    const message = await repairMessageConversationAnchor(rawMessage);
    if (!message) {
      return;
    }

    const messageText = (message.text ?? "").trim();

    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    const effectiveAttachmentRoots = remoteHost ? remoteAttachmentRoots : attachmentRoots;
    const validAttachments = attachments.filter((entry) => {
      if (isIMessagePluginPayloadAttachment(entry)) {
        // Apple rich-link previews arrive as opaque .pluginPayloadAttachment
        // files. The useful URL remains in message.text/attributedBody; treating
        // the preview blob as media creates noisy phantom attachments and can
        // keep split-send URL previews out of the text debounce path.
        return false;
      }
      const attachmentPath = entry?.original_path?.trim();
      if (!attachmentPath || entry?.missing) {
        return false;
      }
      if (isInboundPathAllowed({ filePath: attachmentPath, roots: effectiveAttachmentRoots })) {
        return true;
      }
      logVerbose(`imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`);
      return false;
    });
    const rawMediaAttachments = validAttachments.flatMap((a) => {
      const attachmentPath = a.original_path?.trim();
      return attachmentPath
        ? [{ path: attachmentPath, contentType: a.mime_type ?? undefined }]
        : [];
    });
    const placeholderMediaType = rawMediaAttachments[0]?.contentType;
    const kind = kindFromMime(placeholderMediaType ?? undefined);
    const placeholder = kind
      ? `<media:${kind}>`
      : validAttachments.length
        ? "<media:attachment>"
        : "";
    const bodyText = messageText || placeholder;

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
    const decision = await resolveIMessageInboundDecision({
      cfg,
      accountId: accountInfo.accountId,
      message,
      opts,
      messageText,
      bodyText,
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
      reactionNotifications: imessageCfg.reactionNotifications,
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
      enqueueIMessageReactionSystemEvent({ decision, runtime, logVerbose });
      return;
    }

    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: decision.route.agentId,
    });
    const stagedAttachments = remoteHost
      ? []
      : await stageIMessageAttachments(validAttachments, {
          maxBytes: mediaMaxBytes,
          allowedRoots: effectiveAttachmentRoots,
          deps: { logVerbose },
        });
    const mediaAttachments = remoteHost ? rawMediaAttachments : stagedAttachments;
    const firstAttachment = mediaAttachments[0];
    const mediaPath = firstAttachment?.path ?? undefined;
    const mediaType = firstAttachment?.contentType ?? undefined;
    // Build arrays for all attachments (for multi-image support)
    const mediaPaths = mediaAttachments.map((a) => a.path).filter(Boolean);
    const mediaTypes = mediaAttachments.map((a) => a.contentType ?? undefined);
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
      decision,
      message,
      previousTimestamp,
      remoteHost,
      historyLimit,
      groupHistories,
      dmHistory,
      media: {
        path: mediaPath,
        type: mediaType,
        paths: mediaPaths,
        types: mediaTypes,
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
    const sendReadReceipts = imessageCfg.sendReadReceipts !== false;
    const typingTarget = ctxPayload.To;

    if (supportsRead && sendReadReceipts && typingTarget) {
      try {
        await markIMessageChatRead(typingTarget, {
          cfg,
          accountId: accountInfo.accountId,
          client: getActiveClient(),
        });
      } catch (err) {
        runtime.error?.(`imessage: mark read failed: ${String(err)}`);
      }
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

    const {
      dispatcher,
      replyOptions: typingReplyOptions,
      markDispatchIdle,
    } = createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
      deliver: async (payload, info) => {
        const target = ctxPayload.To;
        if (!target) {
          runtime.error?.(danger("imessage: missing delivery target"));
          return;
        }
        const durable = await deliverInboundReplyWithMessageSendContext({
          cfg,
          channel: "imessage",
          accountId: accountInfo.accountId,
          agentId: decision.route.agentId,
          ctxPayload,
          payload,
          info,
          to: target,
          deps: {
            imessage: createIMessageEchoCachingSend({
              client: getActiveClient(),
              accountId: accountInfo.accountId,
              sentMessageCache,
            }),
          },
        });
        if (durable.status === "failed") {
          throw durable.error;
        }
        if (durable.status === "handled_visible" || durable.status === "handled_no_send") {
          return;
        }
        await deliverReplies({
          cfg,
          replies: [payload],
          target,
          client: getActiveClient(),
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
    });
    let directTypingController: IMessageTypingController | undefined;
    const configuredTypingMode = resolveConfiguredIMessageTypingMode(cfg);
    const sendPolicy = resolveSendPolicy({
      cfg,
      entry: getSessionEntry({ storePath, sessionKey: decision.route.sessionKey }),
      sessionKey: decision.route.sessionKey,
      channel: "imessage",
      chatType: decision.isGroup ? "group" : "direct",
    });
    const shouldStartToolTyping =
      !decision.isGroup &&
      sendPolicy !== "deny" &&
      (configuredTypingMode === undefined || configuredTypingMode === "instant");
    const directToolTypingOptions = shouldStartToolTyping
      ? ({
          // iMessage's native typing bubble is channel-owned UI, not a
          // visible tool-progress message. The suppress flag is what lets
          // dispatch forward this callback even when verbose progress is off;
          // allowProgress covers message_tool_only source delivery. Keep this on
          // the direct instant/default path so configured typingMode values still
          // decide when typing can begin.
          suppressDefaultToolProgressMessages: true,
          allowProgressCallbacksWhenSourceDeliverySuppressed: true,
          onTypingController: (typing: IMessageTypingController) => {
            directTypingController = typing;
            typingReplyOptions.onTypingController?.(typing);
          },
          onToolStart: async () => {
            await directTypingController?.startTypingLoop();
          },
        } as const)
      : {};
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
          channel: "imessage",
          accountId: decision.route.accountId,
          routeSessionKey: decision.route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession,
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
          onPreDispatchFailure: () =>
            settleReplyDispatcher({
              dispatcher,
              onSettled: () => markDispatchIdle(),
            }),
          runDispatch: async () => {
            try {
              return await dispatchInboundMessage({
                ctx: ctxPayload,
                cfg,
                dispatcher,
                replyOptions: {
                  ...typingReplyOptions,
                  disableBlockStreaming:
                    typeof accountInfo.config.blockStreaming === "boolean"
                      ? !accountInfo.config.blockStreaming
                      : undefined,
                  onModelSelected,
                  ...directToolTypingOptions,
                },
              });
            } finally {
              markDispatchIdle();
            }
          },
        }),
      },
    });
  }

  const handleMessage = async (raw: unknown) => {
    const message = parseIMessageNotification(raw);
    if (!message) {
      // A malformed RPC notification means imsg shipped a payload shape
      // we do not understand — almost always a real bridge bug. Surface
      // the keys so an operator can correlate without leaking content.
      const shape =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.keys(raw as Record<string, unknown>)
              .toSorted()
              .join(",")
          : typeof raw;
      runtime.error?.(`imessage: dropping malformed RPC message payload (keys=${shape})`);
      return;
    }
    // Latch build capability from any row that carries balloon metadata so the
    // coalesce flush gate can trust a missing URL marker on later plain buckets.
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
    if (isStaleIMessageBacklog(message, Date.now(), staleThresholdMs)) {
      staleBacklogSuppressed += 1;
      runtime.log?.(
        warn(
          `imessage: suppressed stale inbound backlog account=${accountInfo.accountId} ` +
            `sent=${message.created_at ?? "unknown"} recovery=${isRecoveryReplay} ` +
            `(${staleBacklogSuppressed} suppressed since start)`,
        ),
      );
      // Record the suppression so it is durable: without this, a live row
      // suppressed under the tight live fence would fall under the wider
      // recovery window after a restart (its rowid is now below the new
      // boundary) and be delivered. Committing the key makes the recovery
      // replay treat it as already handled.
      const suppressedKey = buildIMessageInboundReplayKey({
        accountId: accountInfo.accountId,
        message,
      });
      if (suppressedKey) {
        await commitIMessageInboundReplay({
          guard: inboundReplayGuard,
          accountId: accountInfo.accountId,
          keys: [suppressedKey],
        });
      }
      return;
    }
    const repairedMessage = await repairMessageConversationAnchor(message);
    if (!repairedMessage) {
      return;
    }
    // Replay dedupe: a recovered bridge can re-emit a row already dispatched.
    // GUID-keyed (survives chat.db rowid churn) and persistent (holds across a
    // restart). Claim atomically here so two copies in a reconnect burst cannot
    // both pass; the claim is committed after handling and released on a
    // transient dispatch failure (see handleMessageNow) so a failed message can
    // still retry on a later re-emit. Claimed only once we will actually enqueue
    // so a dropped row never leaks an uncommitted claim.
    const replay = await claimIMessageInboundReplay({
      guard: inboundReplayGuard,
      accountId: accountInfo.accountId,
      message: repairedMessage,
    });
    if (!replay.claimed) {
      logVerbose(
        `imessage: dropping duplicate inbound notification account=${accountInfo.accountId}`,
      );
      return;
    }
    trackPendingRecoveryReplayRow(repairedMessage);
    await inboundDebouncer.enqueue({ message: repairedMessage, replayKey: replay.key });
  };

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
          void handleMessage(msg.params).catch((err: unknown) => {
            runtime.error?.(`imessage: handler failed: ${String(err)}`);
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
      // since_rowid = the recovery cursor (last dispatched rowid, capped),
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
        runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
        throw err;
      }
      runtime.log?.(
        warn(
          `imessage: watch.subscribe startup failed (attempt ${attempt}/${WATCH_SUBSCRIBE_MAX_ATTEMPTS}): ${String(err)}; retrying`,
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
        dispatchPayload: (message) => handleMessageNow(message, { advanceCatchupCursor: false }),
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
  }
}
