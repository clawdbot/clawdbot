import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

const MAX_BROWSER_ANNOTATION_ATTACHMENTS = 4;
const MAX_BROWSER_ANNOTATION_CONTEXT_CHARS = 8_000;

/** Enforces one aggregate bound for both a new annotation candidate and Undo. */
export function canAdmitBrowserAnnotation(
  attachments: readonly ChatAttachment[],
  modelContext: string,
): boolean {
  let annotationCount = 1;
  let contextLength = modelContext.length;
  if (contextLength > MAX_BROWSER_ANNOTATION_CONTEXT_CHARS) {
    return false;
  }
  for (const attachment of attachments) {
    const annotation = attachment.browserAnnotation;
    if (!annotation) {
      continue;
    }
    annotationCount += 1;
    contextLength += annotation.modelContext.length;
    if (
      annotationCount > MAX_BROWSER_ANNOTATION_ATTACHMENTS ||
      contextLength > MAX_BROWSER_ANNOTATION_CONTEXT_CHARS
    ) {
      return false;
    }
  }
  return true;
}
