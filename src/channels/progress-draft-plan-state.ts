import {
  type AgentPlanStep,
  formatPlanChecklistLines,
  resolveChannelProgressDraftMaxLineChars,
  resolveChannelProgressDraftMaxLines,
  type StreamingCompatEntry,
} from "./streaming.js";

export type ChannelProgressDraftPlanLayout = Readonly<{
  lineCount: number;
  activeLineIndex?: number;
}>;

type ActivePlanStepIdentity =
  | Readonly<{
      kind: "active";
      text: string;
      occurrenceFromStart: number;
      occurrenceFromEnd: number;
    }>
  | Readonly<{ kind: "completed" }>;

type ProgressDraftPlanEvent = {
  event: string;
  itemId?: string;
  toolCallId?: string;
};

function normalizePlanStepText(step: string | undefined): string {
  return step?.replace(/\s+/g, " ").trim() ?? "";
}

function resolveActivePlanStepIdentity(
  steps: readonly AgentPlanStep[] | undefined,
): ActivePlanStepIdentity | undefined {
  if (!steps?.length) {
    return undefined;
  }
  const activeIndex = steps.findIndex((entry) => entry.status === "in_progress");
  if (activeIndex >= 0) {
    const activeStep = normalizePlanStepText(steps[activeIndex]?.step);
    const occurrenceFromStart = steps
      .slice(0, activeIndex + 1)
      .filter((entry) => normalizePlanStepText(entry.step) === activeStep).length;
    const occurrenceFromEnd = steps
      .slice(activeIndex)
      .filter((entry) => normalizePlanStepText(entry.step) === activeStep).length;
    return {
      kind: "active",
      text: activeStep,
      occurrenceFromStart,
      occurrenceFromEnd,
    };
  }
  return steps.every((entry) => entry.status === "completed") ? { kind: "completed" } : undefined;
}

function isSameActivePlanStep(
  previous: ActivePlanStepIdentity | undefined,
  next: ActivePlanStepIdentity | undefined,
): boolean {
  if (previous === undefined || next === undefined) {
    return previous === next;
  }
  if (previous.kind !== "active" || next.kind !== "active") {
    return previous.kind === next.kind;
  }
  if (previous.text !== next.text) {
    return false;
  }
  if (
    previous.occurrenceFromStart === next.occurrenceFromStart &&
    previous.occurrenceFromEnd === next.occurrenceFromEnd
  ) {
    return true;
  }
  // The only safe one-sided renumbering is pruning completed same-label
  // predecessors without changing the active step's position from the end.
  // Other duplicate edits are ambiguous, so clear their rows conservatively.
  return (
    previous.occurrenceFromEnd === next.occurrenceFromEnd &&
    next.occurrenceFromStart < previous.occurrenceFromStart
  );
}

function resolveEventId(event: ProgressDraftPlanEvent): string | undefined {
  return event.toolCallId?.trim() || event.itemId?.trim() || undefined;
}

export function resolveProgressDraftPlanStatusHeadline(
  steps: readonly AgentPlanStep[] | undefined,
): string {
  if (!steps?.length) {
    return "";
  }
  const currentIndex = steps.findIndex((entry) => entry.status === "in_progress");
  const fallbackIndex = steps.findIndex((entry) => entry.status === "pending");
  const stepIndex = currentIndex >= 0 ? currentIndex : fallbackIndex;
  if (stepIndex >= 0) {
    const step = normalizePlanStepText(steps[stepIndex]?.step);
    const counter = `${stepIndex + 1}/${steps.length}`;
    return step ? `⏳ ${counter} · ${step}` : `⏳ ${counter}`;
  }
  return steps.every((entry) => entry.status === "completed")
    ? `✅ ${steps.length}/${steps.length}`
    : "";
}

export function resolveProgressDraftPlanLayout(
  steps: readonly AgentPlanStep[] | undefined,
  entry: StreamingCompatEntry | null | undefined,
): ChannelProgressDraftPlanLayout | undefined {
  if (!steps?.length) {
    return undefined;
  }
  const planLines = formatPlanChecklistLines(steps, {
    maxLines: resolveChannelProgressDraftMaxLines(entry),
    maxLineChars: resolveChannelProgressDraftMaxLineChars(entry),
  });
  const activeLineIndex = planLines.findIndex((line) => /^▸(?:\s|$)/u.test(line));
  return {
    lineCount: planLines.length,
    ...(activeLineIndex >= 0 ? { activeLineIndex } : {}),
  };
}

export function createProgressDraftPlanState() {
  let activeStepIdentity: ActivePlanStepIdentity | undefined;
  let generation = 0;
  const toolGenerations = new Map<string, number>();

  const acceptToolCallId = (toolCallId: string, remember: boolean): boolean => {
    const admittedGeneration = toolGenerations.get(toolCallId);
    if (admittedGeneration === undefined && remember) {
      toolGenerations.set(toolCallId, generation);
    }
    return admittedGeneration === undefined || admittedGeneration === generation;
  };

  return {
    reset() {
      activeStepIdentity = undefined;
      generation = 0;
      toolGenerations.clear();
    },
    update(steps: readonly AgentPlanStep[] | undefined): boolean {
      const nextIdentity = resolveActivePlanStepIdentity(steps);
      const activeStepChanged =
        activeStepIdentity !== undefined && !isSameActivePlanStep(activeStepIdentity, nextIdentity);
      activeStepIdentity = nextIdentity;
      if (activeStepChanged) {
        generation += 1;
      }
      return activeStepChanged;
    },
    createGenerationGuard(): () => boolean {
      const admittedGeneration = generation;
      return () => admittedGeneration === generation;
    },
    acceptEvent(event: ProgressDraftPlanEvent): boolean {
      const eventId = resolveEventId(event);
      return eventId ? acceptToolCallId(eventId, true) : true;
    },
  };
}
