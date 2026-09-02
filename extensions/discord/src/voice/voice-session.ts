import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import type { VoicePlugin } from "../internal/voice.js";
import { formatMention } from "../mentions.js";
import { getDiscordRuntime } from "../runtime.js";
import { parseDiscordTarget } from "../target-parsing.js";
import { createVoiceCaptureState, stopVoiceCaptureState } from "./capture-state.js";
import { resolveDiscordVoiceRealtimeBootstrapContext } from "./ingress.js";
import type { DiscordVoiceMembershipTracker } from "./membership.js";
import {
  createVoiceReceiveRecoveryState,
  DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
} from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import {
  isDiscordRealtimeVoiceMode,
  isVoiceChannel,
  logVoiceVerbose,
  resolveDiscordVoiceMode,
  resolveVoiceTimeoutMs,
  VOICE_CONNECT_READY_TIMEOUT_MS,
  VOICE_RECONNECT_GRACE_MS,
  type DiscordVoiceMode,
  type VoiceJoinOptions,
  type VoiceOperationResult,
  type VoiceSessionGeneration,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceReceive } from "./voice-receive.js";

const logger = createSubsystemLogger("discord/voice");
const REALTIME_PLAYBACK_MAX_MISSED_FRAMES = 100;

function isVoiceSessionStopped(entry: VoiceSessionEntry): boolean {
  return entry.sessionLifecycle.status === "stopped";
}

function retireTranscripts(entry: VoiceSessionEntry): void {
  const transcripts = entry.transcripts;
  entry.transcripts = undefined;
  // Detach before notifying: retained delivery and reentrant stop cannot target
  // this binding or a replacement installed while notification settles.
  try {
    void Promise.resolve(transcripts?.onStop?.()).catch((error: unknown) => {
      logger.warn(`discord voice: transcripts retirement failed: ${formatErrorMessage(error)}`);
    });
  } catch (error) {
    logger.warn(`discord voice: transcripts retirement failed: ${formatErrorMessage(error)}`);
  }
}

type DiscordVoiceSdk = ReturnType<typeof loadDiscordVoiceSdk>;
type DiscordVoiceConnection = ReturnType<DiscordVoiceSdk["joinVoiceChannel"]>;

function isVoiceConnectionDestroyed(
  connection: DiscordVoiceConnection,
  voiceSdk: DiscordVoiceSdk,
): boolean {
  return connection.state.status === voiceSdk.VoiceConnectionStatus.Destroyed;
}

export function destroyVoiceConnectionSafely(params: {
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

function resolveVoiceConnectionGroup(accountId: string): string {
  return `openclaw:${accountId}`;
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

export class DiscordVoiceSessions {
  constructor(
    private readonly params: {
      accountId: string;
      botUserId: () => string | undefined;
      cfg: OpenClawConfig;
      client: Client;
      destroyed: () => boolean;
      discordConfig: DiscordAccountConfig;
      membership: DiscordVoiceMembershipTracker;
      onLeaveFollowState: (guildId: string) => void;
      onSessionStopped: (entry: VoiceSessionEntry, reason: string) => void;
      receive: DiscordVoiceReceive;
      sessions: Map<string, VoiceSessionEntry>;
    },
  ) {}

  refreshGuildRoster(guildId: string): void {
    const entry = this.params.sessions.get(guildId.trim());
    if (!entry || entry.sessionLifecycle.status === "stopped") {
      return;
    }
    this.params.membership.activate(entry, this.params.botUserId());
  }

  async joinUnlocked(
    params: { guildId: string; channelId: string },
    options?: VoiceJoinOptions,
    authority?: VoiceSessionGeneration,
  ): Promise<VoiceOperationResult> {
    const { guildId, channelId } = params;
    const voiceConfig = this.params.discordConfig.voice;
    const voiceMode = resolveDiscordVoiceMode(voiceConfig);
    const cancelledJoinResult = (): VoiceOperationResult => ({
      ok: false,
      message: "Discord voice join was cancelled.",
      guildId,
      channelId,
    });

    const existing = this.params.sessions.get(guildId);
    if (existing && existing.channelId === channelId) {
      existing.autoJoinWhenOccupied = options?.autoJoinWhenOccupied === true;
      if (authority) {
        existing.generation = authority.generation;
      }
      if (options?.transcripts) {
        retireTranscripts(existing);
        existing.transcripts = options.transcripts;
      }
      if (
        !options?.transcripts &&
        isDiscordRealtimeVoiceMode(voiceMode) &&
        existing.realtimeLifecycle.status !== "active" &&
        existing.realtimeLifecycle.status !== "starting"
      ) {
        const realtimeResult = await this.attachRealtimeSession(existing, voiceMode, {
          requireLiveEntry: true,
          isCurrent: authority?.isCurrent,
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

    let channelInfo: Awaited<ReturnType<Client["fetchChannel"]>>;
    try {
      channelInfo = await this.params.client.fetchChannel(channelId);
    } catch (err) {
      // A leave or replacement can invalidate the join while the REST lookup is pending;
      // cancellation remains authoritative over a stale lookup failure.
      if (authority && !authority.isCurrent()) {
        return cancelledJoinResult();
      }
      return {
        ok: false,
        message: `Failed to resolve Discord channel ${channelId}: ${formatErrorMessage(err)}`,
        guildId,
        channelId,
      };
    }
    if (authority && !authority.isCurrent()) {
      return cancelledJoinResult();
    }
    if (!isVoiceChannel(channelInfo.type)) {
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

    const audioInputBudget = await getDiscordRuntime().mediaUnderstanding.resolveAudioInputBudget({
      cfg: this.params.cfg,
    });
    if (authority && !authority.isCurrent()) {
      return cancelledJoinResult();
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
    const existingEntry = this.params.sessions.get(guildId);
    if (existingEntry) {
      existingEntry.stop();
    }
    const voiceConnectionGroup = resolveVoiceConnectionGroup(this.params.accountId);
    const staleConnection = voiceSdk.getVoiceConnection(guildId, voiceConnectionGroup);
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
        group: voiceConnectionGroup,
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
          !this.params.destroyed() &&
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
    if (authority && !authority.isCurrent()) {
      destroyVoiceConnectionSafely({
        connection,
        voiceSdk,
        reason: `cancelled join guild ${guildId} channel ${channelId}`,
      });
      return cancelledJoinResult();
    }
    if (this.params.destroyed()) {
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
      `discord voice: joining guild=${guildId} channel=${channelId} mode=${voiceMode} agent=${route.agentId} voiceSession=${voiceRoute.sessionKey} supervisorSession=${route.sessionKey} agentSessionMode=${agentSessionMode}${agentSessionTarget ? ` agentSessionTarget=${agentSessionTarget}` : ""} voiceModel=${voiceConfig?.model ?? "route-default"} realtimeProvider=${voiceConfig?.realtime?.provider ?? "auto"} realtimeModel=${voiceConfig?.realtime?.model ?? "provider-default"} realtimeVoice=${voiceConfig?.realtime?.speakerVoice ?? voiceConfig?.realtime?.speakerVoiceId ?? "provider-default"}`,
    );

    // Discord consumes frames every 20 ms; provider jitter must not end a live response after 100 ms.
    const player = isDiscordRealtimeVoiceMode(voiceMode)
      ? voiceSdk.createAudioPlayer({
          behaviors: { maxMissedFrames: REALTIME_PLAYBACK_MAX_MISSED_FRAMES },
        })
      : voiceSdk.createAudioPlayer();
    connection.subscribe(player);
    const stopEntry = (optionsLocal: { destroyConnection: boolean; reason: string }) => {
      if (entry.sessionLifecycle.status === "stopped") {
        return;
      }
      entry.sessionLifecycle = { status: "stopped", reason: optionsLocal.reason };
      retireTranscripts(entry);
      // A late callback from an old connection must not remove its replacement.
      if (this.params.sessions.get(guildId) === entry) {
        this.params.sessions.delete(guildId);
      }
      this.params.membership.deactivate(entry);
      connection.receiver.speaking.off("start", speakingHandler);
      connection.receiver.speaking.off("end", speakingEndHandler);
      stopVoiceCaptureState(entry.capture);
      connection.off(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
      connection.off(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
      player.off("error", playerErrorHandler);
      const realtimeLifecycle = entry.realtimeLifecycle;
      if (realtimeLifecycle.status === "starting" || realtimeLifecycle.status === "active") {
        realtimeLifecycle.instance.close();
      }
      entry.realtimeLifecycle = {
        status: "stopped",
        generation: realtimeLifecycle.generation,
        reason: optionsLocal.reason,
      };
      // Buffering resources cannot drain silence padding; terminal teardown must reach Idle now.
      player.stop(true);
      if (optionsLocal.destroyConnection) {
        destroyVoiceConnectionSafely({
          connection,
          voiceSdk,
          reason: optionsLocal.reason,
        });
      }
      this.params.onSessionStopped(entry, optionsLocal.reason);
    };

    const entry: VoiceSessionEntry = {
      generation: authority?.generation ?? 0,
      autoJoinWhenOccupied: options?.autoJoinWhenOccupied === true,
      sessionLifecycle: { status: "active" },
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
      audioInputBudget,
      ttsStreamFallbackWarned: false,
      capture: createVoiceCaptureState(),
      transcripts: options?.transcripts,
      receiveRecovery: createVoiceReceiveRecoveryState(),
      realtimeLifecycle: { status: "inactive", generation: 0 },
      stop(reason) {
        stopEntry({
          destroyConnection: true,
          reason: reason ?? `stop guild ${guildId} channel ${channelId}`,
        });
      },
    };

    const speakingHandler = (userId: string) => {
      void this.params.receive.handleSpeakingStart(entry, userId).catch((err: unknown) => {
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(err)}`);
      });
    };
    const speakingEndHandler = (userId: string) => {
      this.params.receive.scheduleCaptureFinalize(entry, userId, "speaker end");
    };

    const disconnectedHandler = () => {
      void (async () => {
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
          stopEntry({
            destroyConnection: true,
            reason: `disconnect recovery failed guild ${guildId} channel ${channelId}`,
          });
        }
      })();
    };
    const destroyedHandler = () => {
      stopEntry({
        destroyConnection: false,
        reason: `destroyed guild ${guildId} channel ${channelId}`,
      });
    };
    const playerErrorHandler = (err: Error) => {
      logger.warn(`discord voice: playback error: ${formatErrorMessage(err)}`);
    };

    // Realtime callbacks can stop playback during connect. Initialize teardown and
    // observe connection/player failure before startup, but admit capture only once ready.
    connection.on(voiceSdk.VoiceConnectionStatus.Disconnected, disconnectedHandler);
    connection.on(voiceSdk.VoiceConnectionStatus.Destroyed, destroyedHandler);
    player.on("error", playerErrorHandler);
    if (!options?.transcripts && isDiscordRealtimeVoiceMode(voiceMode)) {
      const realtimeResult = await this.attachRealtimeSession(entry, voiceMode, {
        isCurrent: authority?.isCurrent,
      });
      if (!realtimeResult.ok) {
        entry.stop(`realtime setup failed guild ${guildId} channel ${channelId}`);
        return {
          ok: false,
          message: realtimeResult.message,
          guildId,
          channelId,
        };
      }
    }
    if (
      isVoiceSessionStopped(entry) ||
      this.params.destroyed() ||
      (authority && !authority.isCurrent())
    ) {
      entry.stop(
        `${this.params.destroyed() ? "manager stopped" : "join cancelled"} during setup guild ${guildId} channel ${channelId}`,
      );
      return {
        ok: false,
        message: this.params.destroyed()
          ? "Discord voice manager is stopped."
          : "Discord voice join was cancelled.",
        guildId,
        channelId,
      };
    }

    this.params.receive.enableDaveReceivePassthrough(
      entry,
      "post-join warmup",
      DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS,
    );
    connection.receiver.speaking.on("start", speakingHandler);
    connection.receiver.speaking.on("end", speakingEndHandler);

    this.params.sessions.set(guildId, entry);
    this.params.membership.activate(entry, this.params.botUserId());
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

  async leave(
    params: { guildId: string; channelId?: string },
    options?: { preserveFollowState?: boolean; transcriptsSessionId?: string },
  ): Promise<VoiceOperationResult> {
    const guildId = params.guildId.trim();
    logVoiceVerbose(`leave requested: guild ${guildId} channel ${params.channelId ?? "current"}`);
    const entry = this.params.sessions.get(guildId);
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
      if (
        entry.realtimeLifecycle.status === "active" ||
        entry.realtimeLifecycle.status === "starting"
      ) {
        retireTranscripts(entry);
        return {
          ok: true,
          message: `Stopped transcripts for ${formatMention({ channelId: entry.channelId })}.`,
          guildId,
          channelId: entry.channelId,
        };
      }
    }
    entry.stop();
    if (!entry.receiveRecovery.decryptRecoveryInFlight) {
      this.params.receive.deleteRecoveryAttempt(guildId);
    }
    if (!options?.preserveFollowState) {
      this.params.onLeaveFollowState(guildId);
    }
    logVoiceVerbose(`leave: disconnected from guild ${guildId} channel ${entry.channelId}`);
    return {
      ok: true,
      message: `Left ${formatMention({ channelId: entry.channelId })}.`,
      guildId,
      channelId: entry.channelId,
    };
  }

  private async attachRealtimeSession(
    entry: VoiceSessionEntry,
    voiceMode: Exclude<DiscordVoiceMode, "stt-tts">,
    options?: { requireLiveEntry?: boolean; isCurrent?: () => boolean },
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const bootstrapContextInstructions = await resolveDiscordVoiceRealtimeBootstrapContext({
      entry,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
    });
    if (
      entry.sessionLifecycle.status === "stopped" ||
      options?.isCurrent?.() === false ||
      (options?.requireLiveEntry === true && this.params.sessions.get(entry.guildId) !== entry)
    ) {
      return {
        ok: false,
        message: "Discord realtime voice session stopped before startup completed.",
      };
    }
    const { DiscordRealtimeVoiceSession } = await import("./realtime-session.runtime.js");
    const realtime = new DiscordRealtimeVoiceSession({
      accountId: this.params.accountId,
      bootstrapContextInstructions,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      entry,
      getHumanParticipantCount: () =>
        this.params.membership.countHumanParticipants(entry, this.params.botUserId()),
      mode: voiceMode,
      onTerminalError: (error) => {
        logger.error(
          `discord voice: realtime session failed terminally guild=${entry.guildId} channel=${entry.channelId}: ${formatErrorMessage(error)}`,
        );
        entry.stop("realtime terminal error");
      },
      runAgentTurn: ({ context, message, toolsAllow, userId }) =>
        this.params.receive.runDiscordRealtimeAgentTurn({
          context,
          entry,
          message,
          toolsAllow,
          userId,
        }),
    });
    const generation = entry.realtimeLifecycle.generation + 1;
    entry.realtimeLifecycle = { status: "starting", generation, instance: realtime };
    try {
      await realtime.connect();
      if (
        entry.realtimeLifecycle.status !== "starting" ||
        entry.realtimeLifecycle.generation !== generation ||
        entry.realtimeLifecycle.instance !== realtime ||
        isVoiceSessionStopped(entry) ||
        options?.isCurrent?.() === false ||
        (options?.requireLiveEntry === true && this.params.sessions.get(entry.guildId) !== entry)
      ) {
        realtime.close();
        return {
          ok: false,
          message: "Discord realtime voice session stopped before startup completed.",
        };
      }
      entry.realtimeLifecycle = { status: "active", generation, instance: realtime };
      return { ok: true };
    } catch (err) {
      realtime.close();
      if (
        entry.realtimeLifecycle.status === "starting" &&
        entry.realtimeLifecycle.generation === generation
      ) {
        entry.realtimeLifecycle = {
          status: "stopped",
          generation,
          reason: "connect failed",
        };
      }
      return {
        ok: false,
        message: `Failed to start Discord realtime voice: ${formatErrorMessage(err)}`,
      };
    }
  }
}
