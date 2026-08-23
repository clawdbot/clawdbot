import { formatErrorMessage, toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { RealtimeVoiceAgentConsultRunner } from "openclaw/plugin-sdk/realtime-voice";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { RawData } from "ws";
import {
  buildOpenAIQuicksilverDelegationPrompt,
  type OpenAIQuicksilverTranscriptEntry,
} from "./realtime-quicksilver-instructions.js";
import type { OpenAIQuicksilverSocket } from "./realtime-quicksilver-sideband.js";
import {
  boundOpenAIQuicksilverContextItems,
  boundOpenAIQuicksilverDelegationResult,
  chunkOpenAIQuicksilverAppendText,
  parseOpenAIQuicksilverEvent,
  type OpenAIQuicksilverInboundEvent,
} from "./realtime-quicksilver-wire.js";

const WEBSOCKET_OPEN = 1;
const CONSULT_FAILURE_TEXT =
  "The agent task failed. Tell the user it did not complete and offer to try again.";

type PendingDelegation = {
  id: string;
  prompt: string;
};

type OpenAIQuicksilverDelegationControllerOptions = {
  getSocket: () => OpenAIQuicksilverSocket | undefined;
  isCanceledError?: (error: unknown) => boolean;
  logger: Pick<PluginLogger, "debug" | "warn">;
  onFatalError: (error: Error) => void;
  onSessionStarted?: (expiresAt: number | undefined) => void;
  onTranscript?: (role: "user" | "assistant", text: string, done: boolean) => void;
  onWireEventType?: (eventType: string) => void;
  runAgentConsult: RealtimeVoiceAgentConsultRunner;
  signal: AbortSignal;
};

function shortFailureReason(error: unknown): string {
  return formatErrorMessage(error).replaceAll(/\s+/g, " ").trim().slice(0, 180) || "unknown error";
}

function readWireEventType(payload: string): string | undefined {
  try {
    const decoded = JSON.parse(payload) as Record<string, unknown>;
    return typeof decoded.type === "string" ? decoded.type : undefined;
  } catch {
    return undefined;
  }
}

/** Owns the provider's single active delegation and its once-consumed transcript context. */
export class OpenAIQuicksilverDelegationController {
  private activeDelegationId: string | undefined;
  private consultController: AbortController | undefined;
  private readonly onSessionAbort = () => {
    const reason = this.options.signal.reason;
    this.stop(reason instanceof Error ? reason : new Error("GPT-Live session stopped"));
  };
  private partialTranscriptRole: "user" | "assistant" | undefined;
  private pendingDelegation: PendingDelegation | undefined;
  private stopped = false;
  private transcript: OpenAIQuicksilverTranscriptEntry[] = [];

  constructor(private readonly options: OpenAIQuicksilverDelegationControllerOptions) {
    if (options.signal.aborted) {
      this.onSessionAbort();
    } else {
      options.signal.addEventListener("abort", this.onSessionAbort, { once: true });
    }
  }

  handleFrame(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.fail(new Error("OpenAI GPT-Live sideband returned an unexpected binary frame"));
      return;
    }
    const payload = rawDataToString(data);
    if (this.options.onWireEventType) {
      const eventType = readWireEventType(payload);
      if (eventType) {
        this.options.onWireEventType(eventType);
      }
    }
    const event = parseOpenAIQuicksilverEvent(payload);
    if (event) {
      this.handleEvent(event);
    }
  }

  handleEvent(event: OpenAIQuicksilverInboundEvent): void {
    if (this.stopped || event.kind === "ignored") {
      return;
    }
    if (event.kind === "unknown") {
      this.options.logger.debug?.(`OpenAI GPT-Live ignored sideband event: ${event.eventType}`);
      return;
    }
    if (event.kind === "session-started") {
      this.options.onSessionStarted?.(event.expiresAt);
      return;
    }
    if (event.kind === "transcript-delta" || event.kind === "transcript-done") {
      this.appendTranscript(event);
      this.options.onTranscript?.(event.role, event.text, event.kind === "transcript-done");
      return;
    }
    if (event.kind === "error") {
      const error = new Error(`OpenAI GPT-Live sideband error: ${event.message}`);
      this.options.logger.warn(error.message);
      if (event.fatalAuth) {
        this.options.onFatalError(error);
      }
      return;
    }
    // Both consumers negotiate audio over WebRTC; sideband audio would duplicate it.
    if (event.kind === "audio") {
      return;
    }
    this.startDelegation(event.id, event.prompt);
  }

  sendToActiveDelegation(text: string, channel: "speakable" | "commentary"): void {
    const content = text.trim();
    if (this.activeDelegationId && content) {
      this.sendAppend(this.activeDelegationId, content, channel);
    }
  }

  stop(reason: Error): void {
    if (this.stopped) {
      return;
    }
    this.markStopped();
    this.consultController?.abort(reason);
    this.consultController = undefined;
  }

  /** Releases sideband ownership without canceling work already accepted by the host. */
  detach(): void {
    if (this.stopped) {
      return;
    }
    this.markStopped();
  }

  private appendTranscript(
    event: Extract<OpenAIQuicksilverInboundEvent, { kind: "transcript-delta" | "transcript-done" }>,
  ): void {
    const last = this.transcript.at(-1);
    if (event.kind === "transcript-delta") {
      if (last?.role === event.role && this.partialTranscriptRole === event.role) {
        last.text += event.text;
      } else {
        this.transcript.push({ role: event.role, text: event.text });
      }
      this.partialTranscriptRole = event.role;
    } else {
      if (last?.role === event.role && this.partialTranscriptRole === event.role) {
        last.text = event.text;
      } else {
        this.transcript.push({ role: event.role, text: event.text });
      }
      this.partialTranscriptRole = undefined;
    }
    this.transcript = boundOpenAIQuicksilverContextItems(this.transcript);
  }

  private startDelegation(id: string, input: string): void {
    if (this.stopped || this.options.signal.aborted || !input.trim()) {
      return;
    }
    // Transcript is a once-delivered delta. Empty delegations must not consume it.
    const transcript = this.transcript;
    this.transcript = [];
    this.partialTranscriptRole = undefined;
    const delegation = {
      id,
      prompt: buildOpenAIQuicksilverDelegationPrompt({ input, transcript }),
    };
    this.activeDelegationId = id;
    if (this.consultController) {
      // Frameless bidi has one active handoff: retain only the newest queued request.
      this.pendingDelegation = delegation;
      this.consultController.abort(new Error("GPT-Live delegation superseded"));
      return;
    }
    this.launchDelegation(delegation);
  }

  private launchDelegation(delegation: PendingDelegation): void {
    if (this.stopped || this.options.signal.aborted) {
      return;
    }
    const controller = new AbortController();
    this.consultController = controller;
    this.activeDelegationId = delegation.id;
    void this.runDelegation(delegation, controller.signal)
      .catch((error: unknown) =>
        this.fail(toErrorObject(error, "OpenAI GPT-Live delegation failed")),
      )
      .finally(() => {
        if (this.consultController !== controller) {
          return;
        }
        this.consultController = undefined;
        const pending = this.pendingDelegation;
        this.pendingDelegation = undefined;
        if (pending) {
          this.launchDelegation(pending);
        } else {
          this.activeDelegationId = undefined;
        }
      });
  }

  private markStopped(): void {
    this.stopped = true;
    this.options.signal.removeEventListener("abort", this.onSessionAbort);
    this.pendingDelegation = undefined;
    this.activeDelegationId = undefined;
    this.partialTranscriptRole = undefined;
    this.transcript = [];
  }

  private async runDelegation(delegation: PendingDelegation, signal: AbortSignal): Promise<void> {
    let text: string;
    try {
      const result = await this.options.runAgentConsult({ prompt: delegation.prompt, signal });
      if (signal.aborted) {
        return;
      }
      text = boundOpenAIQuicksilverDelegationResult(result.text);
    } catch (error) {
      // Host steering can reject with an abort marker outside this controller's own signal.
      if (signal.aborted || this.options.isCanceledError?.(error)) {
        return;
      }
      this.options.logger.warn(
        `OpenAI GPT-Live delegation consult failed: ${shortFailureReason(error)}`,
      );
      text = CONSULT_FAILURE_TEXT;
    }
    this.sendAppend(delegation.id, text, "speakable");
  }

  private sendAppend(
    delegationId: string,
    text: string,
    channel: "speakable" | "commentary",
  ): void {
    const socket = this.options.getSocket();
    if (this.stopped || !socket || socket.readyState !== WEBSOCKET_OPEN) {
      return;
    }
    for (const chunk of chunkOpenAIQuicksilverAppendText(text)) {
      socket.send(
        JSON.stringify({
          type: "delegation.context.append",
          delegation_item_id: delegationId,
          channel,
          content: [{ type: "input_text", text: chunk }],
        }),
      );
    }
  }

  private fail(error: Error): void {
    if (this.stopped) {
      return;
    }
    this.options.logger.warn(error.message);
    this.options.onFatalError(error);
  }
}
