import { markInboundContextLabel } from "../../../../src/auto-reply/reply/inbound-context-marker.ts";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

export function composeBrowserAnnotationEnvelope(modelContexts: readonly string[]): string {
  const contexts = modelContexts.map((context) => context.trim()).filter(Boolean);
  if (contexts.length === 0) {
    return "";
  }
  return `${markInboundContextLabel("Visual annotations:")}\n\`\`\`json\n${JSON.stringify({ annotations: contexts })}\n\`\`\``;
}

export function composeBrowserAnnotationContext(
  userText: string,
  attachments: readonly ChatAttachment[],
): string {
  const contexts = attachments.flatMap((attachment) => {
    const context = attachment.browserAnnotation?.modelContext.trim();
    return context ? [context] : [];
  });
  if (contexts.length === 0) {
    return userText;
  }
  // Current-turn annotation facts belong in the model prompt, but the durable
  // transcript and optimistic user bubble should show only operator-authored
  // feedback. The standard inbound-context envelope already owns that split.
  const annotationContext = composeBrowserAnnotationEnvelope(contexts);
  return userText ? `${annotationContext}\n\n${userText}` : annotationContext;
}
