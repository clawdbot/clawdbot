import type { MediaFact } from "../media/media-facts.js";

/** Stable media fact exposed to message-hook consumers. */
export type MessageHookMediaFact = {
  path?: string;
  url?: string;
  contentType?: string;
  kind?: MediaFact["kind"];
  transcribed?: boolean;
  messageId?: string;
  workspaceDir?: string;
};

/** Copies runtime media into the public hook shape without internal staging/hydration flags. */
export function projectMessageHookMediaFacts(
  media: readonly MediaFact[] | null | undefined,
): MessageHookMediaFact[] {
  return (media ?? []).map((fact) => {
    const projected: MessageHookMediaFact = {};
    if (fact.path !== undefined) {
      projected.path = fact.path;
    }
    if (fact.url !== undefined) {
      projected.url = fact.url;
    }
    if (fact.contentType !== undefined) {
      projected.contentType = fact.contentType;
    }
    if (fact.kind !== undefined) {
      projected.kind = fact.kind;
    }
    if (fact.transcribed === true) {
      projected.transcribed = true;
    }
    if (fact.messageId !== undefined) {
      projected.messageId = fact.messageId;
    }
    if (fact.workspaceDir !== undefined) {
      projected.workspaceDir = fact.workspaceDir;
    }
    return projected;
  });
}
