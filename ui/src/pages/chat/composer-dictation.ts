import type { TalkCatalogResult } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient, GatewayEventFrame } from "../../api/gateway.ts";
import { loadSettings } from "../../app/settings.ts";
import { t } from "../../i18n/index.ts";
import {
  bytesToBase64,
  floatToG711Ulaw,
  RealtimeTalkMediaStreamMeter,
  RealtimeTalkPcmInputPump,
} from "./realtime-talk-audio.ts";
import { describeRealtimeTalkInputError, openRealtimeTalkInput } from "./realtime-talk-input.ts";
import { RealtimeTalkLevelSignal } from "./realtime-talk-level.ts";

const HOLD_THRESHOLD_MS = 250;
const FINAL_TRANSCRIPT_QUIET_MS = 1500;
const FINAL_TRANSCRIPT_MAX_WAIT_MS = 10_000;
const DICTATION_ENCODING = "g711_ulaw";
const DICTATION_SAMPLE_RATE_HZ = 8000;
const MAX_PENDING_AUDIO_SAMPLES = DICTATION_SAMPLE_RATE_HZ * 10;

type DictationPhase = "idle" | "holding" | "connecting" | "recording" | "stopping";

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
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  onPartial: (text: string) => void;
  onReady: () => void;
};

type ComposerDictationControllerOptions = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  enabled: boolean;
  realtimeTalkActive: boolean;
  onCommit: (text: string) => void;
  onError: (message: string) => void;
  onStateChange: () => void;
  onTap: () => void;
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
  return error instanceof Error ? error.message : String(error);
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
  private media: MediaStream | null = null;
  private context: AudioContext | null = null;
  private readonly inputPump = new RealtimeTalkPcmInputPump();
  private inputMeter: RealtimeTalkMediaStreamMeter | null = null;
  private unsubscribe: (() => void) | null = null;
  private sessionId: string | null = null;
  private transcriptionSessionId: string | null = null;
  private readonly finalTranscripts: string[] = [];
  private currentPartial = "";
  private trailingFinalDrain: {
    resolve: () => void;
    quietTimer: ReturnType<typeof globalThis.setTimeout> | null;
    maxTimer: ReturnType<typeof globalThis.setTimeout>;
  } | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly pendingAudio: Float32Array[] = [];
  private pendingAudioSamples = 0;
  private appendChain: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;
  private stopped = false;
  private discarded = false;
  private closed = false;
  private failed = false;
  private gatewayDisconnected = false;

  constructor(
    private readonly client: GatewayBrowserClient,
    private readonly callbacks: ComposerDictationSessionCallbacks,
    private readonly abortController = new AbortController(),
  ) {}

  start(): Promise<void> {
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  private async startInternal(): Promise<void> {
    const catalog = await this.client.request<TalkCatalogResult>("talk.catalog", {});
    if (catalog.transcription?.ready !== true) {
      throw new Error(t("chat.composer.dictationProviderUnavailable"));
    }

    const inputDeviceId = loadSettings().realtimeTalkInputDeviceId?.trim() || undefined;
    const media = await openRealtimeTalkInput(inputDeviceId, {
      signal: this.abortController.signal,
    });
    if (this.stopped) {
      media.getTracks().forEach((track) => track.stop());
      return;
    }
    this.media = media;
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

  async finish(): Promise<string> {
    await this.stopCapture();
    await this.startPromise?.catch((error: unknown) => {
      if (!isAbortError(error)) {
        this.reportFailure(messageFromError(error));
      }
    });
    await this.appendChain;
    await this.closeRemote();
    if (!this.sessionId) {
      this.cleanupEvents();
      return "";
    }
    if (this.gatewayDisconnected || this.failed) {
      this.cleanupEvents();
      return this.finalTranscripts.join(" ").trim();
    }
    // A provider can emit several final utterances after close is acknowledged.
    // Keep listening until the final stream has stayed quiet for a bounded span.
    await this.waitForTrailingFinalDrain();
    if (this.currentPartial) {
      this.reportFailure(t("chat.composer.dictationFinalizationTimedOut"));
    }
    this.cleanupEvents();
    return this.finalTranscripts.join(" ").trim();
  }

  async cancel(): Promise<void> {
    this.discarded = true;
    await this.stopCapture();
    await this.startPromise?.catch(() => undefined);
    await this.appendChain;
    await this.closeRemote();
    this.cleanupEvents();
  }

  markGatewayDisconnected(): void {
    // The relay cannot emit another transcript after its transport is gone.
    // Resolving any drain avoids retaining the composer in finalization.
    this.gatewayDisconnected = true;
    this.resolveTrailingFinalDrain();
  }

  private appendAudio(samples: Float32Array): void {
    if (this.closed) {
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
    if (!payload || payload.transcriptionSessionId !== this.transcriptionSessionId || this.closed) {
      return;
    }
    if (payload.type === "partial" && typeof payload.text === "string") {
      this.currentPartial = payload.text.trim();
      this.callbacks.onPartial(this.currentPartial);
      this.resetTrailingFinalDrain();
      return;
    }
    if (payload.type === "transcript" && typeof payload.text === "string") {
      const text = payload.text.trim();
      if (payload.final !== true) {
        this.currentPartial = text;
        this.callbacks.onPartial(text);
        this.resetTrailingFinalDrain();
        return;
      }
      if (text) {
        this.finalTranscripts.push(text);
        this.currentPartial = "";
        this.resetTrailingFinalDrain();
      }
      this.callbacks.onPartial("");
      return;
    }
    if (payload.type === "error") {
      this.reportFailure(
        typeof payload.message === "string" && payload.message.trim()
          ? payload.message.trim()
          : t("chat.composer.dictationFailed"),
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
    this.resolveTrailingFinalDrain();
    this.callbacks.onError(message);
  }

  private async stopCapture(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.abortController.abort();
    this.inputPump.stop();
    this.inputMeter?.stop();
    this.inputMeter = null;
    this.media?.getTracks().forEach((track) => track.stop());
    this.media = null;
    await this.context?.close();
    this.context = null;
  }

  private cleanupEvents(): void {
    this.resolveTrailingFinalDrain();
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
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

  private waitForTrailingFinalDrain(): Promise<void> {
    return new Promise((resolve) => {
      const hasCompleteTranscript = this.finalTranscripts.length > 0 && !this.currentPartial;
      this.trailingFinalDrain = {
        resolve,
        quietTimer: hasCompleteTranscript
          ? globalThis.setTimeout(() => this.resolveTrailingFinalDrain(), FINAL_TRANSCRIPT_QUIET_MS)
          : null,
        maxTimer: globalThis.setTimeout(
          () => this.resolveTrailingFinalDrain(),
          FINAL_TRANSCRIPT_MAX_WAIT_MS,
        ),
      };
    });
  }

  private resetTrailingFinalDrain(): void {
    if (!this.trailingFinalDrain) {
      return;
    }
    if (this.trailingFinalDrain.quietTimer !== null) {
      globalThis.clearTimeout(this.trailingFinalDrain.quietTimer);
    }
    this.trailingFinalDrain.quietTimer = globalThis.setTimeout(
      () => this.resolveTrailingFinalDrain(),
      FINAL_TRANSCRIPT_QUIET_MS,
    );
  }

  private resolveTrailingFinalDrain(): void {
    if (!this.trailingFinalDrain) {
      return;
    }
    if (this.trailingFinalDrain.quietTimer !== null) {
      globalThis.clearTimeout(this.trailingFinalDrain.quietTimer);
    }
    globalThis.clearTimeout(this.trailingFinalDrain.maxTimer);
    this.trailingFinalDrain.resolve();
    this.trailingFinalDrain = null;
  }
}

export class ComposerDictationController {
  readonly inputLevel = new RealtimeTalkLevelSignal();
  private options: ComposerDictationControllerOptions;
  private phase: DictationPhase = "idle";
  private partialTranscript = "";
  private elapsedSeconds = 0;
  private pointerId: number | null = null;
  private pointerTarget: HTMLElement | null = null;
  private pointerBounds: DOMRect | null = null;
  private holdTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private elapsedTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private session: ComposerDictationSession | null = null;
  private suppressClick = false;
  private suppressedPointerId: number | null = null;
  private suppressClickTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
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

  get finalizing(): boolean {
    return this.phase === "stopping";
  }

  get locksComposer(): boolean {
    return this.phase !== "idle";
  }

  get partial(): string {
    return this.partialTranscript;
  }

  get elapsed(): string {
    const minutes = Math.floor(this.elapsedSeconds / 60);
    const seconds = String(this.elapsedSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  update(options: ComposerDictationControllerOptions): void {
    this.options = options;
    if (this.phase === "stopping") {
      return;
    }
    if ((this.phase !== "idle" && !this.canHold()) || (this.active && !options.connected)) {
      const keepFinal = this.active && !options.connected;
      if (keepFinal) {
        this.session?.markGatewayDisconnected();
      }
      void this.stop({ commit: keepFinal });
      if (keepFinal) {
        options.onError(t("chat.composer.dictationDisconnected"));
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
    this.setPhase("holding");
    this.holdTimer = globalThis.setTimeout(() => {
      this.holdTimer = null;
      void this.start();
    }, HOLD_THRESHOLD_MS);
    document.addEventListener("pointermove", this.handleDocumentPointerMove);
    document.addEventListener("pointerup", this.handleDocumentPointerUp);
    document.addEventListener("pointercancel", this.handleDocumentPointerCancel);
    document.addEventListener("pointerup", this.handleSuppressedPointerRelease);
    document.addEventListener("pointercancel", this.handleSuppressedPointerRelease);
    document.addEventListener("keydown", this.handleDocumentKeyDown);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    window.addEventListener("blur", this.handleWindowBlur);
    return true;
  }

  handleClick(event: MouseEvent): void {
    if (this.suppressClick) {
      this.clearClickSuppression();
      event.preventDefault();
      return;
    }
    if (this.phase !== "idle") {
      event.preventDefault();
      return;
    }
    this.options.onTap();
  }

  handleContextMenu(event: MouseEvent): void {
    if (this.phase !== "idle") {
      event.preventDefault();
    }
  }

  dispose(): void {
    this.disposed = true;
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
    if (this.phase === "holding") {
      this.clearGesture();
      this.setPhase("idle");
      this.options.onTap();
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
    this.setPhase("connecting");
    this.startElapsedTimer();
    const session = new ComposerDictationSession(client, {
      onError: (message) => {
        if (this.session !== session) {
          return;
        }
        this.options.onError(message);
        void this.stop({ commit: true });
      },
      onLevel: (level) => this.inputLevel.set(level),
      onPartial: (text) => {
        this.partialTranscript = text;
        this.options.onStateChange();
      },
      onReady: () => {
        if (this.session === session && this.phase === "connecting") {
          this.setPhase("recording");
        }
      },
    });
    this.session = session;
    try {
      await session.start();
    } catch (error) {
      if (this.session !== session || this.disposed || this.isStopping()) {
        return;
      }
      this.options.onError(messageFromError(error));
      await this.stop({ commit: false });
    }
  }

  private async stop(options: { commit: boolean }): Promise<void> {
    if (this.phase === "idle" || this.phase === "stopping") {
      return;
    }
    const wasActive = this.active;
    this.clearGesture();
    this.stopElapsedTimer();
    const session = this.session;
    if (!session) {
      this.reset();
      return;
    }
    this.setPhase("stopping");
    const transcript = options.commit ? await session.finish() : (await session.cancel(), "");
    if (this.session === session) {
      this.session = null;
    }
    if (options.commit && transcript && wasActive && !this.disposed) {
      this.options.onCommit(transcript);
    }
    this.reset();
  }

  private reset(): void {
    this.partialTranscript = "";
    this.elapsedSeconds = 0;
    this.inputLevel.set(0);
    this.setPhase("idle");
  }

  private clearGesture(): void {
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
    document.removeEventListener("keydown", this.handleDocumentKeyDown);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    window.removeEventListener("blur", this.handleWindowBlur);
  }

  private startElapsedTimer(): void {
    this.elapsedSeconds = 0;
    this.elapsedTimer = globalThis.setInterval(() => {
      this.elapsedSeconds += 1;
      this.options.onStateChange();
    }, 1000);
  }

  private stopElapsedTimer(): void {
    if (this.elapsedTimer !== null) {
      globalThis.clearInterval(this.elapsedTimer);
      this.elapsedTimer = null;
    }
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
    this.phase = phase;
    this.options.onStateChange();
  }
}
