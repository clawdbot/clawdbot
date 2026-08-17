import {
  buildChannelProgressDraftLine,
  type AgentPlanStep,
  type ChannelProgressDraftCompositorLine,
  type ChannelProgressDraftCompositorSnapshot,
  type ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";
import { buildSlackProgressStreamChunks } from "../../progress-blocks.js";

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
  const lines = resolveStructuredProgressLines(snapshot.lines).filter(
    (line) => line.id !== "reasoning" && line.id?.startsWith("commentary:") !== true,
  );
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

// The card title already displays the status headline and plan explanation and
// keeps updating them in place, so narration carries only authored commentary
// and reasoning. Including them here streamed every headline a second time as
// static text above the card.
export function resolveNativeProgressNarration(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): string | undefined {
  const paragraphs = resolveStructuredProgressLines(snapshot.lines)
    .filter((line) => line.id === "reasoning" || line.id?.startsWith("commentary:") === true)
    .map((line) => line.text.trim())
    .filter((text, index, values) => Boolean(text) && values.indexOf(text) === index);
  return paragraphs.length > 0 ? paragraphs.join("\n\n") : undefined;
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
  title?: string;
  maxLineChars?: number;
}) {
  return buildSlackProgressStreamChunks({
    title: params.title,
    lines: resolveNativeProgressLines(params.snapshot),
    plan: resolveNativeProgressPlan(params.snapshot),
    maxLineChars: params.maxLineChars,
  });
}
