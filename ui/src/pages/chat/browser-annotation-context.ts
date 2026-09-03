import type { ChatAttachment } from "../../lib/chat/chat-types.ts";

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
  const annotationContext = contexts.join("\n\n");
  return userText ? `${annotationContext}\n\n${userText}` : annotationContext;
}
