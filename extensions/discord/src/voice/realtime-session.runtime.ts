import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { DiscordRealtimePlayer } from "./realtime-player.js";
import {
  DiscordRealtimeSpeakerSession,
  type DiscordRealtimeSessionParams,
} from "./realtime-speaker-session.js";
import type {
  VoiceRealtimeSession,
  VoiceRealtimeSpeakerContext,
  VoiceRealtimeSpeakerTurn,
  VoiceSessionEntry,
} from "./session.js";

const logger = createSubsystemLogger("discord/voice");
const MAX_REALTIME_SPEAKERS = 8;
const REALTIME_SPEAKER_IDLE_MS = 60_000;

type SpeakerSession = {
  userId: string;
  senderIsOwner: boolean;
  transcripts: VoiceSessionEntry["transcripts"];
  session: DiscordRealtimeSpeakerSession;
};

/** The room shares its agent and player; each provider connection has one immutable speaker. */
export class DiscordRealtimeVoiceSession implements VoiceRealtimeSession {
  private readonly player: DiscordRealtimePlayer;
  private readonly speakers = new Map<string, SpeakerSession>();
  private readonly sessions = new Set<SpeakerSession>();
  private warmSession: DiscordRealtimeSpeakerSession | undefined;
  private nextSessionId = 0;
  private closed = false;
  private idleTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly params: DiscordRealtimeSessionParams) {
    this.player = new DiscordRealtimePlayer(params.entry.player);
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Discord realtime voice session is closed");
    }
    const session = this.createSession();
    this.warmSession = session;
    await session.connect();
    if (this.closed) {
      session.close();
      return;
    }
    this.idleTimer = setInterval(() => this.releaseIdleSpeakers(), REALTIME_SPEAKER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearInterval(this.idleTimer);
    this.idleTimer = undefined;
    // Retire the physical player first: lane teardown must not start the next queued response.
    this.player.close();
    this.warmSession?.close();
    this.warmSession = undefined;
    for (const { session } of this.sessions) {
      session.close();
    }
    this.speakers.clear();
    this.sessions.clear();
  }

  beginSpeakerTurn(context: VoiceRealtimeSpeakerContext, userId: string): VoiceRealtimeSpeakerTurn {
    if (this.closed) {
      throw new Error("Discord realtime voice session is closed");
    }
    for (const previous of this.sessions) {
      if (previous.userId === userId && previous.senderIsOwner !== context.senderIsOwner) {
        this.retireSpeaker(previous, "admission-changed");
      }
    }
    let speaker = this.speakers.get(userId);
    if (speaker && speaker.transcripts !== this.params.entry.transcripts) {
      // Subscription replacement fences transcript delivery, but must not cut a valid spoken
      // answer short. The old connection drains with its original source and receives no new input.
      this.speakers.delete(userId);
      speaker.session.drain();
      speaker = undefined;
    }
    if (!speaker) {
      this.releaseIdleSpeakers();
      if (this.sessions.size >= MAX_REALTIME_SPEAKERS) {
        const message = "Voice is busy with other speakers. Please try again after their replies.";
        this.notify(message);
        throw new Error(message);
      }
      const warm = this.warmSession;
      this.warmSession = undefined;
      const session = warm ?? this.createSession();
      speaker = {
        userId,
        senderIsOwner: context.senderIsOwner,
        transcripts: this.params.entry.transcripts,
        session,
      };
      this.speakers.set(userId, speaker);
      this.sessions.add(speaker);
      if (!warm) {
        // Provider queues own pre-ready audio; create the bridge synchronously before capture
        // sends its first chunk, while connection errors remain local to this speaker.
        void session.connect().catch((error: unknown) => this.handleSpeakerFailure(session, error));
      }
    }
    return speaker.session.beginSpeakerTurn(context, userId);
  }

  handleBargeIn(reason = "barge-in"): void {
    this.player.handleBargeIn(reason);
  }

  isBargeInEnabled(): boolean {
    const session = this.warmSession ?? this.sessions.values().next().value?.session;
    return session?.isBargeInEnabled() ?? false;
  }

  private createSession(): DiscordRealtimeSpeakerSession {
    const session = new DiscordRealtimeSpeakerSession({
      ...this.params,
      player: this.player,
      sessionId: `discord:${this.params.entry.voiceSessionKey}:realtime:${++this.nextSessionId}`,
      onTerminalError: (error) => this.handleSpeakerFailure(session, error),
    });
    return session;
  }

  private handleSpeakerFailure(session: DiscordRealtimeSpeakerSession, error: unknown): void {
    if (this.closed) {
      return;
    }
    if (this.warmSession === session) {
      this.params.onTerminalError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    for (const speaker of this.sessions) {
      if (speaker.session !== session) {
        continue;
      }
      logger.warn(
        `discord voice: realtime speaker failed user=${speaker.userId}: ${formatErrorMessage(error)}`,
      );
      this.retireSpeaker(speaker, "provider-failed");
      this.notify("I lost a speaker's voice connection. Please try speaking again.");
      return;
    }
  }

  private notify(text: string): void {
    const session = this.warmSession ?? this.sessions.values().next().value?.session;
    session?.notify(text);
  }

  private releaseIdleSpeakers(): void {
    const cutoff = Date.now() - REALTIME_SPEAKER_IDLE_MS;
    for (const speaker of this.sessions) {
      const reason = speaker.session.releaseReasonBefore(cutoff);
      if (reason) {
        this.retireSpeaker(speaker, reason);
      }
    }
  }

  private retireSpeaker(speaker: SpeakerSession, reason: string): void {
    // A draining generation can finish after this user's replacement has started.
    if (this.speakers.get(speaker.userId) === speaker) {
      this.speakers.delete(speaker.userId);
    }
    this.sessions.delete(speaker);
    speaker.session.close();
    logger.info(
      `discord voice: realtime speaker retired user=${speaker.userId} reason=${reason}${reason === "input-timeout" ? "; idle speaker input expired; speak again to reconnect" : ""}`,
    );
  }
}
