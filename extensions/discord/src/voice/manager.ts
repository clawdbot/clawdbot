import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveDiscordAccountAllowFrom } from "../accounts.js";
import {
  type APIVoiceState,
  type Client,
  getGuildVoiceState,
  ReadyListener,
  ResumedListener,
  VoiceStateUpdateListener,
} from "../internal/discord.js";
import type { VoicePlugin } from "../internal/voice.js";
import { formatMention } from "../mentions.js";
import { parseDiscordTarget } from "../target-parsing.js";
import { decodeOpusStream, decodeOpusStreamChunks, writeVoiceWavFile } from "./audio.js";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  createVoiceCaptureState,
  finishVoiceCapture,
  getActiveVoiceCapture,
  isVoiceCaptureActive,
  scheduleVoiceCaptureFinalize,
  stopVoiceCaptureState,
} from "./capture-state.js";
import { resolveDiscordVoiceEnabled } from "./config.js";
import {
  type DiscordVoiceIngressContext,
  resolveDiscordVoiceRealtimeBootstrapContext,
  resolveDiscordVoiceIngressContext,
  runDiscordVoiceAgentTurn,
} from "./ingress.js";
import {
  DiscordRealtimeVoiceSession,
  type DiscordVoiceMode,
  isDiscordRealtimeVoiceMode,
  resolveDiscordVoiceMode,
} from "./realtime.js";
import {
  analyzeVoiceReceiveError,
  createVoiceReceiveRecoveryState,
  DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
  DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
  enableDaveReceivePassthrough as tryEnableDaveReceivePassthrough,
  finishVoiceDecryptRecovery,
  noteVoiceDecryptFailure,
  resetVoiceReceiveRecoveryState,
} from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { processDiscordVoiceSegment } from "./segment.js";
import {
  CAPTURE_FINALIZE_GRACE_MS,
  isVoiceChannel,
  logVoiceVerbose,
  resolveVoiceTimeoutMs,
  MIN_SEGMENT_SECONDS,
  VOICE_CONNECT_READY_TIMEOUT_MS,
  VOICE_RECONNECT_GRACE_MS,
  type VoiceOperationResult,
  type VoiceSessionEntry,
} from "./session.js";
import { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const logger = createSubsystemLogger("discord/voice");
const VOICE_LOG_PREVIEW_CHARS = 500;
const FOLLOW_USERS_RECONCILE_INTERVAL_MS = 10_000;
const FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN = 4;
const FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN = 32;
const DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS = [
  "api key missing",
  "incorrect api key",
  "invalid api key",
  "unauthorized",
  "authentication",
  "permission denied",
  "forbidden",
];

function logFollowUserReconcileVerbose(reason: string, message: string): void {
  if (reason === "interval") {
    logger.trace(`discord voice: ${message}`);
    return;
  }
  logVoiceVerbose(message);
}

type DiscordVoiceSdk = ReturnType<typeof loadDiscordVoiceSdk>;
type DiscordVoiceConnection = ReturnType<DiscordVoiceSdk["joinVoiceChannel"]>;
type VoiceChannelResidency = {
  guildId: string;
  channelId: string;
};

function formatVoiceLogPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= VOICE_LOG_PREVIEW_CHARS) {
    return oneLine;
  }
  return `${oneLine.slice(0, VOICE_LOG_PREVIEW_CHARS)}...`;
}

function isVoiceConnectionDestroyed(
  connection: DiscordVoiceConnection,
  voiceSdk: DiscordVoiceSdk,
): boolean {
  return connection.state.status === voiceSdk.VoiceConnectionStatus.Destroyed;
}

function destroyVoiceConnectionSafely(params: {
  connection: DiscordVoiceConnection;
  voiceSdk: DiscordVoiceSdk;
  reason: string;
}): void {
  if (isVoiceConnectionDestroyed(params.connection, params.voiceSdk)) {
    logVoiceVerbose(`destroy skipped: ${params.reason}; connection already destroyed`);
    return;
  }
  try {
    params.connection.destroy();
  } catch (err) {
    const message = formatErrorMessage(err);
    if (message.includes("already been destroyed")) {
      logVoiceVerbose(`destroy skipped: ${params.reason}; ${message}`);
      return;
    }
    logger.warn(`discord voice: destroy failed: ${params.reason}: ${message}`);
  }
}

function isRetryableVoiceJoinReadyError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return message.includes("operation was aborted");
}

function normalizeVoiceChannelResidencies(
  entries: Array<{ guildId?: string; channelId?: string }> | undefined,
): VoiceChannelResidency[] {
  const normalized: VoiceChannelResidency[] = [];
  for (const entry of entries ?? []) {
    const guildId = entry.guildId?.trim();
    const channelId = entry.channelId?.trim();
    if (guildId && channelId) {
      normalized.push({ guildId, channelId });
    }
  }
  return normalized;
}

function normalizeDiscordUserId(value: string): string | undefined {
  const trimmed = value.trim();
  const withoutDiscordPrefix = trimmed.startsWith("discord:") ? trimmed.slice(8) : trimmed;
  const withoutUserPrefix = withoutDiscordPrefix.startsWith("user:")
    ? withoutDiscordPrefix.slice(5)
    : withoutDiscordPrefix;
  return withoutUserPrefix.trim() || undefined;
}

function normalizeDiscordUserIds(entries: string[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries ?? []) {
    const id = normalizeDiscordUserId(entry);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function resolveFollowUsersEnabled(voiceConfig: DiscordAccountConfig["voice"]): boolean {
  return voiceConfig?.followUsersEnabled !== false;
}

type FollowUserReconcileGuildPlan = {
  guildId: string;
  userIds: string[];
  checkedAllUsers: boolean;
  checkBotVoiceState: boolean;
};

type FollowUserReconcileUserSelection = {
  userIds: string[];
  completedCycle: boolean;
};

function isVoiceChannelAllowed(params: {
  allowedChannels: VoiceChannelResidency[] | null;
  guildId: string;
  channelId: string;
}): boolean {
  return (
    params.allowedChannels === null ||
    params.allowedChannels.some(
      (entry) => entry.guildId === params.guildId && entry.channelId === params.channelId,
    )
  );
}

function formatAutoJoinFailureKey(entry: { guildId: string; channelId: string }): string {
  return `${entry.guildId}:${entry.channelId}`;
}

function isFatalAutoJoinFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return DISCORD_VOICE_FATAL_AUTOJOIN_ERROR_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

function isUnknownDiscordVoiceStateError(err: unknown): boolean {
  const status =
    err && typeof err === "object" && "status" in err && typeof err.status === "number"
      ? err.status
      : undefined;
  return status === 404 || /unknown voice state/i.test(formatErrorMessage(err));
}

function startAutoJoin(manager: Pick<DiscordVoiceManager, "autoJoin">) {
  void manager
    .autoJoin()
    .catch((err) => logger.warn(`discord voice: autoJoin failed: ${formatErrorMessage(err)}`));
}

function resolveDiscordVoiceAgentRoute(params: {
  cfg: OpenClawConfig;
  accountId: string;
  guildId: string;
  sessionChannelId: string;
  voiceConfig: DiscordAccountConfig["voice"];
}) {
  const voiceRoute = resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId,
    peer: { kind: "channel", id: params.sessionChannelId },
  });
  const agentSession = params.voiceConfig?.agentSession;
  if (agentSession?.mode !== "target") {
    return {
      route: voiceRoute,
      voiceRoute,
      agentSessionMode: "voice" as const,
      agentSessionTarget: undefined,
    };
  }
  const target = agentSession.target?.trim();
  if (!target) {
    throw new Error('channels.discord.voice.agentSession.target is required when mode is "target"');
  }
  const parsed = parseDiscordTarget(target, { defaultKind: "channel" });
  if (!parsed) {
    throw new Error(`Invalid Discord voice agent session target "${target}"`);
  }
  const route = resolveAgentRoute({
    cfg: params.cfg,
    channel: "discord",
    accountId: params.accountId,
    guildId: params.guildId,
    peer: {
      kind: parsed.kind === "user" ? "direct" : "channel",
      id: parsed.id,
    },
  });
  return {
    route,
    voiceRoute,
    agentSessionMode: "target" as const,
    agentSessionTarget: parsed.normalized,
  };
}

export class DiscordVoiceManager {
  private sessions = new Map<string, VoiceSessionEntry>();
  private readonly joinTasks = new Map<string, Promise<VoiceOperationResult>>();
  private botUserId?: string;
  private readonly voiceEnabled: boolean;
  private autoJoinTask: Promise<void> | null = null;
  private readonly fatalAutoJoinFailures = new Map<
    string,
    { message: string; skipLogged: boolean }
  >();
  private readonly ownerAllowFrom?: string[];
  private readonly speakerContext: DiscordVoiceSpeakerContextResolver;
  private readonly allowedChannels: VoiceChannelResidency[] | null;
  private readonly followUserIds: Set<string>;
  private readonly followedUserChannels = new Map<string, VoiceChannelResidency>();
  private readonly followedVoiceGuilds = new Set<string>();
  private followUsersReconcileTimer: NodeJS.Timeout | null = null;
  private followUsersReconcileTask: Promise<void> | null = null;
  private followUsersReconcileGuildCursor = 0;
  private followUsersReconcileBotGuildCursor = 0;
  private readonly followUsersReconcileUserCursors = new Map<string, number>();
  private destroyed = false;

  constructor(
    private params: {
      client: Client;
      cfg: OpenClawConfig;
      discordConfig: DiscordAccountConfig;
      accountId: string;
      runtime: RuntimeEnv;
      botUserId?: string;
    },
  ) {
    this.botUserId = params.botUserId;
    this.voiceEnabled = resolveDiscordVoiceEnabled(params.discordConfig.voice);
    this.ownerAllowFrom =
      resolveDiscordAccountAllowFrom({ cfg: params.cfg, accountId: params.accountId }) ??
      params.discordConfig.allowFrom ??
      params.discordConfig.dm?.allowFrom ??
      [];
    this.allowedChannels =
      params.discordConfig.voice?.allowedChannels === undefined
        ? null
        : normalizeVoiceChannelResidencies(params.discordConfig.voice.allowedChannels);
    this.followUserIds = resolveFollowUsersEnabled(params.discordConfig.voice)
      ? normalizeDiscordUserIds(params.discordConfig.voice?.followUsers)
      : new Set();
    this.speakerContext = new DiscordVoiceSpeakerContextResolver({
      client: params.client,
      ownerAllowFrom: this.ownerAllowFrom,
    });
  }

  setBotUserId(id?: string) {
    if (id) {
      this.botUserId = id;
    }
  }

  isEnabled() {
    return this.voiceEnabled;
  }

  async autoJoin(): Promise<void> {
    if (!this.voiceEnabled || this.destroyed) {
      return;
    }
    if (this.autoJoinTask) {
      return this.autoJoinTask;
    }
    this.autoJoinTask = (async () => {
      const entries = this.params.discordConfig.voice?.autoJoin ?? [];
      const entriesByGuild = new Map<string, { guildId: string; channelId: string }>();
      const duplicateGuilds = new Set<string>();
      for (const entry of entries) {
        const guildId = entry.guildId.trim();
        const channelId = entry.channelId.trim();
        if (!guildId || !channelId) {
          continue;
        }
        if (entriesByGuild.has(guildId)) {
          duplicateGuilds.add(guildId);
        }
        entriesByGuild.set(guildId, { guildId, channelId });
      }

      logVoiceVerbose(`autoJoin: ${entries.length} entries, ${entriesByGuild.size} guilds`);
      for (const guildId of duplicateGuilds) {
        const selected = entriesByGuild.get(guildId);
        if (selected) {
          logger.warn(
            `discord voice: autoJoin has multiple entries for guild ${guildId}; using channel ${selected.channelId}`,
          );
        }
      }

      for (const entry of entriesByGuild.values()) {
        const failureKey = formatAutoJoinFailureKey(entry);
        const fatalFailure = this.fatalAutoJoinFailures.get(failureKey);
        if (fatalFailure) {
          if (!fatalFailure.skipLogged) {
            logger.warn(
              `discord voice: autoJoin suppressed guild=${entry.guildId} channel=${entry.channelId} after fatal startup failure; retry with /vc join or reload config after fixing credentials: ${fatalFailure.message}`,
            );
            fatalFailure.skipLogged = true;
          }
          continue;
        }
        logVoiceVerbose(`autoJoin: joining guild ${entry.guildId} channel ${entry.channelId}`);
        const result = await this.join({
          guildId: entry.guildId,
          channelId: entry.channelId,
        });
        if (!result.ok) {
          logger.warn(
            `discord voice: autoJoin skipped guild=${entry.guildId} channel=${entry.channelId}: ${result.message}`,
          );
          if (isFatalAutoJoinFailure(result.message)) {
            this.fatalAutoJoinFailures.set(failureKey, {
              message: result.message,
              skipLogged: false,
            });
          }
        }
      }
      this.ensureFollowUsersReconcileTimer();
      await this.reconcileFollowedUsers("startup");
    })().finally(() => {
      this.autoJoinTask = null;
    });
    return this.autoJoinTask;
  }

  status(): VoiceOperationResult[] {
    return Array.from(this.sessions.values()).map((session) => ({
      ok: true,
      message: `connected: guild ${session.guildId} channel ${session.channelId}`,
      guildId: session.guildId,
      channelId: session.channelId,
    }));
  }

  isAllowedVoiceChannel(params: { guildId: string; channelId: string }): boolean {
    return isVoiceChannelAllowed({
      allowedChannels: this.allowedChannels,
      guildId: params.guildId.trim(),
      channelId: params.channelId.trim(),
    });
  }

  async join(
    params: { guildId: string; channelId: string },
    options?: {
      preserveFollowState?: boolean;
      transcripts?: VoiceSessionEntry["transcripts"];
    },
  ): Promise<VoiceOperationResult> {
    if (this.destroyed) {
      return {
        ok: false,
        message: "Discord voice manager is stopped.",
      };
    }
    if (!this.voiceEnabled) {
      return {
        ok: false,
        message: "Discord voice is disabled (channels.discord.voice.enabled).",
      };
    }
    const guildId = params.guildId.trim();
    const channelId = params.channelId.trim();
    if (!guildId || !channelId) {
      return { ok: false, message: "Missing guildId or channelId." };
    }
    if (!this.isAllowedVoiceChannel({ guildId, channelId })) {
      logger.warn(
        `discord voice: join rejected for non-allowed channel guild=${guildId} channel=${channelId}`,
      );
      return {
        ok: false,
        message: `${formatMention({ channelId })} is not allowed by channels.discord.voice.allowedChannels.`,
        guildId,
        channelId,
      };
    }
    logVoiceVerbose(`join requested: guild ${guildId} channel ${channelId}`);

    while (true) {
      const activeJoinTask = this.joinTasks.get(guildId);
      if (!activeJoinTask) {
        break;
      }
      logVoiceVerbose(`join: waiting for active guild join guild ${guildId} channel ${channelId}`);
      await activeJoinTask.catch(() => undefined);
      if (this.destroyed) {
        return {
          ok: false,
          message: "Discord voice manager is stopped.",
          guildId,
          channelId,
        };
      }
    }

    const joinTask = this.joinUnlocked({ guildId, channelId }, options);
    this.joinTasks.set(guildId, joinTask);
    try {
      return await joinTask;
    } finally {
      if (this.joinTasks.get(guildId) === joinTask) {
        this.joinTasks.delete(guildId);
      }
    }
  }

  private async joinUnlocked(
    params: { guildId: string; channelId: string },
    options?: {
      preserveFollowState?: boolean;
      transcripts?: VoiceSessionEntry["transcripts"];
    },
  ): Promise<VoiceOperationResult> {
    const { guildId, channelId } = params;
    const voiceConfig = this.params.discordConfig.voice;
    const voiceMode = resolveDiscordVoiceMode(voiceConfig);

    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
      if (options?.transcripts) {
        existing.transcripts = options.transcripts;
      }
      if (!options?.transcripts && isDiscordRealtimeVoiceMode(voiceMode) && !existing.realtime) {
        const realtimeResult = await this.attachRealtimeSession(existing, voiceMode, {
          requireLiveEntry: true,
        });
        if (!realtimeResult.ok) {
          return {
            ok: false,
            message: realtimeResult.message,
            guildId,
            channelId,
          };
        }
      }
      logVoiceVerbose(`join: already connected to guild ${guildId} channel ${channelId}`);
      return {
        ok: true,
        message: `Already connected to ${formatMention({ channelId })}.`,
        guildId,
        channelId,
      };
    }
    if (existing) {
      logVoiceVerbose(`join: replacing existing session for guild ${guildId}`);
      await this.leave({ guildId }, { preserveFollowState: options?.preserveFollowState });
    }

    const channelInfo = await this.params.client.fetchChannel(channelId).catch(() => null);
    if (!channelInfo || ("type" in channelInfo && !isVoiceChannel(channelInfo.type))) {
      return { ok: false, message: `Channel ${channelId} is not a voice channel.` };
    }
    const channelGuildId = "guildId" in channelInfo ? channelInfo.guildId : undefined;
    if (channelGuildId && channelGuildId !== guildId) {
      return { ok: false, message: "Voice channel is not in this guild." };
    }

    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    if (!voicePlugin) {
      return { ok: false, message: "Discord voice plugin is not available." };
    }

    const adapterCreator = voicePlugin.getGatewayAdapterCreator(guildId);
    const daveEncryption = voiceConfig?.daveEncryption;
    const decryptionFailureTolerance = voiceConfig?.decryptionFailureTolerance;
    const connectReadyTimeoutMs = resolveVoiceTimeoutMs(
      voiceConfig?.connectTimeoutMs,
      VOICE_CONNECT_READY_TIMEOUT_MS,
    );
    const reconnectGraceMs = resolveVoiceTimeoutMs(
      voiceConfig?.reconnectGraceMs,
      VOICE_RECONNECT_GRACE_MS,
    );
    logVoiceVerbose(
      `join: DAVE settings encryption=${daveEncryption === false ? "off" : "on"} tolerance=${
        decryptionFailureTolerance ?? "default"
      } connectTimeout=${connectReadyTimeoutMs}ms reconnectGrace=${reconnectGraceMs}ms`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    const existingEntry = this.sessions.get(guildId);
    if (existingEntry) {
      existingEntry.stop();
      this.sessions.delete(guildId);
    }
    const staleConnection = voiceSdk.getVoiceConnection(guildId);
    if (staleConnection) {
      destroyVoiceConnectionSafely({
        connection: staleConnection,
        voiceSdk,
        reason: `stale connection before join guild ${guildId}`,
      });
    }
    let connection: DiscordVoiceConnection | undefined;
    const connectReadyDeadlineMs = Date.now() + connectReadyTimeoutMs;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const joinedConnection = voiceSdk.joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator,
        selfDeaf: false,
        selfMute: false,
        daveEncryption,
        decryptionFailureTolerance,
      });
      const remainingConnectReadyTimeoutMs = Math.max(1, connectReadyDeadlineMs - Date.now());

      try {
        await voiceSdk.entersState(
          joinedConnection,
          voiceSdk.VoiceConnectionStatus.Ready,
          remainingConnectReadyTimeoutMs,
        );
        connection = joinedConnection;
        logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
        break;
      } catch (err) {
        destroyVoiceConnectionSafely({
          connection: joinedConnection,
          voiceSdk,
          reason: `failed join cleanup guild ${guildId} channel ${channelId}`,
        });
        if (
          attempt === 1 &&
          isRetryableVoiceJoinReadyError(err) &&
          !this.destroyed &&
          connectReadyDeadlineMs > Date.now()
        ) {
          logVoiceVerbose(
            `join: retrying aborted ready wait guild ${guildId} channel ${channelId}`,
          );
          continue;
        }
        logger.warn(
          `discord voice: join failed before ready: guild ${guildId} channel ${channelId} timeout=${connectReadyTimeoutMs}ms error=${formatErrorMessage(err)}`,
        );
        return { ok: false, message: `Failed to join voice channel: ${formatErrorMessage(err)}` };
      }
    }
    if (!connection) {
      return { ok: false, message: "Failed to join voice channel." };
    }
    if (this.destroyed) {
      destroyVoiceConnectionSafely({
        connection,
        voiceSdk,
        reason: `manager stopped during join guild ${guildId} channel ${channelId}`,
      });
      return {
        ok: false,
        message: "Discord voice manager is stopped.",
        guildId,
        channelId,
      };
    }

    const sessionChannelId = channelInfo?.id ?? channelId;
    // Use the voice channel id as the session channel so text chat in the voice channel
    // shares the same session as spoken audio.
    if (sessionChannelId !== channelId) {
      logVoiceVerbose(
        `join: using session channel ${sessionChannelId} for voice channel ${channelId}`,
      );
    }
    let routeInfo: ReturnType<typeof resolveDiscordVoiceAgentRoute>;
    try {
      routeInfo = resolveDiscordVoiceAgentRoute({
        cfg: this.params.cfg,
        accountId: this.params.accountId,
        guildId,
        sessionChannelId,
        voiceConfig,
      });
    } catch (err) {
      destroyVoiceConnectionSafely({
        connection,
        voiceSdk,
        reason: `voice agent session route failed guild ${guildId} channel ${channelId}`,
      });
      return {
        ok: false,
        message: `Failed to resolve Discord voice agent session: ${formatErrorMessage(err)}`,
        guildId,
        channelId,
      };
    }
    const { route, voiceRoute, agentSessionMode, agentSessionTarget } = routeInfo;
    logger.info(
      `discord voice: joining guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} agentSessionMode=${agentSessionMode}${agentSessionTarget ? ` agentSessionTarget=${agentSessionTarget}` : ""} voiceModel=${voiceConfig?.model ?? "route-default"} realtimeProvider=${voiceConfig?.realtime?.provider ?? "auto"} realtimeModel=${voiceConfig?.realtime?.model ?? "provider-default"} realtimeVoice=${voiceConfig?.realtime?.voice ?? "provider-default"}`,
    );

    const player = voiceSdk.createAudioPlayer();
    connection.subscribe(player);
    let stopped = false;
    const clearSessionIfCurrent = () => {
      const active = this.sessions.get(guildId);
      if (active?.connection === connection) {
        this.sessions.delete(guildId);
      }
    };
    const stopEntry = (
      entry: VoiceSessionEntry,
      options: { destroyConnection: boolean; reason: string },
    ) => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (speakingHandler) {
        connection.receiver.speaking.off("start", speakingHandler);
      }
      if (speakingEndHandler) {
        connection.receiver.speaking.off("end", speakingEndHandler);
      }
      stopVoiceCaptureState(entry.capture);
      if (disconnectedHandler) {
        connection.off(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
      }
      if (destroyedHandler) {
        connection.off(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
      }
      if (playerErrorHandler) {
        player.off("error", playerErrorHandler);
      }
      entry.pendingRealtime?.close();
      entry.pendingRealtime = undefined;
      entry.realtime?.close();
      entry.realtime = undefined;
      player.stop();
      if (options.destroyConnection) {
        destroyVoiceConnectionSafely({
          connection,
          voiceSdk,
          reason: options.reason,
        });
      }
    };

    const entry: VoiceSessionEntry = {
      guildId,
      guildName:
        channelInfo &&
        "guild" in channelInfo &&
        channelInfo.guild &&
        typeof channelInfo.guild.name === "string"
          ? channelInfo.guild.name
          : undefined,
      channelId,
      channelName:
        channelInfo && "name" in channelInfo && typeof channelInfo.name === "string"
          ? channelInfo.name
          : undefined,
      sessionChannelId,
      voiceSessionKey: voiceRoute.sessionKey,
      route,
      connection,
      player,
      playbackQueue: Promise.resolve(),
      processingQueue: Promise.resolve(),
      capture: createVoiceCaptureState(),
      transcripts: options?.transcripts,
      receiveRecovery: createVoiceReceiveRecoveryState(),
      isStopped: () => stopped,
      stop: () => {
        stopEntry(entry, {
          destroyConnection: true,
          reason: `stop guild ${guildId} channel ${channelId}`,
        });
      },
    };

    if (!options?.transcripts && isDiscordRealtimeVoiceMode(voiceMode)) {
      const realtimeResult = await this.attachRealtimeSession(entry, voiceMode);
      if (!realtimeResult.ok) {
        destroyVoiceConnectionSafely({
          connection,
          voiceSdk,
          reason: `realtime setup failed guild ${guildId} channel ${channelId}`,
        });
        return {
          ok: false,
          message: realtimeResult.message,
          guildId,
          channelId,
        };
      }
    }
    if (this.destroyed) {
      stopEntry(entry, {
        destroyConnection: true,
        reason: `manager stopped during setup guild ${guildId} channel ${channelId}`,
      });
      return {
        ok: false,
        message: "Discord voice manager is stopped.",
        guildId,
        channelId,
      };
    }

    const speakingHandler: ((userId: string) => void) | undefined = (userId: string) => {
      void this.handleSpeakingStart(entry, userId).catch((err) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
      });
    };
    const speakingEndHandler: ((userId: string) => void) | undefined = (userId: string) => {
      this.scheduleCaptureFinalize(entry, userId, "speaker end");
    };

    const disconnectedHandler: (() => Promise<void>) | undefined = async () => {
      try {
        logVoiceVerbose(
          `disconnected: attempting recovery guild ${guildId} channel ${channelId} grace=${reconnectGraceMs}ms`,
        );
        await Promise.race([
          voiceSdk.entersState(
            connection,
            voiceSdk.VoiceConnectionStatus.Signalling,
            reconnectGraceMs,
          ),
          voiceSdk.entersState(
            connection,
            voiceSdk.VoiceConnectionStatus.Connecting,
            reconnectGraceMs,
          ),
        ]);
        logVoiceVerbose(`disconnected: recovery started guild ${guildId} channel ${channelId}`);
      } catch (err) {
        logger.warn(
          `discord voice: disconnect recovery failed: guild ${guildId} channel ${channelId} timeout=${reconnectGraceMs}ms error=${formatErrorMessage(err)}; destroying connection`,
        );
        clearSessionIfCurrent();
        stopEntry(entry, {
          destroyConnection: true,
          reason: `disconnect recovery failed guild ${guildId} channel ${channelId}`,
        });
      }
    };
    const destroyedHandler: (() => void) | undefined = () => {
      clearSessionIfCurrent();
      stopEntry(entry, {
        destroyConnection: false,
        reason: `destroyed guild ${guildId} channel ${channelId}`,
      });
    };
    const playerErrorHandler: ((err: Error) => void) | undefined = (err: Error) => {
      logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
    };

    this.enableDaveReceivePassthrough(
      entry,
      "post-join warmup",
      DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
    );
    connection.receiver.speaking.on("start", speakingHandler);
    connection.receiver.speaking.on("end", speakingEndHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
    player.on("error", playerErrorHandler);

    this.sessions.set(guildId, entry);
    this.fatalAutoJoinFailures.delete(formatAutoJoinFailureKey({ guildId, channelId }));
    logger.info(
      `discord voice: joined guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} voiceModel=${voiceConfig?.model ?? "route-default"}`,
    );
    return {
      ok: true,
      message: `Joined ${formatMention({ channelId })}.`,
      guildId,
      channelId,
    };
  }

  private async attachRealtimeSession(
    entry: VoiceSessionEntry,
    voiceMode: Exclude<DiscordVoiceMode, "stt-tts">,
    options?: { requireLiveEntry?: boolean },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const bootstrapContextInstructions = await resolveDiscordVoiceRealtimeBootstrapContext({
      entry,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
    });
    if (
      entry.isStopped() ||
      (options?.requireLiveEntry === true && this.sessions.get(entry.guildId) !== entry)
    ) {
      return {
        ok: false,
        message: "Discord realtime voice session stopped before startup completed.",
      };
    }
    const realtime = new DiscordRealtimeVoiceSession({
      bootstrapContextInstructions,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      entry,
      mode: voiceMode,
      runAgentTurn: ({ context, message, toolsAllow, userId }) =>
        this.runDiscordRealtimeAgentTurn({ context, entry, message, toolsAllow, userId }),
    });
    entry.pendingRealtime = realtime;
    try {
      await realtime.connect();
      if (
        entry.pendingRealtime !== realtime ||
        entry.isStopped() ||
        (options?.requireLiveEntry === true && this.sessions.get(entry.guildId) !== entry)
      ) {
        realtime.close();
        return {
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
        };
      }
      entry.pendingRealtime = undefined;
      entry.realtime = realtime;
      return { ok: true };
    } catch (err) {
      if (entry.pendingRealtime === realtime) {
        entry.pendingRealtime = undefined;
      }
      realtime.close();
      return {
        ok: false,
        message: `Failed to start Discord realtime voice: ${formatErrorMessage(err)}`,
      };
    }
  }

  async leave(
    params: { guildId: string; channelId?: string },
    options?: { preserveFollowState?: boolean; transcriptsSessionId?: string },
  ): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.sessions.get(guildId);
    if (!entry) {
      return { ok: false, message: "Not connected to a voice channel." };
    }
    if (params.channelId && params.channelId !== entry.channelId) {
      return { ok: false, message: "Not connected to that voice channel." };
    }
    if (options?.transcriptsSessionId) {
      if (!entry.transcripts || entry.transcripts.sessionId !== options.transcriptsSessionId) {
        return {
          ok: false,
          message: "Transcripts session is not active in this voice channel.",
          guildId,
          channelId: entry.channelId,
        };
      }
      if (entry.realtime || entry.pendingRealtime) {
        entry.transcripts = undefined;
        return {
          ok: true,
          message: `Stopped transcripts for ${formatMention({ channelId: entry.channelId })}.`,
          guildId,
          channelId: entry.channelId,
        };
      }
    }
    entry.stop();
    this.sessions.delete(guildId);
    if (!options?.preserveFollowState) {
      this.followedVoiceGuilds.delete(guildId);
      this.deleteFollowedUserChannelsForGuild(guildId);
    }
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      ok: true,
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
      guildId,
      channelId: entry.channelId,
    };
  }

  async handleVoiceStateUpdate(data: APIVoiceState): Promise<void> {
    const guildId = data.guild_id?.trim();
    const userId = data.user_id?.trim();
    const channelId = data.channel_id?.trim();
    if (!guildId || !userId) {
      return;
    }

    if (this.botUserId && userId === this.botUserId) {
      await this.handleBotVoiceStateUpdate({ guildId, channelId });
      return;
    }

    if (this.followUserIds.has(userId)) {
      await this.handleFollowedUserVoiceStateUpdate({ guildId, channelId, userId });
    }
  }

  private async handleBotVoiceStateUpdate(params: {
    guildId: string;
    channelId: string | undefined;
  }): Promise<void> {
    const { guildId, channelId } = params;
    if (!channelId) {
      return;
    }
    const existing = this.sessions.get(guildId);
    if (this.isAllowedVoiceChannel({ guildId, channelId })) {
      if (existing && existing.channelId !== channelId) {
        logger.warn(
          `discord voice: bot moved to allowed channel guild=${guildId} from=${existing.channelId} to=${channelId}; rebuilding voice session`,
        );
        await this.join(
          { guildId, channelId },
          { preserveFollowState: this.isFollowOwnedGuild(guildId) },
        );
      }
      return;
    }

    logger.warn(
      `discord voice: bot moved to non-allowed channel guild=${guildId} channel=${channelId}; leaving`,
    );
    if (existing) {
      await this.leave({ guildId });
    } else {
      const voiceSdk = loadDiscordVoiceSdk();
      const connection = voiceSdk.getVoiceConnection(guildId);
      if (connection) {
        destroyVoiceConnectionSafely({
          connection,
          voiceSdk,
          reason: `non-allowed voice state guild ${guildId} channel ${channelId}`,
        });
      }
    }

    const target = this.resolveVoiceResidencyTarget(guildId);
    if (target) {
      logger.warn(
        `discord voice: rejoining allowed voice channel guild=${guildId} channel=${target.channelId}`,
      );
      await this.join(target);
    }
  }

  private async handleFollowedUserVoiceStateUpdate(params: {
    guildId: string;
    channelId: string | undefined;
    userId: string;
  }): Promise<void> {
    if (!this.voiceEnabled || this.destroyed) {
      return;
    }
    const { guildId, channelId, userId } = params;
    const followKey = this.formatFollowedUserKey({ guildId, userId });
    const existing = this.sessions.get(guildId);
    const wasFollowedVoiceSession =
      this.followedUserChannels.has(followKey) || this.followedVoiceGuilds.has(guildId);
    if (!channelId) {
      this.followedUserChannels.delete(followKey);
      if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) {
        await this.handoffToAnotherFollowedUserOrLeave({
          guildId,
          userId,
          existing,
          reason: "disconnected",
        });
      }
      return;
    }
    if (!this.isAllowedVoiceChannel({ guildId, channelId })) {
      this.followedUserChannels.delete(followKey);
      logger.warn(
        `discord voice: followed user joined non-allowed channel guild=${guildId} user=${userId} channel=${channelId}; ignoring`,
      );
      if (existing && wasFollowedVoiceSession && !this.hasFollowedUserInChannel(existing)) {
        await this.handoffToAnotherFollowedUserOrLeave({
          guildId,
          userId,
          existing,
          reason: "joined non-allowed channel",
        });
      }
      return;
    }
    this.followedUserChannels.set(followKey, { guildId, channelId });
    if (existing?.channelId === channelId) {
      this.followedVoiceGuilds.add(guildId);
      return;
    }
    logger.info(
      `discord voice: following user guild=${guildId} user=${userId} channel=${channelId}`,
    );
    const result = await this.join({ guildId, channelId }, { preserveFollowState: true });
    if (!result.ok) {
      const current = this.sessions.get(guildId);
      if (current?.channelId === channelId) {
        this.followedVoiceGuilds.add(guildId);
      } else {
        this.followedUserChannels.delete(followKey);
      }
      logger.warn(
        `discord voice: failed to follow user guild=${guildId} user=${userId} channel=${channelId}: ${result.message}`,
      );
      return;
    }
    this.followedVoiceGuilds.add(guildId);
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.followUsersReconcileTimer) {
      clearInterval(this.followUsersReconcileTimer);
      this.followUsersReconcileTimer = null;
    }
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    this.sessions.clear();
    this.followedUserChannels.clear();
    this.followedVoiceGuilds.clear();
  }

  private resolveFollowGuildIds(): string[] {
    const guildIds = new Set<string>();
    for (const guildId of Object.keys(this.params.discordConfig.guilds ?? {})) {
      const normalized = guildId.trim();
      if (normalized) {
        guildIds.add(normalized);
      }
    }
    for (const entry of normalizeVoiceChannelResidencies(
      this.params.discordConfig.voice?.autoJoin,
    )) {
      guildIds.add(entry.guildId);
    }
    for (const entry of this.allowedChannels ?? []) {
      guildIds.add(entry.guildId);
    }
    for (const entry of this.sessions.values()) {
      guildIds.add(entry.guildId);
    }
    return Array.from(guildIds);
  }

  private ensureFollowUsersReconcileTimer(): void {
    if (this.followUserIds.size === 0) {
      return;
    }
    if (this.followUsersReconcileTimer) {
      return;
    }
    this.followUsersReconcileTimer = setInterval(() => {
      void this.reconcileFollowedUsers("interval").catch((err) => {
        logger.warn(`discord voice: follow user reconciliation failed: ${formatErrorMessage(err)}`);
      });
    }, FOLLOW_USERS_RECONCILE_INTERVAL_MS);
    this.followUsersReconcileTimer.unref?.();
  }

  private async reconcileFollowedUsers(reason: string): Promise<void> {
    if (this.followUserIds.size === 0 || this.destroyed) {
      return;
    }
    if (this.followUsersReconcileTask) {
      return this.followUsersReconcileTask;
    }
    this.followUsersReconcileTask = this.runFollowedUsersReconcile(reason).finally(() => {
      this.followUsersReconcileTask = null;
    });
    return this.followUsersReconcileTask;
  }

  private async runFollowedUsersReconcile(reason: string): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const guildIds = this.resolveFollowGuildIds();
    if (guildIds.length === 0) {
      logVoiceVerbose(
        `follow user reconcile skipped reason=${reason}: no Discord guild ids are configured`,
      );
      return;
    }
    logFollowUserReconcileVerbose(
      reason,
      `follow user reconcile reason=${reason}: ${this.followUserIds.size} users across ${guildIds.length} guilds`,
    );
    const plans = this.selectFollowUserReconcilePlans(guildIds, reason);
    for (const plan of plans) {
      for (const userId of plan.userIds) {
        const voiceState = await getGuildVoiceState(
          this.params.client.rest,
          plan.guildId,
          userId,
        ).catch((err) => {
          if (!isUnknownDiscordVoiceStateError(err)) {
            logger.warn(
              `discord voice: follow user reconcile skipped transient voice state error guild=${plan.guildId} user=${userId} reason=${reason}: ${formatErrorMessage(err)}`,
            );
            return "transient-error" as const;
          }
          logFollowUserReconcileVerbose(
            reason,
            `follow user reconcile reason=${reason}: no voice state guild ${plan.guildId} user ${userId}: ${formatErrorMessage(err)}`,
          );
          return undefined;
        });
        if (this.destroyed) {
          return;
        }
        if (voiceState === "transient-error") {
          continue;
        }
        const channelId = voiceState?.channel_id?.trim();
        await this.handleFollowedUserVoiceStateUpdate({
          guildId: plan.guildId,
          channelId,
          userId,
        });
      }
      if (plan.checkBotVoiceState) {
        if (this.destroyed) {
          return;
        }
        await this.disconnectStaleFollowedBotVoiceState({ guildId: plan.guildId, reason });
      }
    }
  }

  private selectFollowUserReconcilePlans(
    guildIds: string[],
    reason: string,
  ): FollowUserReconcileGuildPlan[] {
    const followedUserIds = Array.from(this.followUserIds);
    if (followedUserIds.length === 0) {
      return [];
    }
    let remainingLookups = FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN;
    const guildLimit = Math.min(guildIds.length, FOLLOW_USERS_RECONCILE_MAX_GUILDS_PER_RUN);
    const start = this.followUsersReconcileGuildCursor % guildIds.length;
    const plans: FollowUserReconcileGuildPlan[] = [];

    for (let offset = 0; offset < guildLimit && remainingLookups > 0; offset += 1) {
      if (this.botUserId && remainingLookups === 1) {
        break;
      }
      const guildId = guildIds[(start + offset) % guildIds.length];
      const userLimit = this.resolveFollowUserReconcileUserLookupLimit(
        followedUserIds.length,
        remainingLookups,
      );
      if (userLimit <= 0) {
        break;
      }
      const selection = this.selectFollowUserReconcileUserIds(guildId, followedUserIds, userLimit);
      plans.push({
        guildId,
        userIds: selection.userIds,
        checkedAllUsers: selection.completedCycle,
        checkBotVoiceState: false,
      });
      remainingLookups -= selection.userIds.length;
    }

    this.followUsersReconcileGuildCursor = (start + plans.length) % guildIds.length;
    this.assignFollowUserReconcileBotChecks(guildIds, plans, remainingLookups);
    if (
      plans.length < guildIds.length ||
      plans.some((plan) => plan.userIds.length < followedUserIds.length)
    ) {
      logVoiceVerbose(
        `follow user reconcile reason=${reason}: sampling ${plans.length}/${guildIds.length} guilds and up to ${FOLLOW_USERS_RECONCILE_MAX_REST_LOOKUPS_PER_RUN} REST lookups`,
      );
    }
    return plans;
  }

  private assignFollowUserReconcileBotChecks(
    guildIds: string[],
    plans: FollowUserReconcileGuildPlan[],
    remainingLookups: number,
  ): void {
    if (!this.botUserId || remainingLookups <= 0 || plans.length === 0) {
      return;
    }
    const plansByGuild = new Map(plans.map((plan) => [plan.guildId, plan]));
    const start = this.followUsersReconcileBotGuildCursor % guildIds.length;
    let scanned = 0;
    let assigned = 0;
    for (; scanned < guildIds.length && assigned < remainingLookups; scanned += 1) {
      const guildId = guildIds[(start + scanned) % guildIds.length];
      const plan = plansByGuild.get(guildId);
      if (!plan?.checkedAllUsers) {
        continue;
      }
      plan.checkBotVoiceState = true;
      assigned += 1;
    }
    this.followUsersReconcileBotGuildCursor = (start + scanned) % guildIds.length;
  }

  private resolveFollowUserReconcileUserLookupLimit(
    followedUserCount: number,
    remainingLookups: number,
  ): number {
    const userLimit = Math.min(followedUserCount, remainingLookups);
    if (this.botUserId && followedUserCount > userLimit && remainingLookups > 1) {
      return remainingLookups - 1;
    }
    return userLimit;
  }

  private selectFollowUserReconcileUserIds(
    guildId: string,
    followedUserIds: string[],
    limit: number,
  ): FollowUserReconcileUserSelection {
    if (followedUserIds.length <= limit) {
      this.followUsersReconcileUserCursors.set(guildId, 0);
      return { userIds: followedUserIds, completedCycle: true };
    }
    const start = this.followUsersReconcileUserCursors.get(guildId) ?? 0;
    const selected = Array.from(
      { length: limit },
      (_, offset) => followedUserIds[(start + offset) % followedUserIds.length],
    );
    const completedCycle = start + selected.length >= followedUserIds.length;
    this.followUsersReconcileUserCursors.set(
      guildId,
      (start + selected.length) % followedUserIds.length,
    );
    return { userIds: selected, completedCycle };
  }

  private formatFollowedUserKey(params: { guildId: string; userId: string }): string {
    return `${params.guildId}:${params.userId}`;
  }

  private hasFollowedUserInChannel(entry: VoiceChannelResidency): boolean {
    return Array.from(this.followedUserChannels.values()).some(
      (candidate) => candidate.guildId === entry.guildId && candidate.channelId === entry.channelId,
    );
  }

  private resolveFollowedUserHandoffTarget(
    guildId: string,
    currentChannelId: string,
  ): VoiceChannelResidency | null {
    for (const entry of this.followedUserChannels.values()) {
      if (
        entry.guildId === guildId &&
        entry.channelId !== currentChannelId &&
        this.isAllowedVoiceChannel(entry)
      ) {
        return entry;
      }
    }
    return null;
  }

  private async handoffToAnotherFollowedUserOrLeave(params: {
    guildId: string;
    userId: string;
    existing: VoiceChannelResidency;
    reason: string;
  }): Promise<void> {
    const target = this.resolveFollowedUserHandoffTarget(params.guildId, params.existing.channelId);
    if (target) {
      logger.info(
        `discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; moving to remaining followed user channel=${target.channelId}`,
      );
      const result = await this.join(target, { preserveFollowState: true });
      if (result.ok) {
        this.followedVoiceGuilds.add(params.guildId);
      } else {
        logger.warn(
          `discord voice: failed to hand off followed user session guild=${params.guildId} channel=${target.channelId}: ${result.message}`,
        );
        this.followedVoiceGuilds.delete(params.guildId);
        this.deleteFollowedUserChannelsForGuild(params.guildId);
        await this.leave({ guildId: params.guildId });
      }
      return;
    }
    logger.info(
      `discord voice: followed user ${params.reason} guild=${params.guildId} user=${params.userId}; leaving channel=${params.existing.channelId}`,
    );
    await this.leave({ guildId: params.guildId });
  }

  private isFollowOwnedGuild(guildId: string): boolean {
    return (
      this.followedVoiceGuilds.has(guildId) ||
      Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)
    );
  }

  private deleteFollowedUserChannelsForGuild(guildId: string): void {
    for (const [key, entry] of this.followedUserChannels.entries()) {
      if (entry.guildId === guildId) {
        this.followedUserChannels.delete(key);
      }
    }
  }

  private async disconnectStaleFollowedBotVoiceState(params: {
    guildId: string;
    reason: string;
  }): Promise<void> {
    if (this.destroyed) {
      return;
    }
    const { guildId, reason } = params;
    if (Array.from(this.followedUserChannels.values()).some((entry) => entry.guildId === guildId)) {
      return;
    }
    const existing = this.sessions.get(guildId);
    if (existing) {
      if (this.followedVoiceGuilds.has(guildId)) {
        logger.info(
          `discord voice: follow reconcile leaving local session guild=${guildId} channel=${existing.channelId} reason=${reason}`,
        );
        await this.leave({ guildId });
      }
      return;
    }
    if (!this.botUserId) {
      return;
    }
    const botVoiceState = await getGuildVoiceState(
      this.params.client.rest,
      guildId,
      this.botUserId,
    ).catch((err) => {
      if (!isUnknownDiscordVoiceStateError(err)) {
        logger.warn(
          `discord voice: follow reconcile skipped transient bot voice state error guild=${guildId} reason=${reason}: ${formatErrorMessage(err)}`,
        );
        return "transient-error" as const;
      }
      logFollowUserReconcileVerbose(
        reason,
        `follow user reconcile reason=${reason}: no bot voice state guild ${guildId}: ${formatErrorMessage(err)}`,
      );
      return undefined;
    });
    if (this.destroyed || botVoiceState === "transient-error") {
      return;
    }
    const botChannelId = botVoiceState?.channel_id?.trim();
    if (!botChannelId) {
      return;
    }
    const voicePlugin = this.params.client.getPlugin<VoicePlugin>("voice");
    const gateway = voicePlugin?.getGateway(guildId);
    if (!gateway) {
      logger.warn(
        `discord voice: follow reconcile cannot disconnect stale bot voice state guild=${guildId} channel=${botChannelId}; gateway unavailable`,
      );
      return;
    }
    logger.info(
      `discord voice: follow reconcile disconnecting stale bot voice state guild=${guildId} channel=${botChannelId} reason=${reason}`,
    );
    gateway.updateVoiceState({
      guild_id: guildId,
      channel_id: null,
      self_mute: false,
      self_deaf: false,
    });
  }

  private resolveVoiceResidencyTarget(guildId: string): VoiceChannelResidency | null {
    const autoJoinTarget = normalizeVoiceChannelResidencies(
      this.params.discordConfig.voice?.autoJoin,
    )
      .toReversed()
      .find((entry) => entry.guildId === guildId);
    if (autoJoinTarget && this.isAllowedVoiceChannel(autoJoinTarget)) {
      return autoJoinTarget;
    }
    if (this.allowedChannels === null) {
      return null;
    }
    const guildAllowed = this.allowedChannels.filter((entry) => entry.guildId === guildId);
    return guildAllowed.length === 1 ? guildAllowed[0] : null;
  }

  private enqueueProcessing(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.processingQueue = entry.processingQueue
      .then(task)
      .catch((err) => logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`));
  }

  private enqueuePlayback(entry: VoiceSessionEntry, task: () => Promise<void>) {
    entry.playbackQueue = entry.playbackQueue
      .then(task)
      .catch((err) => logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`));
  }

  private clearCaptureFinalizeTimer(entry: VoiceSessionEntry, userId: string, generation?: number) {
    return clearVoiceCaptureFinalizeTimer(entry.capture, userId, generation);
  }

  private scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string) {
    const graceMs = resolveVoiceTimeoutMs(
      this.params.discordConfig.voice?.captureSilenceGraceMs,
      CAPTURE_FINALIZE_GRACE_MS,
    );
    scheduleVoiceCaptureFinalize({
      state: entry.capture,
      userId,
      delayMs: graceMs,
      onFinalize: () => {
        logVoiceVerbose(
          `capture finalize: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${reason} grace=${graceMs}ms`,
        );
      },
    });
  }

  private async handleSpeakingStart(entry: VoiceSessionEntry, userId: string) {
    if (!userId) {
      return;
    }
    if (this.botUserId && userId === this.botUserId) {
      return;
    }
    if (isVoiceCaptureActive(entry.capture, userId)) {
      const activeCapture = getActiveVoiceCapture(entry.capture, userId);
      const extended = activeCapture
        ? this.clearCaptureFinalizeTimer(entry, userId, activeCapture.generation)
        : false;
      logVoiceVerbose(
        `capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`,
      );
      return;
    }

    logVoiceVerbose(
      `capture start: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
    );
    const voiceSdk = loadDiscordVoiceSdk();
    const voiceMode = resolveDiscordVoiceMode(this.params.discordConfig.voice);
    const realtime =
      entry.realtime && isDiscordRealtimeVoiceMode(voiceMode) ? entry.realtime : undefined;
    if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing && !realtime) {
      logVoiceVerbose(
        `capture ignored during playback: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    const realtimeIngress = realtime
      ? await this.resolveDiscordVoiceIngressContext(entry, userId)
      : undefined;
    if (realtime && !realtimeIngress) {
      logVoiceVerbose(
        `realtime capture unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return;
    }
    if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing && realtime) {
      if (!realtime.isBargeInEnabled()) {
        logger.info(
          `discord voice: realtime capture ignored during playback (barge-in disabled): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      logVoiceVerbose(
        `realtime barge-in: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      logger.info(
        `discord voice: realtime barge-in detected source=speaker-start guild=${entry.guildId} channel=${entry.channelId} user=${userId} playerStatus=${entry.player.state.status}`,
      );
      realtime.handleBargeIn("speaker-start");
    }
    this.enableDaveReceivePassthrough(
      entry,
      `speaker ${userId} start`,
      DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
    );
    const stream = entry.connection.receiver.subscribe(userId, {
      end: {
        behavior: voiceSdk.EndBehaviorType.Manual,
      },
    });
    const generation = beginVoiceCapture(entry.capture, userId, stream);
    let streamAborted = false;
    let receiveFailureHandled = false;
    let receiveStreamEndHandled = false;
    const handleStreamError = (err: unknown) => {
      const analysis = analyzeVoiceReceiveError(err);
      if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
        if (receiveStreamEndHandled) {
          return;
        }
        receiveStreamEndHandled = true;
        streamAborted = true;
        this.handleReceiveError(entry, err);
        return;
      }
      if (receiveFailureHandled) {
        return;
      }
      receiveFailureHandled = true;
      this.handleReceiveError(entry, err);
    };
    stream.on("error", handleStreamError);

    try {
      if (realtime && realtimeIngress) {
        const turn = realtime.beginSpeakerTurn(realtimeIngress, userId);
        try {
          await this.processRealtimeAudioCapture({
            entry,
            onReceiveError: handleStreamError,
            stream,
            turn,
          });
        } finally {
          turn.close();
        }
        return;
      }
      const pcm = await decodeOpusStream(stream, {
        onError: handleStreamError,
        onVerbose: logVoiceVerbose,
        onWarn: (message) => logger.warn(message),
      });
      if (receiveFailureHandled) {
        return;
      }
      if (pcm.length === 0) {
        logVoiceVerbose(
          `capture empty: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      this.resetDecryptFailureState(entry);
      const { path: wavPath, durationSeconds } = await writeVoiceWavFile(pcm);
      const minimumDurationSeconds = streamAborted ? 0.2 : MIN_SEGMENT_SECONDS;
      if (durationSeconds < minimumDurationSeconds) {
        logVoiceVerbose(
          `capture too short (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
        );
        return;
      }
      logVoiceVerbose(
        `capture ready (${durationSeconds.toFixed(2)}s): guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      this.enqueueProcessing(entry, async () => {
        await this.processSegment({ entry, wavPath, userId, durationSeconds });
      });
    } catch (err) {
      if (!receiveFailureHandled) {
        this.handleReceiveError(entry, err);
      }
      throw err;
    } finally {
      stream.off?.("error", handleStreamError);
      const finishedActiveCapture = finishVoiceCapture(entry.capture, userId, generation);
      if (finishedActiveCapture && !stream.destroyed) {
        stream.destroy();
      }
    }
  }

  private async processRealtimeAudioCapture(params: {
    entry: VoiceSessionEntry;
    onReceiveError: (err: unknown) => void;
    stream: import("node:stream").Readable;
    turn: import("./session.js").VoiceRealtimeSpeakerTurn;
  }): Promise<void> {
    const { entry, onReceiveError, stream, turn } = params;
    let resetReceiveRecovery = false;
    await decodeOpusStreamChunks(stream, {
      onChunk: (pcm) => {
        if (!resetReceiveRecovery && pcm.length > 0) {
          resetReceiveRecovery = true;
          this.resetDecryptFailureState(entry);
        }
        turn.sendInputAudio(pcm);
      },
      onError: onReceiveError,
      onVerbose: logVoiceVerbose,
      onWarn: (message) => logger.warn(message),
    });
  }

  private async resolveDiscordVoiceIngressContext(
    entry: VoiceSessionEntry,
    userId: string,
  ): Promise<DiscordVoiceIngressContext | null> {
    return await resolveDiscordVoiceIngressContext({
      entry,
      userId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      ownerAllowFrom: this.ownerAllowFrom,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      speakerContext: this.speakerContext,
    });
  }

  private async runDiscordRealtimeAgentTurn(params: {
    context: {
      extraSystemPrompt?: string;
      senderIsOwner: boolean;
      speakerLabel: string;
    };
    entry: VoiceSessionEntry;
    message: string;
    toolsAllow?: string[];
    userId: string;
  }): Promise<string> {
    const { context, entry, message, toolsAllow, userId } = params;
    logger.info(
      `discord voice: agent turn start guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId} user=${userId} speaker=${context.speakerLabel} owner=${context.senderIsOwner} model=${this.params.discordConfig.voice?.model ?? "route-default"} message=${formatVoiceLogPreview(message)}`,
    );
    const turn = await runDiscordVoiceAgentTurn({
      entry,
      userId,
      message,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      runtime: this.params.runtime,
      context,
      toolsAllow,
      ownerAllowFrom: this.ownerAllowFrom,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      speakerContext: this.speakerContext,
    });
    if (!turn) {
      logVoiceVerbose(
        `realtime agent unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
      );
      return "";
    }
    logger.info(
      `discord voice: agent turn answer (${turn.text.length} chars) guild=${entry.guildId} channel=${entry.channelId} voiceSession=${entry.voiceSessionKey} supervisorSession=${entry.route.sessionKey} agent=${entry.route.agentId}: ${formatVoiceLogPreview(turn.text)}`,
    );
    return turn.text;
  }

  private async processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
  }) {
    await processDiscordVoiceSegment({
      ...params,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      ownerAllowFrom: this.ownerAllowFrom,
      runtime: this.params.runtime,
      speakerContext: this.speakerContext,
      transcripts: params.entry.transcripts,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      enqueuePlayback: (entry, task) => {
        this.enqueuePlayback(entry, task);
      },
    });
  }

  private handleReceiveError(entry: VoiceSessionEntry, err: unknown) {
    const analysis = analyzeVoiceReceiveError(err);
    if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive stream ended: ${analysis.message}`);
      return;
    }
    logger.warn(`discord voice: receive error: ${analysis.message}`);
    if (analysis.shouldAttemptPassthrough) {
      this.enableDaveReceivePassthrough(
        entry,
        "receive decrypt error",
        DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
      );
    }
    if (!analysis.countsAsDecryptFailure) {
      return;
    }
    const decryptFailure = noteVoiceDecryptFailure(entry.receiveRecovery);
    if (decryptFailure.firstFailure) {
      logger.warn(
        "discord voice: DAVE decrypt failures detected; voice receive may be unstable (upstream: discordjs/discord.js#11419)",
      );
    }
    if (!decryptFailure.shouldRecover) {
      return;
    }
    void this.recoverFromDecryptFailures(entry)
      .catch((recoverErr) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`),
      )
      .finally(() => {
        finishVoiceDecryptRecovery(entry.receiveRecovery);
      });
  }

  private enableDaveReceivePassthrough(
    entry: Pick<VoiceSessionEntry, "guildId" | "channelId" | "connection">,
    reason: string,
    expirySeconds: number,
  ): boolean {
    const voiceSdk = loadDiscordVoiceSdk();
    return tryEnableDaveReceivePassthrough({
      target: {
        guildId: entry.guildId,
        channelId: entry.channelId,
        connection: entry.connection as {
          state: {
            status: unknown;
            networking?: {
              state?: {
                code?: unknown;
                dave?: {
                  session?: {
                    setPassthroughMode: (passthrough: boolean, expirySeconds: number) => void;
                  };
                };
              };
            };
          };
        },
      },
      sdk: {
        VoiceConnectionStatus: {
          Ready: voiceSdk.VoiceConnectionStatus.Ready,
        },
        NetworkingStatusCode: {
          Ready: voiceSdk.NetworkingStatusCode.Ready,
          Resuming: voiceSdk.NetworkingStatusCode.Resuming,
        },
      },
      reason,
      expirySeconds,
      onVerbose: logVoiceVerbose,
      onWarn: (message) => logger.warn(message),
    });
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry) {
    resetVoiceReceiveRecoveryState(entry.receiveRecovery);
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry) {
    const active = this.sessions.get(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    const preserveFollowState = this.isFollowOwnedGuild(entry.guildId);
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.leave({ guildId: entry.guildId }, { preserveFollowState });
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.join(
      { guildId: entry.guildId, channelId: entry.channelId },
      { preserveFollowState },
    );
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }
}

export class DiscordVoiceReadyListener extends ReadyListener {
  constructor(private manager: DiscordVoiceManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(this.manager);
  }
}

export class DiscordVoiceResumedListener extends ResumedListener {
  constructor(private manager: DiscordVoiceManager) {
    super();
  }

  async handle(_data: unknown, _client: Client): Promise<void> {
    startAutoJoin(this.manager);
  }
}

export class DiscordVoiceStateUpdateListener extends VoiceStateUpdateListener {
  constructor(private manager: DiscordVoiceManager) {
    super();
  }

  async handle(data: APIVoiceState, _client: Client): Promise<void> {
    await this.manager.handleVoiceStateUpdate(data);
  }
}
