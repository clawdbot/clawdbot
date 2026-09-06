import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import type { DiscordVoiceIngressContext } from "./ingress.js";
import type { DiscordVoiceAudioReceipt, DiscordVoiceSegmentOutcome } from "./recording-types.js";
import type { VoiceRealtimeSpeakerTurn } from "./session.js";

const MAX_PENDING_CONVERSATIONS = 8;
// Encoded packet limits do not bound the decoded audio waiting for authorization.
const MAX_PENDING_CONVERSATION_AUDIO_BYTES = 1024 * 1024;
const MAX_CONVERSATION_TEXT_BYTES = 1024 * 1024;
const MAX_CONVERSATION_SEGMENTS = 1_000;

type ConversationParams = {
  authorize: () => Promise<DiscordVoiceIngressContext | null>;
  isCurrent: () => boolean;
  canAdmit: () => boolean;
  createTurn?: (context: DiscordVoiceIngressContext) => VoiceRealtimeSpeakerTurn;
  warn: (message: string) => void;
};

class DiscordVoiceConversationInput {
  private readonly cancelled = createDeferred<void>();
  private state: "pending" | "admitted" | "retired" = "pending";
  private context: DiscordVoiceIngressContext | null = null;
  private turn: VoiceRealtimeSpeakerTurn | undefined;
  private audio: Array<{ pcm: Buffer; receipt?: DiscordVoiceAudioReceipt }> = [];
  private pendingAudioBytes = 0;
  private text: string[] = [];
  private textBytes = 0;
  private segments: Promise<boolean>[] = [];
  private authorizationQueue: Promise<void> = Promise.resolve();
  readonly ready: Promise<void>;

  constructor(private readonly params: ConversationParams) {
    const admission = (async () => {
      const context = await params.authorize();
      if (this.state === "retired") {
        return;
      }
      if (!context || !params.isCurrent() || !params.canAdmit()) {
        this.retire();
        return;
      }
      this.turn = params.createTurn?.(context);
      this.context = context;
      this.state = "admitted";
      const audio = this.audio;
      this.audio = [];
      this.pendingAudioBytes = 0;
      for (const { pcm, receipt } of audio) {
        this.sendAudio(pcm, receipt);
      }
    })().catch((error: unknown) => {
      this.retire();
      params.warn(`discord voice: conversation admission failed: ${formatErrorMessage(error)}`);
    });
    this.ready = Promise.race([admission, this.cancelled.promise]);
  }

  get ingress(): DiscordVoiceIngressContext | null {
    return this.state === "admitted" && this.params.isCurrent() ? this.context : null;
  }

  get retired(): boolean {
    return this.state === "retired";
  }

  sendAudio(pcm: Buffer, receipt?: DiscordVoiceAudioReceipt): void {
    if (this.state === "retired") {
      return;
    }
    if (!this.params.isCurrent()) {
      this.retire();
      return;
    }
    if (this.state === "pending") {
      if (pcm.length > MAX_PENDING_CONVERSATION_AUDIO_BYTES - this.pendingAudioBytes) {
        this.params.warn(
          "discord voice: conversation audio backlog exceeded; recording continues, but speak again for a conversation response.",
        );
        this.retire();
        return;
      }
      this.pendingAudioBytes += pcm.length;
      if (this.params.createTurn) {
        this.audio.push({ pcm: Buffer.from(pcm), receipt });
      }
      return;
    }
    try {
      this.turn?.sendInputAudio(pcm, receipt);
    } catch (error) {
      this.retire();
      this.params.warn(`discord voice: conversation audio failed: ${formatErrorMessage(error)}`);
    }
  }

  authorizeSegment(
    resolve: () => Promise<DiscordVoiceIngressContext | null>,
  ): Promise<DiscordVoiceIngressContext | null> {
    const permission = this.authorizationQueue
      .then(async () => {
        await this.ready;
        if (!this.ingress) {
          return null;
        }
        const context = await Promise.race([resolve(), this.cancelled.promise.then(() => null)]);
        if (!context || !this.params.isCurrent()) {
          this.retire();
          return null;
        }
        return context;
      })
      .catch((error: unknown) => {
        this.retire();
        throw error;
      });
    this.authorizationQueue = permission.then(
      () => undefined,
      () => undefined,
    );
    return permission;
  }

  addSegment(result: Promise<DiscordVoiceSegmentOutcome>): void {
    if (this.state === "retired") {
      return;
    }
    if (this.segments.length >= MAX_CONVERSATION_SEGMENTS) {
      this.params.warn(
        "discord voice: conversation transcript limit exceeded; recording continues, but speak a shorter request for a conversation response.",
      );
      this.retire();
      return;
    }
    const index = this.text.length;
    this.text.push("");
    const completed = result.then(async (outcome) => {
      if (this.state === "retired") {
        return false;
      }
      if (outcome.status === "excluded" || outcome.status === "unavailable") {
        this.retire();
        return false;
      }
      const text = outcome.status === "transcribed" ? outcome.text : "";
      const bytes = Buffer.byteLength(text);
      if (bytes > MAX_CONVERSATION_TEXT_BYTES - this.textBytes) {
        this.params.warn(
          "discord voice: conversation transcript limit exceeded; recording continues, but speak a shorter request for a conversation response.",
        );
        this.retire();
        return false;
      }
      this.textBytes += bytes;
      this.text[index] = text;
      const allowed = await outcome.conversationAuthorized;
      if (!allowed) {
        this.retire();
      }
      return allowed;
    });
    this.segments.push(Promise.race([completed, this.cancelled.promise.then(() => false)]));
  }

  async transcript(): Promise<string | undefined> {
    await this.ready;
    await Promise.all(this.segments);
    return this.ingress ? this.text.filter(Boolean).join("\n") || undefined : undefined;
  }

  async finishAudio(): Promise<void> {
    await this.ready;
    this.turn?.close();
    this.turn = undefined;
  }

  retire(): void {
    if (this.state === "retired") {
      return;
    }
    this.state = "retired";
    this.context = null;
    this.audio = [];
    this.text = [];
    this.segments = [];
    const turn = this.turn;
    this.turn = undefined;
    // Revoke authority and release waiters before provider teardown can call back or throw.
    this.cancelled.resolve();
    try {
      turn?.close("incomplete-input");
    } catch (error) {
      this.params.warn(`discord voice: conversation close failed: ${formatErrorMessage(error)}`);
    }
  }
}

export class DiscordVoiceConversationQueue {
  private readonly inputs = new Set<DiscordVoiceConversationInput>();
  private queue: Promise<void> = Promise.resolve();
  private stopped = false;

  start(params: ConversationParams): DiscordVoiceConversationInput | undefined {
    if (this.stopped || this.inputs.size >= MAX_PENDING_CONVERSATIONS) {
      params.warn("discord voice: conversation is busy; recording continues.");
      return undefined;
    }
    const input = new DiscordVoiceConversationInput(params);
    this.inputs.add(input);
    return input;
  }

  enqueue(input: DiscordVoiceConversationInput, task: () => Promise<void>): Promise<void> {
    const completion = this.queue
      .then(async () => {
        if (this.inputs.has(input) && !input.retired) {
          await task();
        }
      })
      .finally(() => this.release(input));
    this.queue = completion.catch(() => undefined);
    return completion;
  }

  finishAudio(input: DiscordVoiceConversationInput): Promise<void> {
    return input.finishAudio().finally(() => this.release(input));
  }

  release(input: DiscordVoiceConversationInput): void {
    input.retire();
    this.inputs.delete(input);
  }

  close(): void {
    this.stopped = true;
    for (const input of this.inputs) {
      input.retire();
    }
    this.inputs.clear();
  }
}
