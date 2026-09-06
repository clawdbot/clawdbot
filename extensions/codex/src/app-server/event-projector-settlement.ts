import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { CodexTurn } from "./protocol.js";

type PresentationStage =
  | "onAssistantMessageStart"
  | "onPartialReply"
  | "onReasoningStream"
  | "onReasoningEnd";

export class CodexProjectionSettlement {
  readonly params: EmbeddedRunAttemptParams;
  terminalReceipt: CodexTurn | undefined;
  turnTainted = false;
  private stage: string | undefined;
  private readonly pending = new Map<Promise<void>, PresentationStage>();

  constructor(params: EmbeddedRunAttemptParams, isActive: () => boolean) {
    const detach = <Args extends unknown[]>(
      stage: PresentationStage,
      callback: ((...args: Args) => unknown) | undefined,
    ): ((...args: Args) => void) | undefined =>
      callback
        ? (...args) => {
            if (!isActive()) {
              return;
            }
            // Reserve before invocation so reentrant callbacks retain source order.
            // Only presentation detaches; the terminal owner joins these promises.
            const completion = createDeferred<void>();
            this.pending.set(completion.promise, stage);
            const settled = () => {
              this.pending.delete(completion.promise);
              completion.resolve();
            };
            const failed = (error: unknown) => {
              embeddedAgentLog.warn(`codex app-server ${stage} callback failed: ${String(error)}`);
              settled();
            };
            try {
              void Promise.resolve(callback(...args)).then(settled, failed);
            } catch (error) {
              failed(error);
            }
          }
        : undefined;
    this.params = {
      ...params,
      onAssistantMessageStart: detach("onAssistantMessageStart", params.onAssistantMessageStart),
      onPartialReply: detach("onPartialReply", params.onPartialReply),
      onReasoningStream: detach("onReasoningStream", params.onReasoningStream),
      onReasoningEnd: detach("onReasoningEnd", params.onReasoningEnd),
    };
  }

  get pendingStage(): string | undefined {
    return this.stage ?? this.pending.values().next().value;
  }

  get completedAnswer() {
    const turn = this.terminalReceipt;
    // Codex 0.153.0 turn/completed carries the last assistant item as a summary.
    const answer = turn?.items?.findLast(
      (item) =>
        item.type === "agentMessage" &&
        item.phase !== "commentary" &&
        item.delivery !== "async" &&
        typeof item.text === "string" &&
        item.text.trim().length > 0,
    );
    return turn?.status === "completed" && answer ? { turn, answer } : undefined;
  }

  async project<T>(stage: string, project: () => Promise<T>): Promise<T> {
    const previous = this.stage;
    this.stage = stage;
    try {
      return await project();
    } finally {
      this.stage = previous;
    }
  }

  async drain(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all(this.pending.keys());
    }
  }
}
