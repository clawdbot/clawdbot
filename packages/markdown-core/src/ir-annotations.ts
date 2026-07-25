import { findAssistantTranscriptRoleHeaderSpans } from "./assistant-transcript-headers.js";
import type {
  AssistantTranscriptRoleImageMeta,
  AssistantTranscriptRoleTokenMeta,
} from "./assistant-transcript.js";
import { mergeAnnotationSpans, type MarkdownAnnotationSpan } from "./ir-spans.js";
import type { MarkdownIR } from "./ir.js";

type AnnotationTarget = {
  text: string;
  annotations: MarkdownAnnotationSpan[];
};

function rangesOverlap(
  left: { start: number; end: number },
  right: { start: number; end: number },
): boolean {
  return left.start < right.end && left.end > right.start;
}

/** Re-evaluate the first visible line after a transport creates a new message boundary. */
export function annotateAssistantTranscriptRoleMessageBoundary(ir: MarkdownIR): MarkdownIR {
  const firstLineEnd = ir.text.indexOf("\n");
  const boundaryText = firstLineEnd === -1 ? ir.text : ir.text.slice(0, firstLineEnd);
  const excludedRanges = ir.styles
    .filter((span) => span.style === "code" || span.style === "code_block")
    .filter((span) => span.start < boundaryText.length)
    .map(({ start, end }) => ({ start, end: Math.min(end, boundaryText.length) }));
  const boundarySpan = findAssistantTranscriptRoleHeaderSpans(boundaryText, excludedRanges)[0];
  if (!boundarySpan || (ir.annotations ?? []).some((span) => rangesOverlap(span, boundarySpan))) {
    return ir;
  }

  const annotation: MarkdownAnnotationSpan = {
    ...boundarySpan,
    type: "assistant_transcript_role",
  };
  return {
    ...ir,
    // A role-looking link must not remain clickable after its label becomes a
    // message-leading transcript header.
    links: ir.links.filter((link) => !rangesOverlap(link, annotation)),
    annotations: mergeAnnotationSpans([...(ir.annotations ?? []), annotation]),
  };
}

export function appendAssistantTranscriptRoleText(
  target: AnnotationTarget,
  value: string,
  meta: AssistantTranscriptRoleTokenMeta["assistantTranscriptRoleHeader"],
): void {
  if (!value) {
    return;
  }
  const start = target.text.length;
  target.text += value;
  target.annotations.push({
    start,
    end: target.text.length,
    type: "assistant_transcript_role",
    kind: meta.kind,
    role: meta.role,
  });
}

export function appendAssistantTranscriptRoleImage(
  target: AnnotationTarget,
  meta: AssistantTranscriptRoleImageMeta["assistantTranscriptRoleImage"],
): void {
  if (!meta.text) {
    return;
  }
  const offset = target.text.length;
  target.text += meta.text;
  for (const span of meta.spans) {
    target.annotations.push({
      ...span,
      start: offset + span.start,
      end: offset + span.end,
      type: "assistant_transcript_role",
    });
  }
}
