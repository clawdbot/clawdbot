import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError, formatUiExternalText } from "../../lib/format-error.ts";
import {
  bytesToBase64,
  floatToG711Ulaw,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
} from "./realtime-talk-audio.ts";
import {
  describeRealtimeTalkInputError,
  RealtimeTalkInputController,
} from "./realtime-talk-input.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";

const HOLD_ARM_DELAY_MS = 150,
  HOLD_PROGRESS_MS = 350;
const FINAL_TRANSCRIPT_MAX_WAIT_MS = 10_000;
const DICTATION_ENCODING = "g711_ulaw";
const DICTATION_SAMPLE_RATE_HZ = 8000;
const MAX_PENDING_AUDIO_SAMPLES = DICTATION_SAMPLE_RATE_HZ * 10;

type DictationPhase = "idle" | "pressing" | "holding" | "connecting" | "recording" | "stopping";

// Transcription relay talk.event payload (src/gateway/talk-transcription-relay.ts):
// the transcriptionSessionId envelope is the relay's emission shape, shared with the
// Android dictation client; the canonical TalkEvent rides alongside as `talkEvent`.
type DictationEvent = {
  transcriptionSessionId?: unknown;
  type?: unknown;
  text?: unknown;
  final?: unknown;
  message?: unknown;
  reason?: unknown;
};

type DictationSessionResult = {
  sessionId: string;
  transcriptionSessionId?: string;
  audio?: {
    inputEncoding?: unknown;
    inputSampleRateHz?: unknown;
  };
};

type ComposerDictationSessionCallbacks = {
  onError: (message: string, preservesText: boolean) => void;
  onLevel: (level: number) => void;
  onTranscriptChange: () => void;
  onReady: () => void;
};

type ComposerDictationFailure = {
  kind: "interrupted" | "start";
  preservesText: boolean;
};

type ComposerDictationControllerOptions = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enabled: boolean;
  dictationAvailable?: boolean;
  realtimeTalkActive: boolean;
  onCommit: (text: string, late?: true) => void;
  onError: (message: string, failure: ComposerDictationFailure) => void;
  onStateChange: () => void;
  onTap?: () => void;
  onDictationUnavailable?: () => void;
};

function eventPayload(frame: GatewayEventFrame): DictationEvent | null {
  if (frame.event !== "talk.event" || !frame.payload || typeof frame.payload !== "object") {
    return null;
  }
  return frame.payload as DictationEvent;
}

function messageFromError(error: unknown): string {
  if (error instanceof DOMException) {
    return describeRealtimeTalkInputError(error);
  }
  return formatUiError(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function insertComposerDictation(
  value: string,
  transcript: string,
  selectionStart: number,
  selectionEnd: number,
): { value: string; caret: number } {
  const spoken = transcript.trim();
  if (!spoken) {
    return { value, caret: selectionEnd };
  }
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const before = value.slice(0, start);
  const after = value.slice(end);
  const leadingSpace = before && !/\s$/.test(before) && !/^\s|^[,.;:!?)]/.test(spoken) ? " " : "";
  const trailingSpace =
    after && !/^\s|^[,.;:!?)]/.test(after) && !/[\s([{]$/.test(spoken) ? " " : "";
  const inserted = `${leadingSpace}${spoken}${trailingSpace}`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

class ComposerDictationSession {
  private readonly input = new RealtimeTalkInputController((detail) => this.reportFailure(detail));
  private context: AudioContext | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private transcriptionSessionId: string | null = null;
  private readonly finalTranscripts: string[] = [];
  private currentPartial = "";
  private startPromise: Promise<void> | null = null;
  private readonly pendingAudio: Float32Array[] = [];
  private pendingAudioSamples = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private stopped = false;
  private discarded = false;
  private failed = false;
  private gatewayDisconnected = false;
  private settleLateFinalDrain: ((discard: boolean) => void) | null = null;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly callbacks: ComposerDictationSessionCallbacks,
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const inputDeviceId = loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
    const media = await this.input.open(inputDeviceId);
    if (this.stopped) {
      return;
    }
    this.unsubscribe = this.client.addEventListener((frame) => this.handleEvent(frame));
    try {
      this.context = new AudioContext({ sampleRate: DICTATION_SAMPLE_RATE_HZ });
    } catch {
      throw new Error(t("chat.composer.dictationBrowserAudioUnsupported"));
    }
    if (this.context.sampleRate !== DICTATION_SAMPLE_RATE_HZ) {
      throw new Error(t("chat.composer.dictationBrowserAudioUnsupported"));
    }
    this.inputMeter = new RealtimeTalkMediaStreamMeter(this.callbacks.onLevel);
    this.inputMeter.start(media, this.context);
    this.inputPump.start(media, this.context, (samples) => this.appendAudio(samples));
    this.callbacks.onReady();

    const result = await this.client.request<DictationSessionResult>("talk.session.create", {
      mode: "transcription",
      transport: "gateway-relay",
      brain: "none",
    });
    this.sessionId = result.sessionId;
    this.transcriptionSessionId = result.transcriptionSessionId ?? result.sessionId;
    if (
      result.audio?.inputEncoding !== DICTATION_ENCODING ||
      result.audio.inputSampleRateHz !== DICTATION_SAMPLE_RATE_HZ
    ) {
      await this.closeRemote();
      throw new Error(t("chat.composer.dictationAudioUnsupported"));
    }
    if (this.discarded) {
      this.pendingAudio.length = 0;
      this.pendingAudioSamples = 0;
    } else {
      this.flushPendingAudio();
    }
    if (this.stopped) {
      await this.appendChain;
      await this.closeRemote();
    }
  }

  transcriptSnapshot(): string {
    return this.transcriptIncludingPartial();
  }

  async finish(drainFinalTranscript = false): Promise<string> {
    const lateFinal =
      drainFinalTranscript && !this.gatewayDisconnected ? this.waitForLateFinal() : null;
    const cleanup = this.stopAndClose(true);
    if (lateFinal) {
      // The bounded final result must not inherit stalled create, append, or close RPCs.
      void cleanup.catch(() => undefined);
      return lateFinal;
    }
    return cleanup.then(() => this.transcriptIncludingPartial());
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    await this.stopAndClose(false);
  }

  private async stopAndClose(reportStartFailure: boolean): Promise<void> {
    await this.stopCapture();
    await this.startPromise?.catch((error: unknown) => {
      if (reportStartFailure && !isAbortError(error)) {
        this.reportFailure(messageFromError(error));
      }
    });
    await this.appendChain;
    await this.closeRemote();
  }

  markGatewayDisconnected(): boolean {
    this.gatewayDisconnected = true;
    this.settleLateFinalDrain?.(false);
    return this.hasTranscript();
  }

  cancelPendingFinal(): void {
    this.settleLateFinalDrain?.(true);
  }

  private appendAudio(samples: Float32Array): void {
    if (this.stopped) {
      return;
    }
    if (!this.sessionId) {
      const remaining = MAX_PENDING_AUDIO_SAMPLES - this.pendingAudioSamples;
      if (remaining <= 0) {
        return;
      }
      const buffered = samples.slice(0, remaining);
      this.pendingAudio.push(buffered);
      this.pendingAudioSamples += buffered.length;
      return;
    }
    this.queueAudio(samples);
  }

  private flushPendingAudio(): void {
    const pending = this.pendingAudio.splice(0);
    this.pendingAudioSamples = 0;
    for (const samples of pending) {
      this.queueAudio(samples);
    }
  }

  private queueAudio(samples: Float32Array): void {
    if (!this.sessionId) {
      return;
    }
    const sessionId = this.sessionId;
    const audioBase64 = bytesToBase64(floatToG711Ulaw(samples));
    this.appendChain = this.appendChain
      .then(async () => {
        await this.client.request("talk.session.appendAudio", { sessionId, audioBase64 });
      })
      .catch((error: unknown) => {
        this.reportFailure(messageFromError(error));
      });
  }

  private handleEvent(frame: GatewayEventFrame): void {
    const payload = eventPayload(frame);
    if (
      !payload ||
      payload.transcriptionSessionId !== this.transcriptionSessionId ||
      this.stopped
    ) {
      return;
    }
    if (payload.type === "transcript" && typeof payload.text === "string") {
      const text = payload.text.trim();
      if (payload.final !== true) {
        this.currentPartial = text;
        this.callbacks.onTranscriptChange();
        return;
      }
      if (text) {
        this.finalTranscripts.push(text);
        this.currentPartial = "";
      }
      this.callbacks.onTranscriptChange();
      return;
    }
    if (payload.type === "partial" && typeof payload.text === "string") {
      this.currentPartial = payload.text.trim();
      this.callbacks.onTranscriptChange();
      return;
    }
    if (payload.type === "error") {
      this.reportFailure(
        formatUiExternalText(
          typeof payload.message === "string" ? payload.message : undefined,
          t("chat.composer.dictationFailed"),
        ),
      );
      return;
    }
    if (payload.type === "close" && payload.reason === "error") {
      this.reportFailure(t("chat.composer.dictationDisconnected"));
    }
  }

  private reportFailure(message: string): void {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.callbacks.onError(message, this.hasTranscript());
  }

  private hasTranscript(): boolean {
    return this.finalTranscripts.length > 0 || Boolean(this.currentPartial);
  }

  private transcriptIncludingPartial(): string {
    return [...this.finalTranscripts, this.currentPartial].filter(Boolean).join(" ").trim();
  }

  private async stopCapture(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.input.stop();
    this.inputPump.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.inputMeter?.stop();
    this.inputMeter = null;
    await this.context?.close();
    this.context = null;
  }

  private closeRemote(): Promise<void> {
    if (!this.sessionId) {
      return Promise.resolve();
    }
    this.closePromise ??= this.client
      .request("talk.session.close", { sessionId: this.sessionId })
      .then(() => undefined)
      .catch(() => undefined);
    return this.closePromise;
  }

  private waitForLateFinal(): Promise<string> {
    return new Promise((resolve) => {
      const transcripts: string[] = [];
      let unsubscribe = () => {};
      const finish = (text: string) => {
        globalThis.clearTimeout(timer);
        unsubscribe();
        this.settleLateFinalDrain = null;
        resolve(text);
      };
      const transcript = () => transcripts.join(" ").trim();
      const timer = globalThis.setTimeout(() => finish(transcript()), FINAL_TRANSCRIPT_MAX_WAIT_MS);
      unsubscribe = this.client.addEventListener((frame) => {
        const payload = eventPayload(frame);
        if (!payload || payload.transcriptionSessionId !== this.transcriptionSessionId) {
          return;
        }
        if (
          payload.type === "transcript" &&
          payload.final === true &&
          typeof payload.text === "string" &&
          payload.text.trim()
        ) {
          transcripts.push(payload.text.trim());
        } else if (payload.type === "error" || payload.type === "close") {
          finish(transcript());
        }
      });
      this.settleLateFinalDrain = (discard) => finish(discard ? "" : transcript());
    });
  }
}

export class ComposerDictationController {
  readonly inputLevel = new RealtimeTalkLevelSignal();
  private options: ComposerDictationControllerOptions;
  private phase: DictationPhase = "idle";
  private pointerId: number | null = null;
  private pointerTarget: HTMLElement | null = null;
  private pointerBounds: DOMRect | null = null;
  private holdTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private session: ComposerDictationSession | null = null;
  private suppressClick = false;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private pendingCommitSession: ComposerDictationSession | null = null;
  private disposed = false;

  constructor(options: ComposerDictationControllerOptions) {
    this.options = options;
  }

  get active(): boolean {
    return this.phase === "connecting" || this.phase === "recording" || this.phase === "stopping";
  }

  get connecting(): boolean {
    return this.phase === "connecting";
  }

  get arming(): boolean {
    return this.phase === "holding";
  }

  get finalizing(): boolean {
    return this.phase === "stopping";
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  get transcript(): string {
    return this.session?.transcriptSnapshot() ?? "";
  }

  // Returns the stop promise so the confirming control can remain tied to the
  // session that actually inserted text into the draft.
  finishActive(): Promise<boolean> {
    return this.stop({ commit: true });
  }

  startDirect(): boolean {
    if (this.phase !== "idle" || !this.canHold()) {
      return false;
    }
    // Surfaces without Talk do not need the hold discriminator. Enter the same
    // session start path directly so capture, errors, partials and finalization stay canonical.
    this.setPhase("holding");
    void this.start();
    return true;
  }

  update(options: ComposerDictationControllerOptions): void {
    this.options = options;
    if (!options.connected) {
      this.pendingCommitSession?.markGatewayDisconnected();
    }
    if (this.phase === "stopping") {
      return;
    }
    if ((this.phase !== "idle" && !this.canHold()) || (this.active && !options.connected)) {
      const keepFinal = this.active && !options.connected;
      const preservesText = keepFinal ? (this.session?.markGatewayDisconnected() ?? false) : false;
      void this.stop({ commit: keepFinal });
      if (keepFinal) {
        options.onError(t("chat.composer.dictationDisconnected"), {
          kind: "interrupted",
          preservesText,
        });
      }
    }
  }

  handlePointerDown(event: PointerEvent): boolean {
    if (event.button !== 0 || this.phase !== "idle" || !this.canHold()) {
      return false;
    }
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.pointerTarget = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.pointerBounds = this.pointerTarget?.getBoundingClientRect() ?? null;
    this.pointerTarget?.setPointerCapture?.(event.pointerId);
    this.pointerTarget?.addEventListener("lostpointercapture", this.handleLostPointerCapture);
    this.suppressClick = true;
    this.suppressedPointerId = event.pointerId;
    this.setPhase("pressing");
    // A normal click gets a quiet grace period. Only a sustained press enters
    // the visible 350ms ring, so the hold affordance cannot steal tap-to-talk.
    this.holdTimer = globalThis.setTimeout(() => {
      if (this.phase !== "pressing") {
        return;
      }
      this.setPhase("holding");
      this.holdTimer = globalThis.setTimeout(() => void this.start(), HOLD_PROGRESS_MS);
    }, HOLD_ARM_DELAY_MS);
    document.addEventListener("pointermove", this.handleDocumentPointerMove);
    document.addEventListener("pointerup", this.handleDocumentPointerUp);
    document.addEventListener("pointercancel", this.handleDocumentPointerCancel);
    document.addEventListener("pointerup", this.handleSuppressedPointerRelease);
    document.addEventListener("pointercancel", this.handleSuppressedPointerRelease);
    return true;
  }

  handleClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.clearClickSuppression();
      event.preventDefault();
      return;
    }
    if (this.active) {
      event.preventDefault();
      void this.finishActive();
      return;
    }
    if (this.phase !== "idle") {
      event.preventDefault();
      return;
    }
    this.options.onTap?.();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.phase !== "idle") {
      event.preventDefault();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.retirePendingCommit();
    this.clearClickSuppression();
    void this.stop({ commit: false });
  }

  private readonly handleDocumentPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId || !this.pointerBounds) {
      return;
    }
    const rect = this.pointerBounds;
    const outside =
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom;
    if (outside) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleDocumentPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.pointerId) {
      return;
    }
    if (this.phase === "pressing" || this.phase === "holding") {
      const cleanTap = this.phase === "pressing";
      this.clearPointerGesture();
      this.setPhase("idle");
      if (cleanTap) {
        this.options.onTap?.();
      }
      this.expireClickSuppression();
      return;
    }
    void this.stop({ commit: true });
  };

  private readonly handleDocumentPointerCancel = (event: PointerEvent): void => {
    if (event.pointerId === this.pointerId) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleSuppressedPointerRelease = (event: PointerEvent): void => {
    if (event.pointerId === this.suppressedPointerId) {
      this.expireClickSuppression();
    }
  };

  private readonly handleDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || this.phase === "idle") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void this.stop({ commit: false });
  };

  private readonly handleLostPointerCapture = (event: Event): void => {
    if ((event as PointerEvent).pointerId === this.pointerId) {
      void this.stop({ commit: false });
    }
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "hidden") {
      this.clearClickSuppression();
      void this.stop({ commit: false });
    }
  };

  private readonly handleWindowBlur = (): void => {
    this.clearClickSuppression();
    void this.stop({ commit: false });
  };

  private canHold(): boolean {
    return (
      this.options.enabled &&
      this.options.connected &&
      !this.options.realtimeTalkActive &&
      this.options.client !== null
    );
  }

  private async start(): Promise<void> {
    const client = this.options.client;
    if (this.phase !== "holding" || !client || !this.canHold()) {
      await this.stop({ commit: false });
      return;
    }
    if (this.options.dictationAvailable === false) {
      this.clearPointerGesture();
      this.setPhase("idle");
      this.options.onDictationUnavailable?.();
      // The held pointer still owns a synthetic click. Its release expires this
      // suppression only after handleClick has had a chance to consume the tail.
      return;
    }
    // Crossing the threshold latches dictation. Pointer ownership ends here,
    // while Escape/visibility/blur keep guarding the live capture lifecycle.
    this.clearPointerGesture();
    this.setPhase("connecting");
    const session = new ComposerDictationSession(client, {
      onError: (message, preservesText) => {
        if (this.session !== session) {
          return;
        }
        try {
          this.options.onError(message, { kind: "interrupted", preservesText });
        } finally {
          void this.stop({ commit: true });
        }
      },
      onLevel: (level) => this.inputLevel.set(level),
      onTranscriptChange: () => this.options.onStateChange(),
      onReady: () => {
        if (this.session === session && this.phase === "connecting") {
          this.setPhase("recording");
        }
      },
    });
    this.retirePendingCommit();
    this.session = session;
    try {
      await session.start();
    } catch (error) {
      if (this.session !== session || this.disposed || this.isStopping()) {
        return;
      }
      this.options.onError(messageFromError(error), { kind: "start", preservesText: false });
      await this.stop({ commit: false });
    }
  }

  private stop(options: { commit: boolean }): Promise<boolean> {
    if (this.phase === "idle" || this.phase === "stopping") {
      return Promise.resolve(false);
    }
    const wasActive = this.active;
    this.clearPointerGesture();
    const session = this.session;
    if (!session) {
      this.reset();
      return Promise.resolve(false);
    }
    this.setPhase("stopping");
    const transcript = options.commit ? session.transcriptSnapshot() : "";
    const committed = Boolean(options.commit && transcript && wasActive && !this.disposed);
    this.session = null;
    this.reset();
    if (committed) {
      this.options.onCommit(transcript);
    }
    if (!options.commit) {
      void session.cancel().catch(() => undefined);
      return Promise.resolve(false);
    }
    if (committed) {
      void session.finish().catch(() => undefined);
      return Promise.resolve(true);
    }
    // The composer unlocks immediately, while this exact stopped session keeps
    // ownership of its bounded final accumulator until a new session supersedes it.
    this.pendingCommitSession = session;
    return session
      .finish(true)
      .then((lateTranscript) => {
        const ownsPendingCommit = this.pendingCommitSession === session;
        if (ownsPendingCommit) {
          this.pendingCommitSession = null;
        }
        if (!ownsPendingCommit || !lateTranscript || !wasActive || this.disposed) {
          return false;
        }
        this.options.onCommit(lateTranscript, true);
        return true;
      })
      .catch(() => {
        if (this.pendingCommitSession === session) {
          this.pendingCommitSession = null;
        }
        return false;
      });
  }

  private reset(): void {
    this.inputLevel.set(0);
    this.setPhase("idle");
  }

  private retirePendingCommit(): void {
    this.pendingCommitSession?.cancelPendingFinal();
    this.pendingCommitSession = null;
  }

  private clearPointerGesture(): void {
    if (this.holdTimer !== null) {
      globalThis.clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.pointerId !== null) {
      this.pointerTarget?.removeEventListener("lostpointercapture", this.handleLostPointerCapture);
      try {
        this.pointerTarget?.releasePointerCapture?.(this.pointerId);
      } catch {
        // A reactive render can replace the button and implicitly release capture first.
      }
    }
    this.pointerId = null;
    this.pointerTarget = null;
    this.pointerBounds = null;
    document.removeEventListener("pointermove", this.handleDocumentPointerMove);
    document.removeEventListener("pointerup", this.handleDocumentPointerUp);
    document.removeEventListener("pointercancel", this.handleDocumentPointerCancel);
  }

  private expireClickSuppression(): void {
    if (!this.suppressClick || this.suppressClickTimer !== null) {
      return;
    }
    this.suppressClickTimer = globalThis.setTimeout(() => this.clearClickSuppression(), 0);
  }

  private clearClickSuppression(): void {
    if (this.suppressClickTimer !== null) {
      globalThis.clearTimeout(this.suppressClickTimer);
      this.suppressClickTimer = null;
    }
    document.removeEventListener("pointerup", this.handleSuppressedPointerRelease);
    document.removeEventListener("pointercancel", this.handleSuppressedPointerRelease);
    this.suppressedPointerId = null;
    this.suppressClick = false;
  }

  private isStopping(): boolean {
    return this.phase === "stopping";
  }

  private setPhase(phase: DictationPhase): void {
    if (this.phase === phase) {
      return;
    }
    if (this.phase === "idle") {
      document.addEventListener("keydown", this.handleDocumentKeyDown);
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      window.addEventListener("blur", this.handleWindowBlur);
    } else if (phase === "idle") {
      document.removeEventListener("keydown", this.handleDocumentKeyDown);
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      window.removeEventListener("blur", this.handleWindowBlur);
    }
    this.phase = phase;
    this.options.onStateChange();
  }
}
