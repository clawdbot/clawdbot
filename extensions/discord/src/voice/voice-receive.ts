import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import { decodeOpusStream, decodeOpusStreamChunks, writeVoiceWavFile } from "./audio.js";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  finishVoiceCapture,
  getActiveVoiceCapture,
  isVoiceCaptureActive,
  scheduleVoiceCaptureFinalize,
} from "./capture-state.js";
import { type DiscordVoiceIngressContext, runDiscordVoiceAgentTurn } from "./ingress.js";
import { formatVoiceLogPreview } from "./log-preview.js";
import type { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceIngressContextWithParticipants } from "./participant-context.js";
import {
  analyzeVoiceReceiveError,
  DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
  DECRYPT_FAILURE_WINDOW_MS,
  enableDaveReceivePassthrough as tryEnableDaveReceivePassthrough,
  finishVoiceDecryptRecovery,
  noteVoiceDecryptFailure,
  recoverDaveZeroTransition as tryRecoverDaveZeroTransition,
  resetVoiceReceiveRecoveryState,
} from "./receive-recovery.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { processDiscordVoiceSegment } from "./segment.js";
import {
  CAPTURE_FINALIZE_GRACE_MS,
  isDiscordRealtimeVoiceMode,
  logVoiceVerbose,
  MIN_SEGMENT_SECONDS,
  resolveDiscordVoiceMode,
  resolveVoiceTimeoutMs,
  type VoiceOperationResult,
  type VoiceRealtimeSpeakerTurn,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";

const logger = createSubsystemLogger("discord/voice");

export class DiscordVoiceReceive {
  readonly daveRecoveryAttempts = new Map<string, number>();

  constructor(
    private readonly params: {
      accountId: string;
      admissionAllowFrom?: string[];
      botUserId: () => string | undefined;
      cfg: OpenClawConfig;
      client: Client;
      discordConfig: DiscordAccountConfig;
      getSession: (guildId: string) => VoiceSessionEntry | undefined;
      isEntryCurrent: (entry: VoiceSessionEntry) => boolean;
      isFollowOwnedGuild: (guildId: string) => boolean;
      join: (
        params: { guildId: string; channelId: string },
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      leave: (
        params: { guildId: string },
        options?: { preserveFollowState?: boolean },
      ) => Promise<VoiceOperationResult>;
      membership: DiscordVoiceMembershipTracker;
      runtime: RuntimeEnv;
      speakerContext: DiscordVoiceSpeakerContextResolver;
    },
  ) {}

  getRecoveryAttempt(guildId: string): number | undefined {
    return this.daveRecoveryAttempts.get(guildId);
  }

  deleteRecoveryAttempt(guildId: string): void {
    this.daveRecoveryAttempts.delete(guildId);
  }

  clearRecoveryAttempts(): void {
    this.daveRecoveryAttempts.clear();
  }

  scheduleCaptureFinalize(entry: VoiceSessionEntry, userId: string, reason: string): void {
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

  async handleSpeakingStart(entry: VoiceSessionEntry, userId: string): Promise<void> {
    if (!userId) {
      return;
    }
    const botUserId = this.params.botUserId();
    if (botUserId && userId === botUserId) {
      return;
    }
    this.params.membership.notePresent(entry, userId);
    if (isVoiceCaptureActive(entry.capture, userId)) {
      const activeCapture = getActiveVoiceCapture(entry.capture, userId);
      const extended = activeCapture
        ? clearVoiceCaptureFinalizeTimer(entry.capture, userId, activeCapture.generation)
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
      entry.realtimeLifecycle.status === "active" && isDiscordRealtimeVoiceMode(voiceMode)
        ? entry.realtimeLifecycle.instance
        : undefined;
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
    if (!this.params.isEntryCurrent(entry)) {
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
      if (!this.params.isEntryCurrent(entry)) {
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
      if (!this.params.isEntryCurrent(entry)) {
        return;
      }
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
      entry.processingQueue = entry.processingQueue
        .then(async () => {
          if (!this.params.isEntryCurrent(entry)) {
            return;
          }
          await this.processSegment({ entry, wavPath, userId, durationSeconds });
        })
        .catch((err: unknown) =>
          logger.warn(`discord voice: processing failed: ${formatErrorMessage(err)}`),
        );
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

  async processSegment(params: {
    entry: VoiceSessionEntry;
    wavPath: string;
    userId: string;
    durationSeconds: number;
  }): Promise<void> {
    await processDiscordVoiceSegment({
      ...params,
      accountId: this.params.accountId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      runtime: this.params.runtime,
      speakerContext: this.params.speakerContext,
      resolveIngressContext: () =>
        this.resolveDiscordVoiceIngressContext(params.entry, params.userId),
      transcripts: params.entry.transcripts,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      enqueuePlayback: (entry, task) => {
        entry.playbackQueue = entry.playbackQueue
          .then(task)
          .catch((err: unknown) =>
            logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`),
          );
      },
    });
  }

  handleReceiveError(entry: VoiceSessionEntry, err: unknown): void {
    const analysis = analyzeVoiceReceiveError(err);
    if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive stream ended: ${analysis.message}`);
      return;
    }
    if (analysis.isDecodeCorruption && !analysis.countsAsDecryptFailure) {
      logVoiceVerbose(`receive decode skipped: ${analysis.message}`);
      return;
    }
    logger.warn(`discord voice: receive error: ${analysis.message}`);
    if (analysis.shouldAttemptPassthrough) {
      if (this.params.isEntryCurrent(entry)) {
        const recovery = tryRecoverDaveZeroTransition({
          target: entry,
          sdk: loadDiscordVoiceSdk(),
          onWarn: (message) => logger.warn(message),
        });
        if (recovery === "failed") {
          this.startDecryptRecovery(entry, true);
          return;
        }
      }
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
    this.startDecryptRecovery(entry);
  }

  enableDaveReceivePassthrough(
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

  private async processRealtimeAudioCapture(params: {
    entry: VoiceSessionEntry;
    onReceiveError: (err: unknown) => void;
    stream: import("node:stream").Readable;
    turn: VoiceRealtimeSpeakerTurn;
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
    return await resolveDiscordVoiceIngressContextWithParticipants({
      client: this.params.client,
      entry,
      userId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      botUserId: this.params.botUserId(),
      speakerContext: this.params.speakerContext,
    });
  }

  async runDiscordRealtimeAgentTurn(params: {
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
      accountId: this.params.accountId,
      userId,
      message,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      runtime: this.params.runtime,
      context,
      toolsAllow,
      admissionAllowFrom: this.params.admissionAllowFrom,
      fetchGuildName: async (guildId) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      speakerContext: this.params.speakerContext,
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

  private startDecryptRecovery(entry: VoiceSessionEntry, force = false): void {
    let recovery: Promise<unknown>;
    if (force) {
      if (
        this.params.getSession(entry.guildId) !== entry ||
        entry.sessionLifecycle.status === "stopped" ||
        entry.receiveRecovery.decryptRecoveryInFlight
      ) {
        return;
      }
      const now = Date.now();
      for (const [guildId, attemptedAt] of this.daveRecoveryAttempts) {
        if (now - attemptedAt >= DECRYPT_FAILURE_WINDOW_MS) {
          this.daveRecoveryAttempts.delete(guildId);
        }
      }
      resetVoiceReceiveRecoveryState(entry.receiveRecovery);
      entry.receiveRecovery.decryptRecoveryInFlight = true;
      if (this.daveRecoveryAttempts.has(entry.guildId)) {
        const windowSeconds = DECRYPT_FAILURE_WINDOW_MS / 1_000;
        logger.warn(
          `discord voice: DAVE recovery failed again within ${windowSeconds} seconds; disconnecting guild=${entry.guildId} channel=${entry.channelId} to avoid a reconnect loop; retry /vc join after the voice gateway recovers`,
        );
        recovery = this.params.leave(
          { guildId: entry.guildId },
          { preserveFollowState: this.params.isFollowOwnedGuild(entry.guildId) },
        );
      } else {
        // A partially invalidated DAVE session suppresses all later decrypt failures.
        this.daveRecoveryAttempts.set(entry.guildId, now);
        recovery = this.recoverFromDecryptFailures(entry);
      }
    } else {
      recovery = this.recoverFromDecryptFailures(entry);
    }
    void recovery
      .catch((recoverErr: unknown) =>
        logger.warn(`discord voice: decrypt recovery failed: ${formatErrorMessage(recoverErr)}`),
      )
      .finally(() => {
        finishVoiceDecryptRecovery(entry.receiveRecovery);
      });
  }

  private resetDecryptFailureState(entry: VoiceSessionEntry): void {
    resetVoiceReceiveRecoveryState(entry.receiveRecovery);
    if (this.params.isEntryCurrent(entry)) {
      this.daveRecoveryAttempts.delete(entry.guildId);
    }
  }

  private async recoverFromDecryptFailures(entry: VoiceSessionEntry): Promise<void> {
    const active = this.params.getSession(entry.guildId);
    if (!active || active.connection !== entry.connection) {
      return;
    }
    const preserveFollowState = this.params.isFollowOwnedGuild(entry.guildId);
    logger.warn(
      `discord voice: repeated decrypt failures; attempting rejoin for guild ${entry.guildId} channel ${entry.channelId}`,
    );
    const leaveResult = await this.params.leave(
      { guildId: entry.guildId },
      { preserveFollowState },
    );
    if (!leaveResult.ok) {
      logger.warn(`discord voice: decrypt recovery leave failed: ${leaveResult.message}`);
      return;
    }
    const result = await this.params.join(
      { guildId: entry.guildId, channelId: entry.channelId },
      { preserveFollowState },
    );
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }
}
