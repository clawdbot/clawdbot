// Matrix plugin entrypoint registers its OpenClaw integration.
import { format } from "node:util";
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { ChannelRuntimeSurface } from "openclaw/plugin-sdk/channel-contract";
import {
  resolveChannelStreamingBlockEnabled,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { resolveOptionalIntegerOption } from "openclaw/plugin-sdk/number-runtime";
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
import type {
  CoreConfig,
  MatrixStreamingConfig,
  MatrixStreamingMode,
  ReplyToMode,
} from "../../types.js";
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
import { createMatrixInboundEventDeduper } from "./inbound-dedupe.js";
import { shouldPromoteRecentInviteRoom } from "./recent-invite.js";
import { createMatrixRoomInfoResolver } from "./room-info.js";
import { resolveMatrixRoomConfig } from "./rooms.js";
import { runMatrixStartupMaintenance } from "./startup.js";
import { createMatrixMonitorStatusController } from "./status.js";
import { createMatrixMonitorSyncLifecycle } from "./sync-lifecycle.js";
import { createMatrixMonitorTaskRunner } from "./task-runner.js";

type MonitorMatrixOpts = {
  runtime?: RuntimeEnv;
  channelRuntime?: ChannelRuntimeSurface;
  abortSignal?: AbortSignal;
  mediaMaxMb?: number;
  initialSyncLimit?: number;
  replyToMode?: ReplyToMode;
  accountId?: string | null;
  setStatus?: (next: import("openclaw/plugin-sdk/channel-contract").ChannelAccountSnapshot) => void;
};

// Account entries are schema-open (accounts: z.record(z.unknown())), so
// unmigrated account configs can still carry the retired scalar/boolean
// spellings at runtime even though the root schema rejects them. Honor them
// through the same deprecation window as the shared flat-key fallback in
// src/channels/streaming.ts; doctor migrates the spellings to streaming.mode.
type MatrixStreamingInput = MatrixStreamingConfig | MatrixStreamingMode | boolean | undefined;

function isMatrixStreamingConfig(
  streaming: MatrixStreamingInput,
): streaming is MatrixStreamingConfig {
  return Boolean(streaming && typeof streaming === "object" && !Array.isArray(streaming));
}

function resolveMatrixStreamingMode(streaming: MatrixStreamingInput): MatrixStreamingMode {
  if (streaming === true || streaming === "partial") {
    return "partial";
  }
  if (streaming === "quiet") {
    return "quiet";
  }
  if (streaming === "progress") {
    return "progress";
  }
  if (isMatrixStreamingConfig(streaming)) {
    if (
      streaming.mode === "partial" ||
      streaming.mode === "quiet" ||
      streaming.mode === "progress"
    ) {
      return streaming.mode;
    }
  }
  return "off";
}

function resolveMatrixPreviewToolProgress(streaming: MatrixStreamingInput): boolean {
  if (!isMatrixStreamingConfig(streaming)) {
    return true;
  }
  if (resolveMatrixStreamingMode(streaming) === "progress") {
    return streaming.progress?.toolProgress ?? streaming.preview?.toolProgress ?? true;
  }
  return streaming.preview?.toolProgress ?? true;
}

function resolveMatrixPreviewToolProgressEnabled(streaming: MatrixStreamingInput): boolean {
  return (
    resolveMatrixStreamingMode(streaming) !== "off" && resolveMatrixPreviewToolProgress(streaming)
  );
}

export const testing = {
  resolveMatrixPreviewToolProgress,
  resolveMatrixPreviewToolProgressEnabled,
  resolveMatrixStreamingMode,
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
  let cfg = core.config.current() as CoreConfig;
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
  let roomsConfig = accountConfig.groups ?? accountConfig.rooms;
  let needsRoomAliasesForConfig = false;
  const initialAllowFrom = (accountConfig.dm?.allowFrom ?? []).map(String);
  const initialGroupAllowFrom = (accountConfig.groupAllowFrom ?? []).map(String);
  const configuredBotUserIds = resolveConfiguredMatrixBotUserIds({
    cfg,
    accountId: effectiveAccountId,
  });

  const {
    allowFrom,
    allowFromResolvedEntries,
    groupAllowFrom,
    groupAllowFromResolvedEntries,
    roomsConfig: resolvedRoomsConfig,
  } = await resolveMatrixMonitorConfig({
    cfg,
    accountId: effectiveAccountId,
    allowFrom: initialAllowFrom,
    groupAllowFrom: initialGroupAllowFrom,
    roomsConfig,
    runtime,
  });
  roomsConfig = resolvedRoomsConfig;
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
    resolveOptionalIntegerOption(opts.initialSyncLimit, { min: 0 }) ?? auth.initialSyncLimit;
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
  const streaming = resolveMatrixStreamingMode(accountConfig.streaming);
  const previewToolProgressEnabled = resolveMatrixPreviewToolProgressEnabled(
    accountConfig.streaming,
  );
  const blockStreamingEnabled = resolveChannelStreamingBlockEnabled(accountConfig) === true;
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
    const inboundDeduper = createMatrixInboundEventDeduper({
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
    const isExplicitlyConfiguredRoom = async (roomId: string): Promise<boolean> => {
      const roomInfoForConfig = needsRoomAliasesForConfig
        ? await getRoomInfo(roomId, { includeAliases: true })
        : undefined;
      const aliases = roomInfoForConfig
        ? [roomInfoForConfig.canonicalAlias ?? "", ...roomInfoForConfig.altAliases].filter(Boolean)
        : [];
      return (
        resolveMatrixRoomConfig({
          rooms: roomsConfig,
          roomId,
          aliases,
        }).matchSource === "direct"
      );
    };
    const directTracker = createDirectRoomTracker(client, {
      log: logVerboseMessage,
      isExplicitlyConfiguredRoom,
      canPromoteRecentInvite: async (roomId) =>
        shouldPromoteRecentInviteRoom({
          roomId,
          roomInfo: await getRoomInfo(roomId, { includeAliases: true }),
          rooms: roomsConfig,
        }),
      ...(dmSessionScope === "per-room"
        ? {
            canPromoteUnmappedStrictRoom: async (roomId) =>
              shouldPromoteRecentInviteRoom({
                roomId,
                roomInfo: await getRoomInfo(roomId, { includeAliases: true }),
                rooms: roomsConfig,
              }),
          }
        : {}),
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
      accountConfig,
      runtime,
      logger,
      logVerboseMessage,
      allowFrom,
      allowFromResolvedEntries,
      groupAllowFrom,
      groupAllowFromResolvedEntries,
      roomsConfig,
      accountAllowBots,
      configuredBotUserIds,
      groupPolicy,
      replyToMode,
      threadReplies,
      dmThreadReplies,
      dmSessionScope,
      streaming,
      previewToolProgressEnabled,
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
      cfg,
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
    }).catch((err: unknown) => {
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
      getRuntimeConfig: () => core.config.current() as CoreConfig,
      replaceConfigFile: async (nextCfg) => {
        await core.config.replaceConfigFile({
          nextConfig: nextCfg,
          afterWrite: { mode: "auto" },
        });
      },
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
export { testing as __testing };
