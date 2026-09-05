import { REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME } from "../../../../src/talk/describe-view-tool.js";
import { formatUiError } from "../../lib/format-error.ts";
import {
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME,
  submitRealtimeTalkAgentControl,
  submitRealtimeTalkConsult,
  type RealtimeTalkEventInput,
  type RealtimeTalkTransportContext,
} from "./realtime-talk-shared.ts";

const GOOGLE_LIVE_MAX_PENDING_TOOL_CALLS = 1_024;
const GOOGLE_LIVE_MAX_TOOL_CALL_IDS = 1_024;

type GoogleLivePendingToolCall = {
  name: string;
  cancelled: boolean;
};

export type GoogleLiveFunctionCall = {
  id?: string;
  name?: string;
  args?: unknown;
};

type GoogleLiveToolOwnerOptions = {
  ctx: RealtimeTalkTransportContext;
  emitTalkEvent: (input: RealtimeTalkEventInput) => void;
  isClosed: () => boolean;
  failConnection: (detail: string) => void;
  isDescribeViewActive: () => boolean;
  sendResult: (callId: string, name: string, result: unknown) => void;
  sendControlSpeechMessage: (message: string) => void;
  stopOutputForSuppressedControl: (result: unknown) => void;
};

export class GoogleLiveToolOwner {
  private readonly pendingCalls = new Map<string, GoogleLivePendingToolCall>();
  private readonly seenCallIds = new Set<string>();
  private readonly abortControllers = new Map<string, AbortController>();

  constructor(private readonly options: GoogleLiveToolOwnerOptions) {}

  release(): void {
    const abortControllers = [...this.abortControllers.values()];
    this.abortControllers.clear();
    this.pendingCalls.clear();
    this.seenCallIds.clear();
    for (const controller of abortControllers) {
      controller.abort();
    }
  }

  hasPendingConsult(): boolean {
    for (const call of this.pendingCalls.values()) {
      if (!call.cancelled && call.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
        return true;
      }
    }
    return false;
  }

  async handleCall(call: GoogleLiveFunctionCall): Promise<void> {
    if (this.options.isClosed()) {
      return;
    }
    const name = call.name?.trim();
    const callId = call.id?.trim();
    if (!name || !callId || this.seenCallIds.has(callId)) {
      return;
    }
    // Google exposes no replay window. Eviction could re-execute a very late
    // duplicate, so the session fails closed when lifetime ownership is full.
    if (this.seenCallIds.size >= GOOGLE_LIVE_MAX_TOOL_CALL_IDS) {
      this.options.failConnection("Google Live tool-call session limit exceeded");
      return;
    }
    if (this.pendingCalls.size >= GOOGLE_LIVE_MAX_PENDING_TOOL_CALLS) {
      this.options.failConnection("Google Live pending tool-call limit exceeded");
      return;
    }
    this.seenCallIds.add(callId);
    this.pendingCalls.set(callId, { name, cancelled: false });

    if (!this.isSupportedTool(name)) {
      const message = `Tool "${name}" is not available in browser Talk`;
      if (!this.submitResult(callId, { error: message })) {
        return;
      }
      this.options.emitTalkEvent({
        type: "tool.error",
        callId,
        final: true,
        payload: { name, message },
      });
      return;
    }

    this.options.emitTalkEvent({
      type: "tool.call",
      callId,
      payload: { name, args: call.args ?? {} },
    });
    if (name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME) {
      await this.runControl(callId, call.args);
      return;
    }
    if (name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME) {
      this.submitDescribeView(callId);
      return;
    }
    await this.runConsult(callId, call.args);
  }

  cancel(ids: string[] | undefined): void {
    for (const rawId of ids ?? []) {
      const callId = rawId.trim();
      const call = this.pendingCalls.get(callId);
      if (!callId || !call || call.cancelled) {
        continue;
      }
      call.cancelled = true;
      const abortController = this.abortControllers.get(callId);
      if (abortController) {
        abortController.abort();
      } else {
        this.pendingCalls.delete(callId);
      }
    }
  }

  private isSupportedTool(name: string): boolean {
    return (
      name === REALTIME_VOICE_AGENT_CONTROL_TOOL_NAME ||
      name === REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME ||
      name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME
    );
  }

  private async runControl(callId: string, args: unknown): Promise<void> {
    const abortController = this.startExecution(callId);
    try {
      await submitRealtimeTalkAgentControl({
        ctx: this.createActiveContext(),
        callId,
        args: args ?? {},
        signal: abortController.signal,
        emitTalkEvent: this.options.emitTalkEvent,
        submit: (toolCallId, result) => {
          this.submitResult(toolCallId, result);
        },
      });
    } finally {
      this.finishExecution(callId, abortController);
    }
  }

  private submitDescribeView(callId: string): void {
    const active = this.options.isDescribeViewActive();
    if (
      !this.submitResult(
        callId,
        active ? { ok: true, cameraStreamActive: true } : { ok: false, error: "camera is off" },
      )
    ) {
      return;
    }
    this.options.emitTalkEvent({
      type: active ? "tool.result" : "tool.error",
      callId,
      final: true,
      payload: {
        name: REALTIME_VOICE_DESCRIBE_VIEW_TOOL_NAME,
        cameraStreamActive: active,
      },
    });
  }

  private async runConsult(callId: string, args: unknown): Promise<void> {
    const abortController = this.startExecution(callId);
    try {
      await submitRealtimeTalkConsult({
        ctx: this.createActiveContext(),
        callId,
        args: args ?? {},
        signal: abortController.signal,
        submitAbortResult: false,
        emitTalkEvent: this.options.emitTalkEvent,
        submit: (toolCallId, result) => {
          this.submitResult(toolCallId, result);
        },
      });
    } finally {
      this.finishExecution(callId, abortController);
    }
  }

  private createActiveContext(): RealtimeTalkTransportContext {
    const { ctx } = this.options;
    return {
      ...ctx,
      callbacks: {
        onStatus: (status, detail) => {
          if (!this.options.isClosed()) {
            ctx.callbacks.onStatus?.(status, detail);
          }
        },
        onTranscript: (entry) => {
          if (!this.options.isClosed()) {
            ctx.callbacks.onTranscript?.(entry);
          }
        },
        onTalkEvent: (event) => {
          if (!this.options.isClosed()) {
            ctx.callbacks.onTalkEvent?.(event);
          }
        },
      },
    };
  }

  private submitResult(callId: string, result: unknown): boolean {
    const call = this.pendingCalls.get(callId);
    if (!call || call.cancelled) {
      return false;
    }
    try {
      this.options.sendResult(callId, call.name, result);
    } catch (error) {
      this.options.failConnection(formatUiError(error));
      return false;
    }
    this.pendingCalls.delete(callId);
    return true;
  }

  private startExecution(callId: string): AbortController {
    const abortController = new AbortController();
    this.abortControllers.set(callId, abortController);
    return abortController;
  }

  private finishExecution(callId: string, abortController: AbortController): void {
    if (this.abortControllers.get(callId) === abortController) {
      this.abortControllers.delete(callId);
    }
    const call = this.pendingCalls.get(callId);
    if (!call?.cancelled) {
      return;
    }
    this.pendingCalls.delete(callId);
    if (
      call.name === REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME &&
      !this.options.isClosed() &&
      !this.hasPendingConsult()
    ) {
      this.options.ctx.callbacks.onStatus?.("listening");
    }
  }
}
