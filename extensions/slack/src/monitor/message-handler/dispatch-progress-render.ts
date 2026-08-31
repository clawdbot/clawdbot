import type {
  ChannelProgressDraftCompositorLine,
  ChannelProgressDraftCompositorSnapshot,
  ChannelProgressDraftLine,
} from "openclaw/plugin-sdk/channel-outbound";

export function resolveStructuredProgressLines(
  lines: readonly ChannelProgressDraftCompositorLine[],
): ChannelProgressDraftLine[] {
  // Summary compositors carry authored text and attention as structured lines.
  return lines.filter((line): line is ChannelProgressDraftLine => typeof line !== "string");
}

export function resolveNativeProgressLines(
  snapshot: ChannelProgressDraftCompositorSnapshot,
): ChannelProgressDraftLine[] {
  return resolveStructuredProgressLines(snapshot.lines).filter(
    (line) => line.id !== "reasoning" && line.id?.startsWith("commentary:") !== true,
  );
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
