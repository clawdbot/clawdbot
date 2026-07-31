import type { SessionEvent } from "@github/copilot-sdk";
import {
  createAgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";

const COPILOT_NATIVE_SUBAGENT_TASK_KIND = "copilot-native";
const COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX = "copilot-agent:";

type CopilotNativeSubagentEvent = Extract<
  SessionEvent,
  { type: "subagent.started" | "subagent.completed" | "subagent.failed" }
>;

type TaskLifecycleRuntime = Pick<
  AgentHarnessTaskRuntime,
  "tryCreateRunningTaskRun" | "recordTaskRunProgressByRunId" | "finalizeTaskRunByRunId"
>;

export function createCopilotNativeSubagentTaskMirror(params: {
  agentId?: string;
  now?: () => number;
  scope?: AgentHarnessTaskRuntimeScope;
}): CopilotNativeSubagentTaskMirror | undefined {
  if (!params.scope) {
    return undefined;
  }
  return new CopilotNativeSubagentTaskMirror(
    {
      agentId: params.agentId,
      now: params.now,
    },
    createAgentHarnessTaskRuntime({
      runtime: "subagent",
      taskKind: COPILOT_NATIVE_SUBAGENT_TASK_KIND,
      scope: params.scope,
      runIdPrefix: COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    }),
  );
}

class CopilotNativeSubagentTaskMirror {
  private readonly runIdByAgentId = new Map<string, string>();
  private readonly runIdByToolCallId = new Map<string, string>();
  private readonly terminalRunIds = new Set<string>();
  private readonly activeRunIds = new Set<string>();
  private readonly now: () => number;

  constructor(
    private readonly params: { agentId?: string; now?: () => number },
    private readonly runtime: TaskLifecycleRuntime,
  ) {
    this.now = params.now ?? Date.now;
  }

  handleEvent(event: CopilotNativeSubagentEvent): void {
    const toolCallId = event.data.toolCallId.trim();
    if (!toolCallId) {
      return;
    }
    const runId = this.resolveRunId(event);
    if (event.type === "subagent.started") {
      this.handleStarted(event, runId, toolCallId);
      return;
    }
    if (event.type === "subagent.completed") {
      this.handleCompleted(event, runId);
      return;
    }
    this.handleFailed(event, runId);
  }

  finalizeActiveRuns(): void {
    const eventAt = this.now();
    for (const runId of this.activeRunIds) {
      this.terminalRunIds.add(runId);
      this.runtime.finalizeTaskRunByRunId({
        runId,
        status: "cancelled",
        endedAt: eventAt,
        lastEventAt: eventAt,
        error: "Copilot native subagent ended with its parent attempt.",
        progressSummary: "Copilot native subagent cancelled with its parent attempt.",
        terminalSummary: "Copilot native subagent cancelled.",
      });
    }
    this.activeRunIds.clear();
  }

  private handleStarted(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.started" }>,
    runId: string,
    toolCallId: string,
  ): void {
    const agentId = event.agentId?.trim();
    const existingRunId = agentId
      ? this.runIdByAgentId.get(agentId)
      : this.runIdByToolCallId.get(toolCallId);
    if (existingRunId) {
      return;
    }
    const eventAt = this.now();
    const label = event.data.agentDisplayName.trim() || event.data.agentName.trim();
    const task = event.data.agentDescription.trim() || `Copilot native subagent ${label}`;
    const taskRecord = this.runtime.tryCreateRunningTaskRun({
      sourceId: toolCallId,
      agentId: this.params.agentId,
      runId,
      label: label || "Copilot subagent",
      task,
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Copilot native subagent started.",
    });
    if (!taskRecord) {
      return;
    }
    if (agentId) {
      this.runIdByAgentId.set(agentId, runId);
    } else {
      this.runIdByToolCallId.set(toolCallId, runId);
    }
    this.terminalRunIds.delete(runId);
    this.activeRunIds.add(runId);
  }

  private handleCompleted(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.completed" }>,
    runId: string,
  ): void {
    if (this.terminalRunIds.has(runId)) {
      return;
    }
    const eventAt = this.now();
    this.terminalRunIds.add(runId);
    this.activeRunIds.delete(runId);
    this.runtime.finalizeTaskRunByRunId({
      runId,
      status: "succeeded",
      endedAt: eventAt,
      lastEventAt: eventAt,
      progressSummary: "Copilot native subagent completed.",
      terminalSummary: buildCompletionSummary(event),
    });
  }

  private handleFailed(
    event: Extract<CopilotNativeSubagentEvent, { type: "subagent.failed" }>,
    runId: string,
  ): void {
    if (this.terminalRunIds.has(runId)) {
      return;
    }
    const eventAt = this.now();
    this.terminalRunIds.add(runId);
    this.activeRunIds.delete(runId);
    this.runtime.finalizeTaskRunByRunId({
      runId,
      status: "failed",
      endedAt: eventAt,
      lastEventAt: eventAt,
      error: event.data.error,
      progressSummary: "Copilot native subagent failed.",
      terminalSummary: "Copilot native subagent failed.",
    });
  }

  private resolveRunId(event: CopilotNativeSubagentEvent): string {
    const agentId = event.agentId?.trim();
    if (agentId) {
      const existing = this.runIdByAgentId.get(agentId);
      if (existing) {
        return existing;
      }
    }
    const existing = this.runIdByToolCallId.get(event.data.toolCallId);
    if (existing) {
      return existing;
    }
    const identity = agentId || event.data.toolCallId.trim();
    return `${COPILOT_NATIVE_SUBAGENT_RUN_ID_PREFIX}${identity}`;
  }
}

function buildCompletionSummary(
  event: Extract<CopilotNativeSubagentEvent, { type: "subagent.completed" }>,
): string {
  const details = [
    event.data.totalToolCalls !== undefined ? `${event.data.totalToolCalls} tool calls` : undefined,
    event.data.totalTokens !== undefined ? `${event.data.totalTokens} tokens` : undefined,
  ].filter((value): value is string => value !== undefined);
  return details.length > 0
    ? `Copilot native subagent completed (${details.join(", ")}).`
    : "Copilot native subagent completed.";
}
