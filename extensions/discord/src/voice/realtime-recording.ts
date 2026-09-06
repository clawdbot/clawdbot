import type {
  DiscordVoiceSegmentOutcome,
  DiscordVoiceAudioReceipt,
  DiscordVoiceTranscriptCapture,
} from "./recording-types.js";

type Capture = DiscordVoiceTranscriptCapture | undefined;
const MAX_REALTIME_RECORDING_BYTES = 1024 * 1024;
const MAX_REALTIME_RECORDING_FINALS = 1_000;

/** One native input owns its submitted receipts and every batch job before it seals. */
export class DiscordRealtimeRecordingInput {
  initialReceipt: DiscordVoiceAudioReceipt | undefined;
  capture: Capture;
  startedAt: number | undefined;
  hasAudio = false;
  eligible = true;
  unavailable: boolean;
  private audioSealed = false;
  private batchSealed = false;
  private pending = 0;
  private readonly listeners = new Set<() => void>();

  constructor(batchDisabled: boolean) {
    this.unavailable = batchDisabled;
  }

  noteReceipt(receipt: DiscordVoiceAudioReceipt): void {
    this.initialReceipt ??= receipt;
  }

  submit(receipt: DiscordVoiceAudioReceipt | undefined): void {
    if (!this.hasAudio) {
      this.hasAudio = true;
      this.capture = receipt?.capture;
      this.startedAt = receipt?.startedAt;
    }
    if (!receipt?.capture || receipt.capture !== this.capture) {
      this.eligible = false;
    }
    this.notify();
  }

  observeBatch(result: Promise<DiscordVoiceSegmentOutcome>): void {
    this.pending += 1;
    void result
      .then(
        (outcome) => {
          if (outcome.status === "unavailable") {
            this.unavailable = true;
          } else {
            this.eligible = false;
          }
        },
        () => {
          this.eligible = false;
        },
      )
      .finally(() => {
        this.pending -= 1;
        this.notify();
      });
  }

  exclude(): void {
    this.eligible = false;
    this.notify();
  }

  sealAudio(): void {
    this.audioSealed = true;
    this.notify();
  }

  sealBatch(): void {
    this.batchSealed = true;
    this.notify();
  }

  get complete(): boolean {
    return this.audioSealed && this.batchSealed && this.pending === 0;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** Realtime text is usable only when the whole provider generation has one recording owner. */
export class DiscordRealtimeRecording {
  private readonly inputs = new Map<DiscordRealtimeRecordingInput, () => void>();
  private capture: Capture;
  private speaker: { id: string; label: string } | undefined;
  private firstStartedAt: number | undefined;
  private sawInput = false;
  private multipleInputs = false;
  private unavailable = false;
  private stopped = false;
  private publishing = false;
  private bytes = 0;
  private finals: Array<{ text: string; bytes: number; startedAt?: number }> = [];

  constructor(
    private readonly params: {
      entry: { guildId: string; channelId: string; voiceSessionKey: string };
      isCurrent: () => boolean;
      warn: (message: string) => void;
    },
  ) {}

  attach(input: DiscordRealtimeRecordingInput, speaker: { id: string; label: string }): void {
    if (this.stopped) {
      return;
    }
    let observed = false;
    const changed = () => {
      if (input.hasAudio && (!input.eligible || !input.capture?.isCurrent())) {
        this.close();
        return;
      }
      if (input.hasAudio && !observed) {
        observed = true;
        if (this.capture && this.capture !== input.capture) {
          this.close();
          return;
        }
        this.capture = input.capture;
        this.speaker ??= speaker;
        this.multipleInputs ||= this.sawInput;
        this.sawInput = true;
        this.firstStartedAt ??= input.startedAt;
      }
      if (input.complete) {
        if (input.hasAudio && !input.unavailable) {
          this.close();
          return;
        }
        this.unavailable ||= input.hasAudio && input.unavailable;
        this.inputs.get(input)?.();
        this.inputs.delete(input);
      }
      void this.publish();
    };
    this.inputs.set(input, input.subscribe(changed));
    changed();
  }

  transcript(text: string): void {
    if (this.stopped || !this.capture?.isCurrent() || !this.params.isCurrent()) {
      return;
    }
    const bytes = Buffer.byteLength(text);
    if (
      this.finals.length + Number(this.publishing) >= MAX_REALTIME_RECORDING_FINALS ||
      bytes > MAX_REALTIME_RECORDING_BYTES - this.bytes
    ) {
      this.params.warn(
        "discord voice: realtime recording backlog exceeded; configure batch audio transcription for independent recording.",
      );
      this.close();
      return;
    }
    this.bytes += bytes;
    this.finals.push({
      text,
      bytes,
      ...(!this.multipleInputs ? { startedAt: this.firstStartedAt } : {}),
    });
    void this.publish();
  }

  close(): void {
    this.stopped = true;
    for (const unsubscribe of this.inputs.values()) {
      unsubscribe();
    }
    this.inputs.clear();
    for (const final of this.finals) {
      this.bytes -= final.bytes;
    }
    this.finals = [];
  }

  private async publish(): Promise<void> {
    if (this.publishing || this.stopped || this.inputs.size > 0 || !this.unavailable) {
      return;
    }
    this.publishing = true;
    try {
      while (this.finals.length > 0 && !this.stopped && this.inputs.size === 0) {
        const capture = this.capture;
        const speaker = this.speaker;
        if (!capture?.isCurrent() || !speaker || !this.params.isCurrent()) {
          this.close();
          break;
        }
        const final = this.finals.shift()!;
        try {
          await capture.onUtterance({
            sessionId: capture.sessionId,
            ...(final.startedAt !== undefined
              ? { startedAt: new Date(final.startedAt).toISOString() }
              : {}),
            final: true,
            speaker,
            text: final.text,
            metadata: {
              channel: "discord",
              guildId: this.params.entry.guildId,
              channelId: this.params.entry.channelId,
              voiceSessionKey: this.params.entry.voiceSessionKey,
            },
          });
        } catch {
          this.params.warn(
            "discord voice: realtime recording publication failed; check transcript storage.",
          );
        } finally {
          this.bytes -= final.bytes;
        }
      }
    } finally {
      this.publishing = false;
    }
  }
}
