import { format } from "node:util";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-lifecycle";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
  type RuntimeEnv,
} from "../../runtime-api.js";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig, ReplyToMode } from "../../types.js";
import { resolveMatrixAccountConfig } from "../account-config.js";
import { resolveConfiguredMatrixBotUserIds } from "../accounts.js";
import { setActiveMatrixClient } from "../active-client.js";
import {
  backfillMatrixAuthDeviceIdAfterStartup,
  isBunRuntime,
  resolveMatrixAuth,
  resolveMatrixAuthContext,
  resolveSharedMatrixClient,
} from "../client.js";
import { releaseSharedClientInstance } from "../client/shared.js";
import type { MatrixClient } from "../sdk.js";
import { isMatrixStartupAbortError } from "../startup-abort.js";
import {
  isMatrixDisconnectedSyncState,
  isMatrixReadySyncState,
  type MatrixSyncState,
} from "../sync-state.js";
import { createMatrixThreadBindingManager } from "../thread-bindings.js";
import { registerMatrixAutoJoin } from "./auto-join.js";
import { resolveMatrixMonitorConfig } from "./config.js";
import { createDirectRoomTracker } from "./direct.js";
import { registerMatrixMonitorEvents } from "./events.js";
import { createMatrixRoomMessageHandler } from "./handler.js";
import {
  createMatrixInboundEventDeduper,
  type MatrixInboundEventDeduper,
} from "./inbound-dedupe.js";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import { runMatrixStartupMaintenance } from "./startup.js";
import { createMatrixMonitorStatusController } from "./status.js";
import { createMatrixMonitorSyncLifecycle } from "./sync-lifecycle.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

export type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
  accountId?: string | null;
  setStatus?: (next: import("openclaw/plugin-sdk/channel-contract").ChannelAccountSnapshot) => void;
};

const DEFAULT_MEDIA_MAX_MB = 20;

export async function monitorMatrixProvider(opts: MonitorMatrixOpts = {}): Promise<void> {
  // Fast-cancel callers should not pay the full Matrix startup/import cost.
  if (opts.abortSignal?.aborted) {
    return;
  }
  if (isBunRuntime()) {
    throw new Error("Matrix provider requires Node (bun runtime not supported)");
  }
  const core = getMatrixRuntime();
  let cfg = core.config.loadConfig() as CoreConfig;
  if (cfg.channels?.["matrix"]?.enabled === false) {
    return;
  }

  const logger = core.logging.getChildLogger({ module: "matrix-auto-reply" });
  const formatRuntimeMessage = (...args: Parameters<RuntimeEnv["log"]>) => format(...args);
  const runtime: RuntimeEnv = opts.runtime ?? {
    log: (...args) => {
      logger.info(formatRuntimeMessage(...args));
    },
    error: (...args) => {
      logger.error(formatRuntimeMessage(...args));
    },
    exit: (code: number): never => {
      throw new Error(`exit ${code}`);
    },
  };
  const logVerboseMessage = (message: string) => {
    if (!core.logging.shouldLogVerbose()) {
      return;
    }
    logger.debug?.(message);
  };

  const authContext = resolveMatrixAuthContext({
    cfg,
    accountId: opts.accountId,
  });
  const effectiveAccountId = authContext.accountId;

  // Resolve account-specific config for multi-account support
  const accountConfig = resolveMatrixAccountConfig({
    cfg,
    accountId: effectiveAccountId,
  });

  const allowlistOnly = accountConfig.allowlistOnly === true;
  const accountAllowBots = accountConfig.allowBots;
  let allowFrom: string[] = (accountConfig.dm?.allowFrom ?? []).map(String);
  let groupAllowFrom: string[] = (accountConfig.groupAllowFrom ?? []).map(String);
  let roomsConfig = accountConfig.groups ?? accountConfig.rooms;
  let needsRoomAliasesForConfig = false;
  const configuredBotUserIds = resolveConfiguredMatrixBotUserIds({
    cfg,
    accountId: effectiveAccountId,
  });

  ({ allowFrom, groupAllowFrom, roomsConfig } = await resolveMatrixMonitorConfig({
    cfg,
    accountId: effectiveAccountId,
    allowFrom,
    groupAllowFrom,
    roomsConfig,
    runtime,
  }));
  needsRoomAliasesForConfig = Boolean(
    roomsConfig && Object.keys(roomsConfig).some((key) => key.trim().startsWith("#")),
  );

  cfg = {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...cfg.channels?.["matrix"],
        dm: {
          ...cfg.channels?.["matrix"]?.dm,
          allowFrom,
        },
        groupAllowFrom,
        ...(roomsConfig ? { groups: roomsConfig } : {}),
      },
    },
  };

  const auth = await resolveMatrixAuth({ cfg, accountId: effectiveAccountId });
  const resolvedInitialSyncLimit =
    typeof opts.initialSyncLimit === "number"
      ? Math.max(0, Math.floor(opts.initialSyncLimit))
      : auth.initialSyncLimit;
  const authWithLimit =
    resolvedInitialSyncLimit === auth.initialSyncLimit
      ? auth
      : { ...auth, initialSyncLimit: resolvedInitialSyncLimit };
  const statusController = createMatrixMonitorStatusController({
    accountId: auth.accountId,
    baseUrl: auth.homeserver,
    statusSink: opts.setStatus,
  });
  let cleanedUp = false;
  let client: MatrixClient | null = null;
  let threadBindingManager: { accountId: string; stop: () => void } | null = null;
  let inboundDeduper: MatrixInboundEventDeduper | null = null;
  const monitorTaskRunner = createMatrixMonitorTaskRunner({
    logger,
    logVerboseMessage,
  });
  let syncLifecycle: ReturnType<typeof createMatrixMonitorSyncLifecycle> | null = null;
  const cleanup = async (mode: "persist" | "stop" = "persist") => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      client?.stopSyncWithoutPersist();
      if (client && mode === "persist") {
        await client.drainPendingDecryptions("matrix monitor shutdown");
      }
      if (mode === "persist") {
        await monitorTaskRunner.waitForIdle();
      }
      threadBindingManager?.stop();
      await inboundDeduper?.stop();
      if (client) {
        await releaseSharedClientInstance(client, mode);
      }
    } finally {
      client?.off("sync.state", onSyncState);
      syncLifecycle?.dispose();
      statusController.markStopped();
      setActiveMatrixClient(null, auth.accountId);
    }
  };

  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy: groupPolicyRaw, providerMissingFallbackApplied } =
    resolveAllowlistProviderRuntimeGroupPolicy({
      providerConfigPresent: cfg.channels?.["matrix"] !== undefined,
      groupPolicy: accountConfig.groupPolicy,
      defaultGroupPolicy,
    });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "matrix",
    accountId: effectiveAccountId,
    blockedLabel: GROUP_POLICY_BLOCKED_LABEL.room,
    log: (message) => logVerboseMessage(message),
  });
  const groupPolicy = allowlistOnly && groupPolicyRaw === "open" ? "allowlist" : groupPolicyRaw;
  const replyToMode = opts.replyToMode ?? accountConfig.replyToMode ?? "off";
  const threadReplies = accountConfig.threadReplies ?? "inbound";
  const dmThreadReplies = accountConfig.dm?.threadReplies;
  const threadBindingIdleTimeoutMs = resolveThreadBindingIdleTimeoutMsForChannel({
    cfg,
    channel: "matrix",
    accountId: effectiveAccountId,
  });
  const threadBindingMaxAgeMs = resolveThreadBindingMaxAgeMsForChannel({
    cfg,
    channel: "matrix",
    accountId: effectiveAccountId,
  });
  const dmConfig = accountConfig.dm;
  const dmEnabled = dmConfig?.enabled ?? true;
  const dmPolicyRaw = dmConfig?.policy ?? "pairing";
  const dmPolicy = allowlistOnly && dmPolicyRaw !== "disabled" ? "allowlist" : dmPolicyRaw;
  const dmSessionScope = dmConfig?.sessionScope ?? "per-user";
  const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "matrix", effectiveAccountId);
  const globalGroupChatHistoryLimit = (
    cfg.messages as { groupChat?: { historyLimit?: number } } | undefined
  )?.groupChat?.historyLimit;
  const historyLimit = Math.max(0, accountConfig.historyLimit ?? globalGroupChatHistoryLimit ?? 0);
  const mediaMaxMb = opts.mediaMaxMb ?? accountConfig.mediaMaxMb ?? DEFAULT_MEDIA_MAX_MB;
  const mediaMaxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const streaming: "partial" | "quiet" | "off" =
    accountConfig.streaming === true || accountConfig.streaming === "partial"
      ? "partial"
      : accountConfig.streaming === "quiet"
        ? "quiet"
        : "off";
  const blockStreamingEnabled = accountConfig.blockStreaming === true;
  const startupMs = Date.now();
  const startupGraceMs = 0;
  const warnedEncryptedRooms = new Set<string>();
  const warnedCryptoMissingRooms = new Set<string>();
  let healthySyncSinceMs: number | undefined;
  const noteSyncHealthState = (state: MatrixSyncState, at = Date.now()) => {
    if (isMatrixReadySyncState(state)) {
      healthySyncSinceMs ??= at;
      return;
    }
    if (isMatrixDisconnectedSyncState(state)) {
      healthySyncSinceMs = undefined;
    }
  };
  const onSyncState = (state: MatrixSyncState) => {
    noteSyncHealthState(state);
  };

  try {
    client = await resolveSharedMatrixClient({
      cfg,
      auth: authWithLimit,
      startClient: false,
      accountId: auth.accountId,
    });
    setActiveMatrixClient(client, auth.accountId);
    inboundDeduper = await createMatrixInboundEventDeduper({
      auth,
      env: process.env,
    });
    syncLifecycle = createMatrixMonitorSyncLifecycle({
      client,
      statusController,
      isStopping: () => cleanedUp || opts.abortSignal?.aborted === true,
    });
    client.on("sync.state", onSyncState);
    // Cold starts should ignore old room history, but once we have a persisted
    // /sync cursor we want restart backlogs to replay just like other channels.
    const dropPreStartupMessages = !client.hasPersistedSyncState();
    const { getRoomInfo, getMemberDisplayName } = createMatrixRoomInfoResolver(client);
    const directTracker = createDirectRoomTracker(client, {
      log: logVerboseMessage,
      canPromoteRecentInvite: async (roomId) =>
        shouldPromoteRecentInviteRoom({
          roomId,
          roomInfo: await getRoomInfo(roomId, { includeAliases: true }),
          rooms: roomsConfig,
        }),
      shouldKeepLocallyPromotedDirectRoom: async (roomId) => {
        try {
          const roomInfo = await getRoomInfo(roomId, { includeAliases: true });
          if (!roomInfo.nameResolved || !roomInfo.aliasesResolved) {
            return undefined;
          }
          return shouldPromoteRecentInviteRoom({
            roomId,
            roomInfo,
            rooms: roomsConfig,
          });
        } catch (err) {
          logVerboseMessage(
            `matrix: local promotion revalidation failed room=${roomId} (${String(err)})`,
          );
          return undefined;
        }
      },
    });
    registerMatrixAutoJoin({ client, accountConfig, runtime });
    const handleRoomMessage = createMatrixRoomMessageHandler({
      client,
      core,
      cfg,
      accountId: effectiveAccountId,
      runtime,
      logger,
      logVerboseMessage,
      allowFrom,
      groupAllowFrom,
      roomsConfig,
      accountAllowBots,
      configuredBotUserIds,
      groupPolicy,
      replyToMode,
      threadReplies,
      dmThreadReplies,
      dmSessionScope,
      streaming,
      blockStreamingEnabled,
      dmEnabled,
      dmPolicy,
      textLimit,
      mediaMaxBytes,
      historyLimit,
      startupMs,
      startupGraceMs,
      dropPreStartupMessages,
      inboundDeduper,
      directTracker,
      getRoomInfo,
      getMemberDisplayName,
      needsRoomAliasesForConfig,
    });
    threadBindingManager = await createMatrixThreadBindingManager({
      accountId: effectiveAccountId,
      auth,
      client,
      env: process.env,
      idleTimeoutMs: threadBindingIdleTimeoutMs,
      maxAgeMs: threadBindingMaxAgeMs,
      logVerboseMessage,
    });
    logVerboseMessage(
      `matrix: thread bindings ready account=${threadBindingManager.accountId} idleMs=${threadBindingIdleTimeoutMs} maxAgeMs=${threadBindingMaxAgeMs}`,
    );

    registerMatrixMonitorEvents({
      cfg,
      client,
      auth,
      allowFrom,
      dmEnabled,
      dmPolicy,
      readStoreAllowFrom: async () =>
        await core.channel.pairing
          .readAllowFromStore({
            channel: "matrix",
            env: process.env,
            accountId: effectiveAccountId,
          })
          .catch(() => []),
      directTracker,
      logVerboseMessage,
      warnedEncryptedRooms,
      warnedCryptoMissingRooms,
      logger,
      startupGraceMs,
      getHealthySyncSinceMs: () => healthySyncSinceMs,
      formatNativeDependencyHint: core.system.formatNativeDependencyHint,
      onRoomMessage: handleRoomMessage,
      runDetachedTask: monitorTaskRunner.runDetachedTask,
    });

    // Register Matrix thread bindings before the client starts syncing so threaded
    // commands during startup never observe Matrix as "unavailable".
    logVerboseMessage("matrix: starting client");
    await resolveSharedMatrixClient({
      cfg,
      auth: authWithLimit,
      accountId: auth.accountId,
      abortSignal: opts.abortSignal,
    });
    logVerboseMessage("matrix: client started");

    // Shared client is already started via resolveSharedMatrixClient.
    logger.info(`matrix: logged in as ${auth.userId}`);
    void backfillMatrixAuthDeviceIdAfterStartup({
      auth,
      env: process.env,
      abortSignal: opts.abortSignal,
    }).catch((err) => {
      logVerboseMessage(`matrix: failed to backfill deviceId after startup (${String(err)})`);
    });

    registerChannelRuntimeContext({
      channelRuntime: opts.channelRuntime,
      channelId: "matrix",
      accountId: effectiveAccountId,
      capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
      context: {
        client,
      },
      abortSignal: opts.abortSignal,
    });

    await runMatrixStartupMaintenance({
      client,
      auth,
      accountId: effectiveAccountId,
      effectiveAccountId,
      accountConfig,
      logger,
      logVerboseMessage,
      loadConfig: () => core.config.loadConfig() as CoreConfig,
      writeConfigFile: async (nextCfg) => await core.config.writeConfigFile(nextCfg),
      loadWebMedia: async (url, maxBytes) => await core.media.loadWebMedia(url, maxBytes),
      env: process.env,
      abortSignal: opts.abortSignal,
    });

    await Promise.race([
      waitUntilAbort(opts.abortSignal, async () => {
        try {
          logVerboseMessage("matrix: stopping client");
          await cleanup();
        } catch (err) {
          logger.warn("matrix: failed during monitor shutdown cleanup", {
            error: String(err),
          });
        }
      }),
      syncLifecycle.waitForFatalStop(),
    ]);
  } catch (err) {
    if (opts.abortSignal?.aborted === true && isMatrixStartupAbortError(err)) {
      await cleanup("stop");
      return;
    }
    statusController.noteUnexpectedError(err);
    await cleanup();
    throw err;
  }
}
