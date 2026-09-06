import { PassThrough } from "node:stream";
import type { OpenClawConfig, DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { Client } from "../internal/discord.js";
import { decodeOpusStreamChunks } from "./audio.js";
import {
  beginVoiceCapture,
  clearVoiceCaptureFinalizeTimer,
  finishVoiceCapture,
  scheduleVoiceCaptureFinalize,
  waitForVoiceCaptureAdmission,
} from "./capture-state.js";
import {
  type DiscordVoiceIngressContext,
  runDiscordVoiceAgentTurn,
  resolveDiscordVoiceIngressContext,
} from "./ingress.js";
import { formatVoiceLogPreview } from "./log-preview.js";
import type { DiscordVoiceMembershipTracker } from "./membership.js";
import { resolveDiscordVoiceIngressContextWithParticipants } from "./participant-context.js";
import { DiscordRealtimeRecordingInput } from "./realtime-recording.js";
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
import type { DiscordVoiceAudioReceipt } from "./recording-types.js";
import { loadDiscordVoiceSdk } from "./sdk-runtime.js";
import { respondToDiscordVoiceTranscript } from "./segment.js";
import {
  CAPTURE_FINALIZE_GRACE_MS,
  logVoiceVerbose,
  MIN_SEGMENT_SECONDS,
  resolveVoiceTimeoutMs,
  type VoiceOperationResult,
  type VoiceJoinOptions,
  type VoiceSessionEntry,
} from "./session.js";
import type { DiscordVoiceSpeakerContextResolver } from "./speaker-context.js";
import { DiscordVoiceRecording } from "./voice-recording.js";

const logger = createSubsystemLogger("discord/voice");
// UDP cannot apply backpressure; bound pending packets as well as their encoded bytes.
const MAX_PENDING_OPUS_PACKETS = 1_000;
const MAX_PENDING_OPUS_BYTES = 1024 * 1024;

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
        options?: VoiceJoinOptions,
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

  async handleSpeakingStart(
    entry: VoiceSessionEntry,
    userId: string,
    origin: "native" | "scan" = "native",
  ): Promise<void> {
    if (!userId || !this.params.isEntryCurrent(entry)) {
      return;
    }

    if (userId === this.params.botUserId()) {
      return;
    }
    this.params.membership.notePresent(entry, userId);
    const activeCapture = entry.capture.get(userId);
    if (activeCapture) {
      const extended = clearVoiceCaptureFinalizeTimer(activeCapture);
      if (entry.transcripts?.isCurrent()) {
        activeCapture.startRecording?.();
      }
      logVoiceVerbose(
        `capture start ignored (already active): guild ${entry.guildId} channel ${entry.channelId} user ${userId}${extended ? " (finalize canceled)" : ""}`,
      );
      return;
    }

    const capture = entry.transcripts;
    const realtime =
      entry.realtimeLifecycle.status === "active" ? entry.realtimeLifecycle.instance : undefined;
    const playing = entry.player.state.status === loadDiscordVoiceSdk().AudioPlayerStatus.Playing;
    // Scans cannot recover unsubscribed packets. Only a native start may admit
    // conversation for a new receive stream; already-owned streams keep their admission.
    const conversationAllowed =
      origin === "native" && !entry.captureOnly && !(playing && !realtime?.isBargeInEnabled());
    if (!capture && !conversationAllowed) {
      logVoiceVerbose(
        `capture ignored: guild ${entry.guildId} channel ${entry.channelId} user ${userId} reason=${playing ? "protected playback" : "inactive capture"}`,
      );
      return;
    }
    // A recorder can promote this reservation while native conversation admission
    // waits, without repeating admission or subscribing before either authority exists.
    const reservation = beginVoiceCapture(entry.capture, userId);
    try {
      let realtimeIngress: Promise<DiscordVoiceIngressContext | null> | undefined;
      if (realtime && !capture) {
        realtimeIngress = this.resolveDiscordVoiceIngressContext(entry, userId);
        const admitted = await waitForVoiceCaptureAdmission({
          capture: reservation,
          conversationAuthorized: realtimeIngress.then((context) => context !== null),
          isRecordingCurrent: () => entry.transcripts?.isCurrent() === true,
        });
        if (!admitted) {
          logVoiceVerbose(
            `realtime capture unauthorized: guild ${entry.guildId} channel ${entry.channelId} user ${userId}`,
          );
          return;
        }
      }
      if (!this.params.isEntryCurrent(entry) || entry.capture.get(userId) !== reservation) {
        return;
      }
      await this.receiveSpeaker(entry, userId, reservation, conversationAllowed, realtimeIngress);
    } finally {
      const stream = reservation.stream;
      const finishedActiveCapture = finishVoiceCapture(entry.capture, userId, reservation);
      if (finishedActiveCapture && stream && !stream.destroyed) {
        stream.destroy();
      }
    }
  }

  captureCurrentSpeakers(entry: VoiceSessionEntry): void {
    for (const userId of entry.connection.receiver.speaking.users.keys()) {
      void this.handleSpeakingStart(entry, userId, "scan").catch((error: unknown) =>
        logger.warn(`discord voice: capture failed: ${formatErrorMessage(error)}`),
      );
    }
  }

  private responseContext(entry: VoiceSessionEntry, userId: string) {
    return {
      entry,
      userId,
      accountId: this.params.accountId,
      cfg: this.params.cfg,
      discordConfig: this.params.discordConfig,
      admissionAllowFrom: this.params.admissionAllowFrom,
      runtime: this.params.runtime,
      speakerContext: this.params.speakerContext,
      fetchGuildName: async (guildId: string) => {
        const guild = await this.params.client.fetchGuild(guildId).catch(() => null);
        return guild && typeof guild.name === "string" && guild.name.trim()
          ? guild.name
          : undefined;
      },
      enqueuePlayback: (playbackEntry: VoiceSessionEntry, task: () => Promise<void>) => {
        playbackEntry.playbackQueue = playbackEntry.playbackQueue
          .then(task)
          .catch((err: unknown) =>
            logger.warn(`discord voice: playback failed: ${formatErrorMessage(err)}`),
          );
      },
    };
  }

  private async receiveSpeaker(
    entry: VoiceSessionEntry,
    userId: string,
    reservation: ReturnType<typeof beginVoiceCapture>,
    conversationAllowed: boolean,
    admittedIngress?: Promise<DiscordVoiceIngressContext | null>,
  ): Promise<void> {
    const voiceSdk = loadDiscordVoiceSdk();
    const realtime =
      entry.realtimeLifecycle.status === "active" ? entry.realtimeLifecycle.instance : undefined;
    const protectedPlayback = () =>
      entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing &&
      !realtime?.isBargeInEnabled();
    this.enableDaveReceivePassthrough(
      entry,
      `speaker ${userId} start`,
      DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS,
    );
    const stream = (reservation.stream = entry.connection.receiver.subscribe(userId, {
      end: { behavior: voiceSdk.EndBehaviorType.Manual },
    }));
    if (!entry.audioInputBudget.enabled && !realtime) {
      logger.warn(
        "discord voice: capture skipped: audio understanding is disabled; enable tools.media.audio.enabled to transcribe voice.",
      );
      return;
    }
    // Reserve packets before identity/decoder awaits. Normal socket close ends this owned input
    // without destroying packets already received under the source subscription.
    const input = new PassThrough({ objectMode: true });
    const receipts = new WeakMap<Buffer, DiscordVoiceAudioReceipt>();
    let failed = false;
    let pendingPackets = 0;
    let pendingBytes = 0;
    const acceptPacket = (packet: Buffer) => {
      if (
        failed ||
        !packet.length ||
        !this.params.isEntryCurrent(entry) ||
        entry.capture.get(userId) !== reservation
      ) {
        return;
      }
      const capture = entry.transcripts;
      if (!capture && !conversationAllowed) {
        return;
      }
      if (
        pendingPackets >= MAX_PENDING_OPUS_PACKETS ||
        packet.length > MAX_PENDING_OPUS_BYTES - pendingBytes
      ) {
        onError(new Error("Discord voice receive backlog exceeded; try speaking again."));
        finishVoiceCapture(entry.capture, userId, reservation);
        input.destroy();
        stream.destroy();
        return;
      }
      pendingPackets += 1;
      pendingBytes += packet.length;
      const receivedPacket = Buffer.from(packet);
      receipts.set(receivedPacket, { capture, startedAt: Date.now() });
      input.write(receivedPacket);
    };
    const endInput = () => input.end();
    let aborted = false;
    let resetReceiveRecovery = false;
    const onError = (error: unknown) => {
      const analysis = analyzeVoiceReceiveError(error);
      if (analysis.isAbortLike && !analysis.countsAsDecryptFailure) {
        if (!aborted) {
          aborted = true;
          this.handleReceiveError(entry, error);
        }
        return;
      }
      if (failed) {
        return;
      }
      failed = true;
      conversation?.retire();
      this.handleReceiveError(entry, error);
    };
    stream.on("data", acceptPacket);
    stream.on("end", endInput);
    stream.on("close", endInput);
    stream.on("error", onError);
    const realtimeRecording = realtime
      ? new DiscordRealtimeRecordingInput(!entry.audioInputBudget.enabled)
      : undefined;
    const conversation = conversationAllowed
      ? entry.conversations.start({
          authorize: () =>
            admittedIngress ??
            (realtime
              ? this.resolveDiscordVoiceIngressContext(entry, userId)
              : resolveDiscordVoiceIngressContext(this.responseContext(entry, userId))),
          isCurrent: () => this.params.isEntryCurrent(entry),
          canAdmit: () => !protectedPlayback(),
          createTurn: realtime
            ? (context) => {
                if (entry.player.state.status === voiceSdk.AudioPlayerStatus.Playing) {
                  realtime.handleBargeIn("speaker-start");
                }
                return realtime.beginSpeakerTurn(context, userId, realtimeRecording);
              }
            : undefined,
          warn: (message) => logger.warn(message),
        })
      : undefined;
    const recording = new DiscordVoiceRecording({
      entry,
      cfg: this.params.cfg,
      userId,
      isInputComplete: () => !failed,
      minimumSeconds: () => (aborted ? 0.2 : MIN_SEGMENT_SECONDS),
      canConverse: () => !realtime && conversation?.ingress != null,
      resolveIngressContext: async () => {
        if (realtime || !conversation) {
          return null;
        }
        return await conversation.authorizeSegment(() =>
          resolveDiscordVoiceIngressContext(this.responseContext(entry, userId)),
        );
      },
      resolveSpeaker: () => this.params.speakerContext.resolveIdentity(entry.guildId, userId),
      onSegment: (outcome) => {
        realtimeRecording?.observeBatch(outcome);
        if (!realtime) {
          conversation?.addSegment(outcome);
        }
      },
      onExcluded: () => {
        if (entry.audioInputBudget.enabled) {
          realtimeRecording?.exclude();
        }
        if (!realtime) {
          conversation?.retire();
        }
      },
    });
    let conversationCompletion: Promise<void> | undefined;
    try {
      if (!conversation && !entry.transcripts?.isCurrent()) {
        return;
      }
      await decodeOpusStreamChunks(input, {
        onChunk: async (pcm, packet) => {
          const receipt = receipts.get(packet);
          if (!receipt || failed) {
            return;
          }
          pendingPackets -= 1;
          pendingBytes -= packet.length;
          receipts.delete(packet);
          // Recovery counters are shared by speakers. Later healthy packets must not
          // erase another speaker's failures after this stream's first successful decode.
          if (!resetReceiveRecovery && pcm.length > 0) {
            resetReceiveRecovery = true;
            this.resetDecryptFailureState(entry);
          }
          if (!receipt.capture && conversation && !conversation.ingress) {
            const admitted = await waitForVoiceCaptureAdmission({
              capture: reservation,
              conversationAuthorized: conversation.ready.then(() => conversation.ingress !== null),
              isRecordingCurrent: () => entry.transcripts?.isCurrent() === true,
            });
            if (!admitted) {
              finishVoiceCapture(entry.capture, userId, reservation);
              stream.destroy();
              return;
            }
          }
          if (failed) {
            return;
          }
          realtimeRecording?.noteReceipt(receipt);
          conversation?.sendAudio(pcm, receipt);
          await recording.append(pcm, receipt);
        },
        onError,
        onVerbose: logVoiceVerbose,
        onWarn: (message) => logger.warn(message),
      });
      await recording.finish();
      // Conversation completion no longer owns this speaker's receive reservation.
      finishVoiceCapture(entry.capture, userId, reservation);
      stream.destroy();
      if (conversation) {
        if (realtime) {
          conversationCompletion = entry.conversations.finishAudio(conversation);
        } else if (!failed) {
          const recordingComplete = recording.completion;
          conversationCompletion = entry.conversations
            .enqueue(conversation, async () => {
              await recordingComplete;
              const transcript = await conversation.transcript();
              if (!transcript || !this.params.isEntryCurrent(entry)) {
                return;
              }
              const currentIngress = await this.resolveDiscordVoiceIngressContext(entry, userId);
              if (!currentIngress || !this.params.isEntryCurrent(entry)) {
                return;
              }
              await respondToDiscordVoiceTranscript({
                ...this.responseContext(entry, userId),
                ingress: currentIngress,
                transcript,
              });
            })
            .catch((error: unknown) =>
              logger.warn(`discord voice: processing failed: ${formatErrorMessage(error)}`),
            );
        }
      }
    } finally {
      realtimeRecording?.sealBatch();
      if (conversationCompletion) {
        void conversationCompletion.catch((error: unknown) =>
          logger.warn(`discord voice: conversation failed: ${formatErrorMessage(error)}`),
        );
      } else if (conversation) {
        entry.conversations.release(conversation);
      }
      stream.off("data", acceptPacket);
      stream.off("end", endInput);
      stream.off("close", endInput);
      stream.off("error", onError);
      input.destroy();
    }
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
      {
        preserveFollowState,
        autoJoinWhenOccupied: entry.autoJoinWhenOccupied,
        captureOnly: entry.captureOnly,
      },
    );
    if (!result.ok) {
      logger.warn(`discord voice: rejoin after decrypt failures failed: ${result.message}`);
    }
  }
}
