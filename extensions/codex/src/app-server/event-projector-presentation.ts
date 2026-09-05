import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { redactCodexEventKind } from "./event-projector-diagnostics.js";

export class CodexPresentationCallbacks {
  private readonly pending = new Set<Promise<void>>();
  readonly params: EmbeddedRunAttemptParams;

  constructor(
    params: EmbeddedRunAttemptParams,
    private readonly isClosed: () => boolean | undefined,
  ) {
    this.params = {
      ...params,
      onAssistantMessageStart: this.track(params.onAssistantMessageStart),
      onPartialReply: this.track(params.onPartialReply),
      onReasoningStream: this.track(params.onReasoningStream),
      onReasoningEnd: this.track(params.onReasoningEnd),
    };
  }

  private track<Args extends unknown[]>(
    callback: ((...args: Args) => unknown) | undefined,
  ): ((...args: Args) => void) | undefined {
    if (!callback) {
      return undefined;
    }
    return (...args) => {
      if (this.isClosed()) {
        return;
      }
      // Invoke in native event order, but let channel owners coalesce previews
      // while transport is pending. Settlement owns every accepted callback.
      const pending = (async () => {
        try {
          await callback(...args);
        } catch (error) {
          if (!this.isClosed()) {
            embeddedAgentLog.warn("codex app-server presentation callback failed", {
              runId: this.params.runId,
              error: redactCodexEventKind(String(error)).slice(0, 500),
            });
          }
        }
      })();
      this.pending.add(pending);
      void pending.then(() => this.pending.delete(pending));
    };
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending);
    }
  }
}
