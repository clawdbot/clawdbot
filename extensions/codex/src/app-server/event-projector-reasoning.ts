import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { AgentPlanStep, AgentPlanStepStatus } from "openclaw/plugin-sdk/channel-outbound";
import {
  readNonNegativeInteger,
  readNullableString,
  readString,
  splitPlanText,
} from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";

type ReasoningDeltaMethod = "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta";

type ReasoningTextGroup = {
  itemId: string;
  method: ReasoningDeltaMethod;
  index: number;
  text: string;
};

type AgentEvent = Parameters<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>[0];

export class CodexReasoningProjection {
  private readonly reasoningTextByGroup = new Map<string, ReasoningTextGroup>();
  private readonly reasoningItemOrder = new Map<string, number>();
  private readonly planTextByItem = new Map<string, string>();
  private turnPlanText: string | undefined;
  private reasoningStarted = false;
  private reasoningEnded = false;

  constructor(
    private readonly params: EmbeddedRunAttemptParams,
    private readonly emitAgentEvent: (event: AgentEvent) => void,
  ) {}

  async handleReasoningDelta(method: ReasoningDeltaMethod, params: JsonObject): Promise<void> {
    const itemId = readString(params, "itemId") ?? "reasoning";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    this.reasoningStarted = true;
    if (!this.reasoningItemOrder.has(itemId)) {
      this.reasoningItemOrder.set(itemId, this.reasoningItemOrder.size);
    }
    // Codex indexes reasoning sections independently within an item.
    const groupIndex =
      method === "item/reasoning/textDelta"
        ? (readNonNegativeInteger(params, "contentIndex") ?? 0)
        : (readNonNegativeInteger(params, "summaryIndex") ?? 0);
    const groupKey = `${method}\0${itemId}\0${groupIndex}`;
    const current = this.reasoningTextByGroup.get(groupKey);
    this.reasoningTextByGroup.set(groupKey, {
      itemId,
      method,
      index: groupIndex,
      text: `${current?.text ?? ""}${delta}`,
    });
    await this.params.onReasoningStream?.({
      text: this.reasoningText(),
      isReasoningSnapshot: true,
    });
  }

  handlePlanDelta(params: JsonObject): void {
    const itemId = readString(params, "itemId") ?? "plan";
    const delta = readString(params, "delta") ?? "";
    if (!delta) {
      return;
    }
    const text = `${this.planTextByItem.get(itemId) ?? ""}${delta}`;
    this.planTextByItem.set(itemId, text);
    this.emitPlanUpdate({
      explanation: undefined,
      steps: splitPlanText(text).map((step) => ({ step, status: "pending" })),
    });
  }

  handleTurnPlanUpdated(params: JsonObject): void {
    const explanation = readNullableString(params, "explanation");
    const plan = Array.isArray(params.plan)
      ? params.plan.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            return [];
          }
          const record = entry as JsonObject;
          const step = readString(record, "step");
          if (!step) {
            return [];
          }
          return [{ step, status: normalizePlanStepStatus(readString(record, "status")) }];
        })
      : undefined;
    const planText = [
      explanation,
      ...(plan ?? []).map(({ step, status }) => `- [${status}] ${step}`),
    ]
      .filter((part): part is string => Boolean(part))
      .join("\n");
    if (planText) {
      // Structured turn updates are the canonical latest plan. Retain the last
      // non-empty update so the terminal transcript proves planning occurred.
      this.turnPlanText = planText;
    }
    this.emitPlanUpdate({
      explanation,
      steps: plan,
    });
  }

  recordItem(item: CodexThreadItem | undefined): void {
    if (item?.type === "plan" && typeof item.text === "string" && item.text) {
      this.planTextByItem.set(item.id, item.text);
      this.emitPlanUpdate({
        explanation: undefined,
        steps: splitPlanText(item.text).map((step) => ({ step, status: "pending" })),
      });
    }
  }

  async maybeEndReasoning(): Promise<void> {
    if (!this.reasoningStarted || this.reasoningEnded) {
      return;
    }
    this.reasoningEnded = true;
    await this.params.onReasoningEnd?.();
  }

  reasoningText(): string {
    return collectReasoningTextValues(this.reasoningTextByGroup, this.reasoningItemOrder).join(
      "\n\n",
    );
  }

  planText(): string {
    return (
      this.turnPlanText ??
      [...this.planTextByItem.values()].filter((text) => text.trim().length > 0).join("\n\n")
    );
  }

  private emitPlanUpdate(params: { explanation?: string | null; steps?: AgentPlanStep[] }): void {
    if (!params.explanation && (!params.steps || params.steps.length === 0)) {
      return;
    }
    this.emitAgentEvent({
      stream: "plan",
      data: {
        phase: "update",
        title: "Plan updated",
        source: "codex-app-server",
        ...(params.explanation ? { explanation: params.explanation } : {}),
        ...(params.steps && params.steps.length > 0 ? { steps: params.steps } : {}),
      },
    });
  }
}

function normalizePlanStepStatus(status: string | undefined): AgentPlanStepStatus {
  if (status === "inProgress" || status === "in_progress") {
    return "in_progress";
  }
  return status === "completed" ? "completed" : "pending";
}

function collectReasoningTextValues(
  groups: Map<string, ReasoningTextGroup>,
  itemOrder: Map<string, number>,
): string[] {
  return [...groups.values()]
    .toSorted((left, right) => {
      const itemDelta =
        (itemOrder.get(left.itemId) ?? Number.MAX_SAFE_INTEGER) -
        (itemOrder.get(right.itemId) ?? Number.MAX_SAFE_INTEGER);
      if (itemDelta !== 0) {
        return itemDelta;
      }
      const methodDelta = reasoningMethodOrder(left.method) - reasoningMethodOrder(right.method);
      return methodDelta !== 0 ? methodDelta : left.index - right.index;
    })
    .map((group) => group.text)
    .filter((text) => text.trim().length > 0);
}

function reasoningMethodOrder(method: ReasoningDeltaMethod): number {
  return method === "item/reasoning/summaryTextDelta" ? 0 : 1;
}
