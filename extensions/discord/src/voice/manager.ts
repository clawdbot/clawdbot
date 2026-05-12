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
  resolveDiscordVoiceIngressContext,
  runDiscordVoiceAgentTurn,
} from "./ingress.js";
import {
  DiscordRealtimeVoiceSession,
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
  private botUserId?: string;
  private readonly voiceEnabled: boolean;
  private autoJoinTask: Promise<void> | null = null;
  private readonly ownerAllowFrom?: string[];
  private readonly speakerContext: DiscordVoiceSpeakerContextResolver;
  private readonly allowedChannels: VoiceChannelResidency[] | null;

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
    if (!this.voiceEnabled) {
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
        logVoiceVerbose(`autoJoin: joining guild ${entry.guildId} channel ${entry.channelId}`);
        const result = await this.join({
          guildId: entry.guildId,
          channelId: entry.channelId,
        });
        if (!result.ok) {
          logger.warn(
            `discord voice: autoJoin skipped guild=${entry.guildId} channel=${entry.channelId}: ${result.message}`,
          );
        }
      }
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

  async join(params: { guildId: string; channelId: string }): Promise<VoiceOperationResult> {
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

    const existing = this.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
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
      await this.leave({ guildId });
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

    const voiceConfig = this.params.discordConfig.voice;
    const voiceMode = resolveDiscordVoiceMode(voiceConfig);
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
    const connection = voiceSdk.joinVoiceChannel({
      channelId,
      guildId,
      adapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption,
      decryptionFailureTolerance,
    });

    try {
      await voiceSdk.entersState(
        connection,
        voiceSdk.VoiceConnectionStatus.Ready,
        connectReadyTimeoutMs,
      );
      logVoiceVerbose(`join: connected to guild ${guildId} channel ${channelId}`);
    } catch (err) {
      logger.warn(
        `discord voice: join failed before ready: guild ${guildId} channel ${channelId} timeout=${connectReadyTimeoutMs}ms error=${formatErrorMessage(err)}`,
      );
      destroyVoiceConnectionSafely({
        connection,
        voiceSdk,
        reason: `failed join cleanup guild ${guildId} channel ${channelId}`,
      });
      return { ok: false, message: `Failed to join voice channel: ${formatErrorMessage(err)}` };
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

    let speakingHandler: ((userId: string) => void) | undefined;
    let speakingEndHandler: ((userId: string) => void) | undefined;
    let disconnectedHandler: (() => Promise<void>) | undefined;
    let destroyedHandler: (() => void) | undefined;
    let playerErrorHandler: ((err: Error) => void) | undefined;
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
      receiveRecovery: createVoiceReceiveRecoveryState(),
      stop: () => {
        stopEntry(entry, {
          destroyConnection: true,
          reason: `stop guild ${guildId} channel ${channelId}`,
        });
      },
    };

    if (voiceMode !== "stt-tts") {
      entry.realtime = new DiscordRealtimeVoiceSession({
        cfg: this.params.cfg,
        discordConfig: this.params.discordConfig,
        entry,
        mode: voiceMode,
        runAgentTurn: ({ context, message, toolsAllow, userId }) =>
          this.runDiscordRealtimeAgentTurn({ context, entry, message, toolsAllow, userId }),
      });
      try {
        await entry.realtime.connect();
      } catch (err) {
        entry.realtime.close();
        destroyVoiceConnectionSafely({
          connection,
          voiceSdk,
          reason: `realtime setup failed guild ${guildId} channel ${channelId}`,
        });
        return {
          ok: false,
          message: `Failed to start Discord realtime voice: ${formatErrorMessage(err)}`,
          guildId,
          channelId,
        };
      }
    }

    speakingHandler = (userId: string) => {
      void this.handleSpeakingStart(entry, userId).catch((err) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
      });
    };
    speakingEndHandler = (userId: string) => {
      this.scheduleCaptureFinalize(entry, userId, "speaker end");
    };

    disconnectedHandler = async () => {
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
    destroyedHandler = () => {
      clearSessionIfCurrent();
      stopEntry(entry, {
        destroyConnection: false,
        reason: `destroyed guild ${guildId} channel ${channelId}`,
      });
    };
    playerErrorHandler = (err: Error) => {
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

  async leave(params: { guildId: string; channelId?: string }): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.sessions.get(guildId);
    if (!entry) {
      return { ok: false, message: "Not connected to a voice channel." };
    }
    if (params.channelId && params.channelId !== entry.channelId) {
      return { ok: false, message: "Not connected to that voice channel." };
    }
    entry.stop();
    this.sessions.delete(guildId);
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      ok: true,
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
      guildId,
      channelId: entry.channelId,
    };
  }

  async handleVoiceStateUpdate(data: APIVoiceState): Promise<void> {
    if (!this.botUserId || data.user_id !== this.botUserId) {
      return;
    }
    const guildId = data.guild_id?.trim();
    const channelId = data.channel_id?.trim();
    if (!guildId || !channelId) {
      return;
    }

    const existing = this.sessions.get(guildId);
    if (this.isAllowedVoiceChannel({ guildId, channelId })) {
      if (existing && existing.channelId !== channelId) {
        logger.warn(
          `discord voice: bot moved to allowed channel guild=${guildId} from=${existing.channelId} to=${channelId}; rebuilding voice session`,
        );
        await this.join({ guildId, channelId });
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

  async destroy(): Promise<void> {
    for (const entry of this.sessions.values()) {
      entry.stop();
    }
    this.sessions.clear();
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
    stream.on("error", (err) => {
      streamAborted = analyzeVoiceReceiveError(err).isAbortLike;
      this.handleReceiveError(entry, err);
    });

    try {
      if (realtime && realtimeIngress) {
        const turn = realtime.beginSpeakerTurn(realtimeIngress, userId);
        try {
          await this.processRealtimeAudioCapture({ entry, stream, turn });
        } finally {
          turn.close();
        }
        return;
      }
      const pcm = await decodeOpusStream(stream, {
        onVerbose: logVoiceVerbose,
        onWarn: (message) => logger.warn(message),
      });
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
    } finally {
      finishVoiceCapture(entry.capture, userId, generation);
    }
  }

  private async processRealtimeAudioCapture(params: {
    entry: VoiceSessionEntry;
    stream: import("node:stream").Readable;
    turn: import("./session.js").VoiceRealtimeSpeakerTurn;
  }): Promise<void> {
    const { entry, stream, turn } = params;
    let resetReceiveRecovery = false;
    await decodeOpusStreamChunks(stream, {
      onChunk: (pcm) => {
        if (!resetReceiveRecovery && pcm.length > 0) {
          resetReceiveRecovery = true;
          this.resetDecryptFailureState(entry);
        }
        turn.sendInputAudio(pcm);
      },
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
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.leave({ guildId: entry.guildId });
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.join({ guildId: entry.guildId, channelId: entry.channelId });
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
