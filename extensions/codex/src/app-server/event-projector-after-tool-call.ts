import {
  runAgentHarnessAfterToolCallHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { asDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  itemName,
  itemStatus,
  shouldSynthesizeToolProgressForItem,
} from "./event-projector-items.js";
import type { CodexAppServerEventProjectorOptions } from "./event-projector-options.js";
import {
  isNativePostToolUseRelayItem,
  itemToolArgs,
  itemToolError,
  itemToolResult,
} from "./event-projector-tool-items.js";
import type { CodexToolProgressProjection } from "./event-projector-tool-progress.js";
import type { CodexThreadItem } from "./protocol.js";

export class CodexAfterToolCallProjection {
  private readonly observedItemIds = new Set<string>();
  private readonly pendingFileChanges = new Map<string, CodexThreadItem>();

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly progress: CodexToolProgressProjection,
    private readonly options: CodexAppServerEventProjectorOptions = {},
  ) {}

  emit(item: CodexThreadItem): void {
    if (
      item.type === "fileChange" &&
      this.options.nativePostToolUseRelayEnabled &&
      !this.observedItemIds.has(item.id)
    ) {
      const coverage =
        this.options.resolveNativeFileChangeAfterToolCallCoverage?.(item.id) ?? "pending";

      if (coverage === "native_apply_patch") {
        this.observedItemIds.add(item.id);
        return;
      }

      if (coverage === "pending") {
        this.pendingFileChanges.set(item.id, item);
        return;
      }
    }

    this.emitNow(item);
  }

  settlePendingFileChanges(options?: { finalize?: boolean }): void {
    for (const [itemId, item] of this.pendingFileChanges) {
      const coverage =
        this.options.resolveNativeFileChangeAfterToolCallCoverage?.(itemId) ?? "pending";

      if (coverage === "native_apply_patch") {
        this.observedItemIds.add(itemId);
        this.pendingFileChanges.delete(itemId);
        continue;
      }

      if (coverage === "intercepted" || options?.finalize === true) {
        this.pendingFileChanges.delete(itemId);
        this.emitNow(item);
      }
    }
  }

  private emitNow(item: CodexThreadItem): void {
    if (!this.shouldEmit(item)) {
      return;
    }

    const name = itemName(item);
    const status = itemStatus(item);
    if (!name || status === "running") {
      return;
    }

    this.observedItemIds.add(item.id);
    const result = itemToolResult(item).result;
    const error =
      this.progress.approvalTimeoutExplanation(item.id, status) ??
      itemToolError(item, status, this.progress.outputTextByItem);
    const startedAt = resolveStartedAtFromDurationMs(item.durationMs);
    const hookParams = {
      toolName: name,
      toolCallId: item.id,
      runId: this.params.runId,
      agentId: this.params.agentId,
      sessionId: this.params.sessionId,
      sessionKey: this.params.sessionKey,
      startArgs: itemToolArgs(item) ?? {},
      ...(result !== undefined ? { result } : {}),
      ...(error ? { error } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
    };

    setImmediate(() => {
      void runAgentHarnessAfterToolCallHook(hookParams);
    });
  }

  private shouldEmit(item: CodexThreadItem): boolean {
    if (!shouldSynthesizeToolProgressForItem(item) || this.observedItemIds.has(item.id)) {
      return false;
    }
    if (!this.options.nativePostToolUseRelayEnabled || item.type === "fileChange") {
      return true;
    }
    return !isNativePostToolUseRelayItem(item);
  }
}

function resolveStartedAtFromDurationMs(durationMs: unknown): number | undefined {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs)) {
    return undefined;
  }
  return asDateTimestampMs(Date.now() - Math.max(0, durationMs));
}
