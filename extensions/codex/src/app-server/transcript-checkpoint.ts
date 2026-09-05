import {
  embeddedAgentLog,
  formatErrorMessage,
  projectAgentHarnessTranscriptMessageForDisplay,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { applyCodexTranscriptTaint } from "./transcript-mirror-attestation.js";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import { attachCodexMirrorIdentity } from "./upstream-prompt-provenance.js";

export type CodexTranscriptCheckpointEntry = {
  read: () => AgentMessage | undefined;
  ready?: () => boolean;
};

/** Commits completed work in receipt order without waiting for the enclosing turn. */
export class CodexTranscriptCheckpoint {
  private readonly pending: CodexTranscriptCheckpointEntry[] = [];
  private readonly commentaryItemIds = new Set<string>();
  private lastTimestamp = 0;
  private writing = Promise.resolve();
  private tainted = false;
  private closed = false;

  constructor(
    private readonly params: EmbeddedRunAttemptParamsV2,
    private readonly threadId: string,
    private readonly turnId: string,
  ) {}

  nextTimestamp = (): number => {
    // Commentary and tool mirrors share this clock so equal wall-clock values
    // still preserve the app-server receipt order in the durable transcript.
    this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1);
    return this.lastTimestamp;
  };

  enqueueCommentary = (itemId: string, entry: CodexTranscriptCheckpointEntry): void => {
    if (
      this.params.config?.ui?.prefs?.chatPersistCommentary === false ||
      this.commentaryItemIds.has(itemId)
    ) {
      return;
    }
    this.commentaryItemIds.add(itemId);
    this.enqueue({
      ...entry,
      read: () => {
        const message = entry.read();
        return message
          ? attachCodexMirrorIdentity(message, `${this.turnId}:commentary:${itemId}`)
          : undefined;
      },
    });
  };

  enqueue = (entry: CodexTranscriptCheckpointEntry): void => {
    if (this.params.sessionTarget && !this.closed) {
      this.pending.push(entry);
    }
  };

  flush(close = false): Promise<void> {
    if (this.closed) {
      return this.writing;
    }
    this.closed = close;
    this.writing = this.writing.then(async () => {
      // An unfinished commentary item or linked raw patch output owns its place
      // in history. Later work cannot overtake it; teardown records what arrived.
      const blocked = close ? -1 : this.pending.findIndex((entry) => entry.ready?.() === false);
      const count = blocked < 0 ? this.pending.length : blocked;
      if (count === 0) {
        return;
      }
      const taint = { tainted: this.tainted };
      const messages = this.pending.slice(0, count).flatMap((entry) => {
        const message = entry.read();
        return message
          ? [
              projectAgentHarnessTranscriptMessageForDisplay({
                hidden: this.params.trigger === "memory",
                message: applyCodexTranscriptTaint(message, taint),
              }),
            ]
          : [];
      });
      try {
        await codexTranscriptMirrorRuntime.mirror({
          ...this.params.sessionTarget,
          sessionId: this.params.sessionId,
          cwd: this.params.workspaceDir,
          messages,
          idempotencyScope: `codex-app-server:${this.threadId}`,
          runId: this.params.runId,
          runMirrorIdentityPrefix: `${this.turnId}:`,
          config: this.params.config,
        });
        this.pending.splice(0, count);
        this.tainted = taint.tainted;
      } catch (error) {
        // Keep the pending prefix for the next observed boundary/final mirror.
        // Persistence failure must not turn completed tool work into a retry.
        embeddedAgentLog.warn("failed to checkpoint codex app-server transcript", {
          runId: this.params.runId,
          sessionId: this.params.sessionId,
          error: formatErrorMessage(error),
        });
      }
    });
    return this.writing;
  }
}
