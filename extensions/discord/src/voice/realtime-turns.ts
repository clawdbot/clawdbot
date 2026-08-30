import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  createRealtimeVoiceTurnContextTracker,
  isRealtimeVoiceWakeNameRequired,
  matchRealtimeVoiceActivationName,
  type RealtimeVoiceActivationNameTranscriptResult,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceTurnContextHandle,
  type RealtimeVoiceTurnContextTracker,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { convertDiscordPcm48kStereoToRealtimePcm24kMono } from "./audio.js";
import type { DiscordRealtimePlaybackPort } from "./realtime-playback.js";
import { mergeRealtimePartialTranscript } from "./realtime-transcript.js";
import type {
  VoiceRealtimeSpeakerContext,
  VoiceRealtimeSpeakerTurn,
  VoiceSessionEntry,
} from "./session.js";
import { logVoiceVerbose } from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT = 32;
const DISCORD_REALTIME_IGNORED_WAKE_NAME_CONTEXT_TTL_MS = 10_000;
const DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 10_000;
const REALTIME_PCM16_BYTES_PER_SAMPLE = 2;
const DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS = 700;
const DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS = 3_000;

export type DiscordRealtimeSpeakerContext = VoiceRealtimeSpeakerContext & { userId: string };

type PendingSpeakerTurnStats = {
  // Final text keeps the audio turn's subscription across capture replacement.
  transcripts: VoiceSessionEntry["transcripts"];
  inputDiscordBytes: number;
  inputRealtimeBytes: number;
  inputChunks: number;
  interruptedPlayback: boolean;
};

type PendingSpeakerTurn = RealtimeVoiceTurnContextHandle<
  DiscordRealtimeSpeakerContext,
  PendingSpeakerTurnStats
>;

type TranscriptUtteranceAttribution = {
  transcripts: VoiceSessionEntry["transcripts"];
  context: DiscordRealtimeSpeakerContext;
  startedAt: number;
};

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

export class DiscordRealtimeTurns {
  private readonly speakerTurns: RealtimeVoiceTurnContextTracker<
    DiscordRealtimeSpeakerContext,
    PendingSpeakerTurnStats
  > = createRealtimeVoiceTurnContextTracker<DiscordRealtimeSpeakerContext, PendingSpeakerTurnStats>(
    {
      limit: DISCORD_REALTIME_PENDING_SPEAKER_CONTEXT_LIMIT,
      ignoredContextTtlMs: DISCORD_REALTIME_IGNORED_WAKE_NAME_CONTEXT_TTL_MS,
      deferUntilAudio: true,
    },
  );
  private partialUserTranscript = "";
  private wakeNameAckedForTurn = false;
  private pendingWakeNameFollowup:
    | {
        context: DiscordRealtimeSpeakerContext;
        startedAt: number;
        expiresAt: number;
        transcripts: VoiceSessionEntry["transcripts"];
      }
    | undefined;

  constructor(
    private readonly params: {
      bridge: () => RealtimeVoiceBridgeSession | null;
      entry: VoiceSessionEntry;
      getHumanParticipantCount: () => number;
      onAcceptedTranscript: (
        text: string,
        speakerContext: DiscordRealtimeSpeakerContext | undefined,
        providerEpoch: number,
      ) => Promise<void>;
      playback: DiscordRealtimePlaybackPort;
      providerEpoch: () => number;
      providerId: () => string | undefined;
      realtimeConfig: () => DiscordRealtimeVoiceConfig;
      recordInputAudio: (audio: Buffer) => boolean;
      stopped: () => boolean;
      wakeNamePolicy: () => RealtimeVoiceWakeNamePolicy;
      wakeNames: () => string[];
    },
  ) {}

  beginSpeakerTurn(context: VoiceRealtimeSpeakerContext, userId: string): VoiceRealtimeSpeakerTurn {
    this.resetPartialWakeNameTracking();
    const turn = this.speakerTurns.open(
      { ...context, userId },
      {
        transcripts: this.params.entry.transcripts,
        inputDiscordBytes: 0,
        inputRealtimeBytes: 0,
        inputChunks: 0,
        interruptedPlayback: false,
      },
    );
    return {
      sendInputAudio: (discordPcm48kStereo) =>
        this.sendInputAudioForTurn(turn, discordPcm48kStereo),
      close: () => {
        this.sendRealtimeTrailingSilenceForTurn(turn);
        this.logSpeakerTurnClosed(turn);
        this.speakerTurns.close(turn);
      },
    };
  }

  handlePartialUserTranscript(text: string): void {
    if (!this.isWakeNameRequired() || this.wakeNameAckedForTurn) {
      return;
    }
    this.partialUserTranscript = mergeRealtimePartialTranscript(this.partialUserTranscript, text);
    const wakeNameResult = matchRealtimeVoiceActivationName(
      this.partialUserTranscript,
      this.params.wakeNames(),
    );
    if (!wakeNameResult || wakeNameResult.edge !== "leading") {
      return;
    }
    this.wakeNameAckedForTurn = true;
    this.params.playback.sendWakeNameAck(wakeNameResult);
  }

  async handleFinalUserTranscript(text: string): Promise<void> {
    const providerEpoch = this.params.providerEpoch();
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    this.partialUserTranscript = "";
    const transcriptsTurn = this.peekPendingSpeakerTurn();
    let transcriptAttribution = this.transcriptAttributionFromTurn(transcriptsTurn);
    const humanParticipantCount = this.params.getHumanParticipantCount();
    const requireWakeName = this.isWakeNameRequired(humanParticipantCount);
    const wakeNameResult = this.resolveWakeNameTranscript(trimmed, requireWakeName);
    let forcedSpeakerContext: DiscordRealtimeSpeakerContext | undefined;
    if (!wakeNameResult.allowed) {
      const pendingWakeNameFollowup = this.consumePendingWakeNameFollowup();
      transcriptAttribution ??= pendingWakeNameFollowup;
      if (!pendingWakeNameFollowup) {
        this.recordTranscriptUtterance(trimmed, transcriptAttribution, providerEpoch);
        this.rememberIgnoredWakeNameSpeakerContext(this.consumePendingSpeakerContext());
        logger.info(
          `discord voice: realtime wake-name gate ignored transcript chars=${trimmed.length} humanParticipants=${humanParticipantCount} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId} wakeNames=${this.params.wakeNames().join(",") || "none"}`,
        );
        return;
      }
      forcedSpeakerContext = pendingWakeNameFollowup.context;
      logger.info(
        `discord voice: realtime wake-name follow-up accepted chars=${trimmed.length} speaker=${forcedSpeakerContext.speakerLabel} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
    }
    this.recordTranscriptUtterance(trimmed, transcriptAttribution, providerEpoch);
    const acceptedText = wakeNameResult.allowed ? wakeNameResult.text || trimmed : trimmed;
    if (wakeNameResult.allowed && !wakeNameResult.text.trim()) {
      this.armWakeNameFollowup();
      return;
    }
    if (wakeNameResult.allowed) {
      this.pendingWakeNameFollowup = undefined;
    }
    await this.params.onAcceptedTranscript(acceptedText, forcedSpeakerContext, providerEpoch);
  }

  resetPartialWakeNameTracking(): void {
    this.partialUserTranscript = "";
    this.wakeNameAckedForTurn = false;
  }

  resetProviderContinuity(): void {
    this.partialUserTranscript = "";
    this.pendingWakeNameFollowup = undefined;
  }

  clear(): void {
    this.speakerTurns.clear();
    this.resetPartialWakeNameTracking();
    this.pendingWakeNameFollowup = undefined;
  }

  consumePendingSpeakerContext(): DiscordRealtimeSpeakerContext | undefined {
    return this.speakerTurns.consumeAudioContext();
  }

  consumeRecentIgnoredWakeNameSpeakerContext(): DiscordRealtimeSpeakerContext | undefined {
    return this.speakerTurns.consumeIgnoredContext();
  }

  peekPendingSpeakerTurn(): PendingSpeakerTurn | undefined {
    return this.speakerTurns.peekAudioTurn();
  }

  hasPendingSpeakerAudioContext(): boolean {
    return this.speakerTurns.hasAudioContext();
  }

  private sendInputAudioForTurn(turn: PendingSpeakerTurn, discordPcm48kStereo: Buffer): void {
    const bridge = this.params.bridge();
    if (!bridge || this.params.stopped()) {
      return;
    }
    const realtimePcm = convertDiscordPcm48kStereoToRealtimePcm24kMono(discordPcm48kStereo);
    if (realtimePcm.length > 0) {
      this.registerSpeakerTurnAudioStarted(turn);
      turn.inputDiscordBytes += discordPcm48kStereo.length;
      turn.inputRealtimeBytes += realtimePcm.length;
      turn.inputChunks += 1;
      if (turn.inputChunks === 1) {
        logger.info(
          `discord voice: realtime input audio started guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length} outputAudioMs=${this.params.playback.outputAudioMs()} outputActive=${this.params.playback.isOutputAudioActive()}`,
        );
      }
      const outputActive = this.params.playback.hasInterruptibleOutputAudio();
      if (!turn.interruptedPlayback && this.params.playback.isBargeInEnabled() && outputActive) {
        turn.interruptedPlayback = true;
        logVoiceVerbose(
          `realtime barge-in from active speaker audio: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} user ${turn.context.userId}`,
        );
        logger.info(
          `discord voice: realtime barge-in detected source=active-speaker-audio guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} outputAudioMs=${this.params.playback.outputAudioMs()} outputActive=${this.params.playback.isOutputAudioActive()} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length}`,
        );
        this.params.playback.handleBargeIn("active-speaker-audio");
      }
      if (this.params.recordInputAudio(realtimePcm)) {
        bridge.sendAudio(realtimePcm);
      }
    }
  }

  private registerSpeakerTurnAudioStarted(turn: PendingSpeakerTurn): void {
    if (turn.hasAudio) {
      return;
    }
    this.speakerTurns.markAudio(turn);
    logger.info(
      `discord voice: realtime speaker turn opened guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner} pendingTurns=${this.speakerTurns.size()}`,
    );
  }

  private logSpeakerTurnClosed(turn: PendingSpeakerTurn): void {
    if (turn.closed || !turn.hasAudio) {
      return;
    }
    const elapsedMs = Date.now() - turn.startedAt;
    const sinceLastAudioMs = turn.lastAudioAt ? Date.now() - turn.lastAudioAt : undefined;
    logger.info(
      `discord voice: realtime speaker turn closed guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner} hasAudio=${turn.hasAudio} chunks=${turn.inputChunks} discordBytes=${turn.inputDiscordBytes} realtimeBytes=${turn.inputRealtimeBytes} elapsedMs=${elapsedMs}${sinceLastAudioMs === undefined ? "" : ` sinceLastAudioMs=${sinceLastAudioMs}`} interruptedPlayback=${turn.interruptedPlayback}`,
    );
  }

  private sendRealtimeTrailingSilenceForTurn(turn: PendingSpeakerTurn): void {
    const bridge = this.params.bridge();
    if (!bridge || this.params.stopped() || turn.closed || !turn.hasAudio) {
      return;
    }
    const providerId =
      this.params.providerId() ?? this.params.realtimeConfig()?.provider ?? "openai";
    const providerConfig = this.params.realtimeConfig()?.providers?.[providerId];
    const rawSilenceDurationMs = providerConfig?.silenceDurationMs;
    const configuredSilenceDurationMs =
      typeof rawSilenceDurationMs === "number" && Number.isFinite(rawSilenceDurationMs)
        ? rawSilenceDurationMs
        : 0;
    const silenceMs = Math.min(
      DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS,
      Math.max(DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS, configuredSilenceDurationMs),
    );
    const silenceBytes = Math.ceil((24_000 * silenceMs) / 1_000) * REALTIME_PCM16_BYTES_PER_SAMPLE;
    const silence = Buffer.alloc(silenceBytes);
    bridge.sendAudio(silence);
    logger.info(
      `discord voice: realtime trailing silence sent guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} silenceMs=${silenceMs} realtimeBytes=${silence.length}`,
    );
  }

  private resolveWakeNameTranscript(
    text: string,
    requireWakeName: boolean,
  ): RealtimeVoiceActivationNameTranscriptResult {
    if (!requireWakeName) {
      return {
        allowed: true,
        text,
        activationName: "",
        heardName: "",
        match: "exact",
        edge: "leading",
      };
    }
    const wakeNameResult = matchRealtimeVoiceActivationName(text, this.params.wakeNames());
    if (wakeNameResult) {
      logger.info(
        `discord voice: realtime wake-name gate matched canonical=${wakeNameResult.activationName} heard=${wakeNameResult.heardName} match=${wakeNameResult.match} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return wakeNameResult;
    }
    return { allowed: false, text };
  }

  private isWakeNameRequired(
    humanParticipantCount = this.params.getHumanParticipantCount(),
  ): boolean {
    return isRealtimeVoiceWakeNameRequired(this.params.wakeNamePolicy(), humanParticipantCount);
  }

  private transcriptAttributionFromTurn(
    turn: PendingSpeakerTurn | undefined,
  ): TranscriptUtteranceAttribution | undefined {
    return turn
      ? { context: turn.context, startedAt: turn.startedAt, transcripts: turn.transcripts }
      : undefined;
  }

  private recordTranscriptUtterance(
    text: string,
    attribution: TranscriptUtteranceAttribution | undefined,
    providerEpoch: number,
  ): void {
    const transcripts = attribution?.transcripts;
    if (!transcripts || !attribution || this.params.entry.transcripts !== transcripts) {
      return;
    }
    const context = attribution.context;
    const utterance = {
      sessionId: transcripts.sessionId,
      startedAt: new Date(attribution.startedAt).toISOString(),
      final: true,
      speaker: { id: context.userId, label: context.speakerLabel },
      text,
      metadata: {
        channel: "discord",
        guildId: this.params.entry.guildId,
        channelId: this.params.entry.channelId,
        voiceSessionKey: this.params.entry.voiceSessionKey,
      },
    };
    void Promise.resolve()
      .then(() => {
        if (
          providerEpoch !== this.params.providerEpoch() ||
          this.params.entry.transcripts !== transcripts
        ) {
          return;
        }
        return transcripts.onUtterance(utterance);
      })
      .catch((error: unknown) => {
        logger.warn(
          `discord voice: realtime transcripts utterance failed: ${formatErrorMessage(error)}`,
        );
      });
  }

  private armWakeNameFollowup(): void {
    const turn = this.peekPendingSpeakerTurn();
    const context = this.consumePendingSpeakerContext();
    if (!context) {
      logger.warn(
        `discord voice: realtime wake-name follow-up has no speaker context voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
      return;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS);
    if (expiresAt === undefined) {
      return;
    }
    this.pendingWakeNameFollowup = {
      context,
      transcripts: turn?.transcripts,
      startedAt: turn?.startedAt ?? Date.now(),
      expiresAt,
    };
    logger.info(
      `discord voice: realtime wake-name follow-up armed speaker=${context.speakerLabel} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
    );
  }

  private consumePendingWakeNameFollowup(): TranscriptUtteranceAttribution | undefined {
    const pending = this.pendingWakeNameFollowup;
    this.pendingWakeNameFollowup = undefined;
    const now = asDateTimestampMs(Date.now());
    const expiresAt = pending ? asDateTimestampMs(pending.expiresAt) : undefined;
    if (!pending || now === undefined || expiresAt === undefined || now > expiresAt) {
      return undefined;
    }
    const currentTurn = this.peekPendingSpeakerTurn();
    if (currentTurn && currentTurn.context.userId !== pending.context.userId) {
      return undefined;
    }
    if (currentTurn) {
      this.consumePendingSpeakerContext();
    }
    return {
      context: pending.context,
      startedAt: pending.startedAt,
      transcripts: pending.transcripts,
    };
  }

  private rememberIgnoredWakeNameSpeakerContext(
    context: DiscordRealtimeSpeakerContext | undefined,
  ): void {
    this.speakerTurns.rememberIgnoredContext(context);
  }
}

export function isDiscordRealtimeSpeakerContext(
  value: unknown,
): value is DiscordRealtimeSpeakerContext {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { userId?: unknown }).userId === "string" &&
    typeof (value as { senderIsOwner?: unknown }).senderIsOwner === "boolean" &&
    typeof (value as { speakerLabel?: unknown }).speakerLabel === "string"
  );
}
