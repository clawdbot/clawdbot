import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentPlanStep } from "openclaw/plugin-sdk/channel-outbound";
import type { CodexAppServerClient } from "./client.js";

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];
type StoredPlan = { explanation?: string; steps: AgentPlanStep[] };

const RESTORED_PLAN_PREAMBLE =
  "OpenClaw restored the active task list after context compaction. " +
  "This is application state, not a new user request. Continue the current task and call " +
  "update_plan whenever a status changes.";

/** Retains the latest projected plan so Codex compaction cannot discard it. */
export class CodexCompactionPlanState {
  private latestPlan: StoredPlan | undefined;

  record(event: AgentEvent): void {
    if (event.stream !== "plan") {
      return;
    }
    const steps = readPlanSteps(event.data.steps);
    if (steps.length === 0) {
      return;
    }
    this.latestPlan = {
      ...(typeof event.data.explanation === "string"
        ? { explanation: event.data.explanation }
        : {}),
      steps,
    };
  }

  async restore(params: {
    client: CodexAppServerClient;
    threadId: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<void> {
    if (!this.latestPlan) {
      return;
    }
    await params.client.request(
      "thread/inject_items",
      {
        threadId: params.threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: `${RESTORED_PLAN_PREAMBLE}\n${JSON.stringify({
                  explanation: this.latestPlan.explanation,
                  plan: this.latestPlan.steps,
                })}`,
              },
            ],
          },
        ],
      },
      { timeoutMs: params.timeoutMs, signal: params.signal },
    );
  }
}

function readPlanSteps(value: unknown): AgentPlanStep[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const { step, status } = entry as { step?: unknown; status?: unknown };
    if (typeof step !== "string" || !isPlanStatus(status)) {
      return [];
    }
    return [{ step, status }];
  });
}

function isPlanStatus(value: unknown): value is AgentPlanStep["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}
