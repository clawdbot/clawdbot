import type { DiscordAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import {
  isRealtimeVoiceWakeNameRequired,
  matchRealtimeVoiceActivationName,
  type RealtimeVoiceActivationNameTranscriptResult,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceWakeNamePolicy,
} from "openclaw/plugin-sdk/realtime-voice";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
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
const DISCORD_REALTIME_WAKE_NAME_FOLLOWUP_TTL_MS = 10_000;
const REALTIME_PCM16_BYTES_PER_SAMPLE = 2;
const DISCORD_REALTIME_TRAILING_SILENCE_MIN_MS = 700;
const DISCORD_REALTIME_TRAILING_SILENCE_MAX_MS = 3_000;

export type DiscordRealtimeSpeakerContext = VoiceRealtimeSpeakerContext & { userId: string };

type PendingSpeakerTurn = {
  inputDiscordBytes: number;
  inputRealtimeBytes: number;
  inputChunks: number;
  interruptedPlayback: boolean;
  context: DiscordRealtimeSpeakerContext;
  startedAt: number;
  lastAudioAt?: number;
  hasAudio: boolean;
  closed: boolean;
};

type DiscordRealtimeVoiceConfig = NonNullable<DiscordAccountConfig["voice"]>["realtime"];

export class DiscordRealtimeTurns {
  private lastSpeakerTurn: PendingSpeakerTurn | undefined;
  private pendingAudio = false;
  private partialUserTranscript = "";
  private source:
    | Readonly<Pick<DiscordRealtimeSpeakerContext, "userId" | "senderIsOwner">>
    | undefined;
  private wakeNameAckedForTurn = false;
  private pendingWakeNameFollowup:
    | {
        context: DiscordRealtimeSpeakerContext;
        expiresAt: number;
      }
    | undefined;

  constructor(
    private readonly params: {
      bridge: () => RealtimeVoiceBridgeSession | null;
      entry: VoiceSessionEntry;
      getHumanParticipantCount: () => number;
      interruptRoomPlayback: () => boolean;
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
    if (
      this.source &&
      (this.source.userId !== userId || this.source.senderIsOwner !== context.senderIsOwner)
    ) {
      throw new Error("A Discord realtime connection cannot change speaker authority");
    }
    this.source ??= Object.freeze({ userId, senderIsOwner: context.senderIsOwner });
    this.resetPartialWakeNameTracking();
    const turn: PendingSpeakerTurn = {
      context: { ...context, ...this.source },
      startedAt: Date.now(),
      hasAudio: false,
      closed: false,
      inputDiscordBytes: 0,
      inputRealtimeBytes: 0,
      inputChunks: 0,
      interruptedPlayback: false,
    };
    return {
      sendInputAudio: (discordPcm48kStereo) =>
        this.sendInputAudioForTurn(turn, discordPcm48kStereo),
      close: () => {
        this.sendRealtimeTrailingSilenceForTurn(turn);
        this.logSpeakerTurnClosed(turn);
        turn.closed = true;
      },
    };
  }

  handlePartialUserTranscript(text: string): void {
    if (!this.lastSpeakerTurn || !this.isWakeNameRequired() || this.wakeNameAckedForTurn) {
      return;
    }
    this.partialUserTranscript = mergeRealtimePartialTranscript(this.partialUserTranscript, text);
    const wakeNameResult = matchRealtimeVoiceActivationName(
      this.partialUserTranscript,
      this.params.wakeNames(),
    );
    // Incomplete words can look like fuzzy names; defer those to the final transcript.
    if (wakeNameResult?.edge !== "leading" || wakeNameResult.match !== "exact") {
      return;
    }
    this.wakeNameAckedForTurn = true;
    this.params.playback.sendWakeNameAck(wakeNameResult);
  }

  async handleFinalUserTranscript(text: string): Promise<void> {
    if (!this.lastSpeakerTurn || this.params.stopped()) {
      return;
    }
    const providerEpoch = this.params.providerEpoch();
    const trimmed = text.trim();
    if (!trimmed) {
      this.pendingAudio = false;
      this.resetPartialWakeNameTracking();
      return;
    }
    this.partialUserTranscript = "";
    const humanParticipantCount = this.params.getHumanParticipantCount();
    const requireWakeName = this.isWakeNameRequired(humanParticipantCount);
    const wakeNameResult = this.resolveWakeNameTranscript(trimmed, requireWakeName);
    let forcedSpeakerContext: DiscordRealtimeSpeakerContext | undefined;
    if (!wakeNameResult.allowed) {
      const pendingWakeNameFollowup = this.consumePendingWakeNameFollowup();
      if (!pendingWakeNameFollowup) {
        this.consumePendingSpeakerContext();
        logger.info(
          `discord voice: realtime wake-name gate ignored transcript chars=${trimmed.length} humanParticipants=${humanParticipantCount} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId} wakeNames=${this.params.wakeNames().join(",") || "none"}`,
        );
        return;
      }
      forcedSpeakerContext = pendingWakeNameFollowup;
      logger.info(
        `discord voice: realtime wake-name follow-up accepted chars=${trimmed.length} speaker=${forcedSpeakerContext.speakerLabel} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
      );
    }
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
    this.pendingAudio = false;
    this.lastSpeakerTurn = undefined;
  }

  clear(): void {
    this.pendingAudio = false;
    this.lastSpeakerTurn = undefined;
    this.resetPartialWakeNameTracking();
    this.pendingWakeNameFollowup = undefined;
  }

  consumePendingSpeakerContext(): DiscordRealtimeSpeakerContext | undefined {
    this.pendingAudio = false;
    // Capture boundaries and final-transcript counts need not match. Identity belongs to
    // the connection's sole input source, never to whichever capture remains in a queue.
    return this.speakerContext();
  }

  speakerContext(): DiscordRealtimeSpeakerContext | undefined {
    // Roster text and display names may refresh; every capture still has the same frozen
    // Discord principal and owner flag, checked before any audio enters this connection.
    return this.lastSpeakerTurn?.context;
  }

  hasPendingSpeakerAudioContext(): boolean {
    return this.pendingAudio;
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
      if (!turn.interruptedPlayback && this.params.interruptRoomPlayback()) {
        turn.interruptedPlayback = true;
        logVoiceVerbose(
          `realtime barge-in from active speaker audio: guild ${this.params.entry.guildId} channel ${this.params.entry.channelId} user ${turn.context.userId}`,
        );
        logger.info(
          `discord voice: realtime barge-in detected source=active-speaker-audio guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} discordBytes=${discordPcm48kStereo.length} realtimeBytes=${realtimePcm.length}`,
        );
      }
      if (this.params.recordInputAudio(realtimePcm)) {
        bridge.sendAudio(realtimePcm);
      }
    }
  }

  private registerSpeakerTurnAudioStarted(turn: PendingSpeakerTurn): void {
    this.pendingAudio = true;
    this.lastSpeakerTurn = turn;
    turn.lastAudioAt = Date.now();
    if (turn.hasAudio) {
      return;
    }
    turn.hasAudio = true;
    logger.info(
      `discord voice: realtime speaker turn opened guild=${this.params.entry.guildId} channel=${this.params.entry.channelId} user=${turn.context.userId} speaker=${turn.context.speakerLabel} owner=${turn.context.senderIsOwner}`,
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

  private armWakeNameFollowup(): void {
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
      expiresAt,
    };
    logger.info(
      `discord voice: realtime wake-name follow-up armed speaker=${context.speakerLabel} voiceSession=${this.params.entry.voiceSessionKey} agent=${this.params.entry.route.agentId}`,
    );
  }

  private consumePendingWakeNameFollowup(): DiscordRealtimeSpeakerContext | undefined {
    const pending = this.pendingWakeNameFollowup;
    this.pendingWakeNameFollowup = undefined;
    const now = asDateTimestampMs(Date.now());
    const expiresAt = pending ? asDateTimestampMs(pending.expiresAt) : undefined;
    if (!pending || now === undefined || expiresAt === undefined || now > expiresAt) {
      return undefined;
    }
    this.consumePendingSpeakerContext();
    return pending.context;
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
