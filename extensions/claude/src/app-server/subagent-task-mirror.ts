/**
 * Mirrors the bridge's `subagentActivity` progress signal into an OpenClaw
 * task record, so a native Claude subagent (SDK Agent/Task tool) shows up as
 * real, observable work instead of a silent gap.
 *
 * Deliberately much simpler than Codex's native-subagent-monitor.ts /
 * native-subagent-task-mirror.ts: Codex's native subagents run as genuinely
 * separate app-server threads (their own thread id, independently
 * resumable/recoverable across a JSON-RPC boundary), so that monitor has to
 * solve cross-process discovery and recovery. A Claude native subagent runs
 * INSIDE the same SDK subprocess as the parent turn (see CLAUDE.md's "native
 * Codex" analogy and turn-runner.ts's createSubagentActivityEmitter) — there
 * is no separate thread to discover, and the signal is a single boolean
 * "a subagent is running right now" rather than a lifecycle with its own
 * completion payload. So this mirror only tracks one state transition per
 * turn: activity started -> activity stopped (real progress resumed, or the
 * turn itself settled while a subagent was still active).
 */

import type { AgentHarnessTaskRuntime } from "openclaw/plugin-sdk/agent-harness-task-runtime";

export const CLAUDE_NATIVE_SUBAGENT_RUNTIME = "subagent";
export const CLAUDE_NATIVE_SUBAGENT_TASK_KIND = "claude-native";
export const CLAUDE_NATIVE_SUBAGENT_RUN_ID_PREFIX = "claude-subagent:";

/** Minimal task-runtime surface this mirror needs. */
export type ClaudeSubagentTaskLifecycleRuntime = Pick<
  AgentHarnessTaskRuntime,
  "tryCreateRunningTaskRun" | "finalizeTaskRunByRunId"
>;

export type ClaudeSubagentTaskMirrorParams = {
  threadId: string;
  turnId: string;
  agentId?: string;
  now?: () => number;
};

export function claudeNativeSubagentRunId(threadId: string, turnId: string): string {
  return `${CLAUDE_NATIVE_SUBAGENT_RUN_ID_PREFIX}${threadId}:${turnId}`;
}

export class ClaudeNativeSubagentTaskMirror {
  private readonly runId: string;
  private readonly now: () => number;
  private active = false;
  private failedToCreate = false;

  constructor(
    private readonly params: ClaudeSubagentTaskMirrorParams,
    private readonly runtime: ClaudeSubagentTaskLifecycleRuntime,
  ) {
    this.runId = claudeNativeSubagentRunId(params.threadId, params.turnId);
    this.now = params.now ?? Date.now;
  }

  /** True while a task run is currently open for this turn's subagent activity. */
  isActive(): boolean {
    return this.active;
  }

  /** Call on each `turn/progress {kind:"subagentActivity"}` pulse. Idempotent while already active. */
  noteActivity(): void {
    if (this.active || this.failedToCreate) {
      return;
    }
    const eventAt = this.now();
    const taskRecord = this.runtime.tryCreateRunningTaskRun({
      sourceId: this.runId,
      agentId: this.params.agentId,
      runId: this.runId,
      label: "Claude subagent",
      task: "Claude native subagent (Agent/Task tool)",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Claude native subagent running.",
    });
    if (!taskRecord) {
      // Don't retry every subsequent pulse for a turn whose task-run creation
      // failed once (e.g. task persistence unavailable) — matches Codex's
      // mirrorStateByThreadId "failed" gate.
      this.failedToCreate = true;
      return;
    }
    this.active = true;
  }

  /**
   * Call when real (non-subagent, non-heartbeat) progress resumes — the
   * subagent finished and the model continued — or when the turn itself
   * settles while a subagent task is still open.
   */
  finalize(status: "succeeded" | "failed" | "cancelled"): void {
    if (!this.active) {
      return;
    }
    this.active = false;
    const eventAt = this.now();
    this.runtime.finalizeTaskRunByRunId({
      runId: this.runId,
      status,
      endedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Claude native subagent finished.",
      terminalSummary: "Claude native subagent finished.",
    });
  }
}
