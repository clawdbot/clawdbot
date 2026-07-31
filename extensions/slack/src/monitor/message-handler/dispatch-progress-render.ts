import {
  buildChannelProgressDraftLine,
  type AgentPlanStep,
  type ChannelProgressDraftCompositorLine,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildSlackProgressStreamStartChunks,
  buildSlackProgressStreamUpdateChunks,
} from "../../progress-blocks.js";

export function resolveStructuredProgressLines(
  lines: readonly ChannelProgressDraftCompositorLine[],
): ChannelProgressDraftLine[] {
  return lines.map((line) => {
    if (typeof line !== "string") {
      return line;
    }
    const reasoning = line.startsWith("🧠 ");
    const text = line
      .replace(/^(?:🧠|💬)\s+/u, "")
      .replace(/^_(.*)_$/su, "$1")
      .trim();
    return {
      // Reasoning snapshots replace one rolling row; text-based ids would orphan it each delta.
      ...(reasoning ? { id: "reasoning" } : {}),
      kind: "item",
      text,
      label: reasoning ? "Reasoning" : "Update",
      prefix: false,
    };
  });
}

// Native cards derive from the compositor snapshot. Empty plans fall back
// to line tasks, and reconciliation retires rows from the prior source.
export function resolveNativeProgressPlan(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): readonly AgentPlanStep[] | undefined {
  return snapshot.plan?.length ? snapshot.plan : undefined;
}

export function resolveNativeProgressLines(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): ChannelProgressDraftLine[] {
  const lines = resolveStructuredProgressLines(snapshot.lines);
  if (snapshot.plan?.length || !snapshot.planExplanation) {
    return lines;
  }
  const explanationLine = buildChannelProgressDraftLine({
    event: "plan",
    phase: "update",
    explanation: snapshot.planExplanation,
  });
  return explanationLine ? [...lines, explanationLine] : lines;
}

export function combineProgressHeadlineAndExplanation(
  headline: string | undefined,
  explanation: string | undefined,
): string | undefined {
  return headline && explanation && headline !== explanation
    ? `${headline} — ${explanation}`
    : (headline ?? explanation);
}

export function buildNativeProgressChunks(params: {
  snapshot: ChannelProgressDraftCompositorSnapshot;
  streamStarted: boolean;
  title?: string;
  maxLineChars?: number;
}) {
  const input = {
    title: params.title,
    lines: resolveNativeProgressLines(params.snapshot),
    plan: resolveNativeProgressPlan(params.snapshot),
    maxLineChars: params.maxLineChars,
  };
  return params.streamStarted
    ? buildSlackProgressStreamUpdateChunks(input)
    : buildSlackProgressStreamStartChunks(input);
}
