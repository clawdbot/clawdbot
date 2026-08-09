import type { ChatAttachment } from "../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayload } from "../pages/chat/attachment-payload-store.ts";
import type { ApplicationBrowserAnnotationHandoff } from "./context.ts";

const MAX_PENDING_BROWSER_ANNOTATION_ENTRIES = 32;
const MAX_PENDING_BROWSER_ANNOTATIONS = 32;
// Hidden split panes can remain unmounted indefinitely, so wall-clock expiry
// would lose valid drafts. Bounded oldest-first eviction owns abandoned cleanup.

type PendingBrowserAnnotationHandoff = {
  owner: NonNullable<Parameters<ApplicationBrowserAnnotationHandoff["prepare"]>[0]["owner"]>;
  scopeKey: string;
  attachments: ChatAttachment[];
};

function browserAnnotations(attachments: readonly ChatAttachment[]): ChatAttachment[] {
  return attachments.filter((attachment) => attachment.browserAnnotation !== undefined);
}

export function createBrowserAnnotationHandoff(): ApplicationBrowserAnnotationHandoff {
  const pending = new Map<string, PendingBrowserAnnotationHandoff>();
  let annotationCount = 0;
  let disposed = false;

  const release = (attachments: readonly ChatAttachment[] = []) => {
    for (const attachment of attachments) {
      releaseChatAttachmentPayload(attachment.id);
    }
  };
  const take = (paneId: string) => {
    const handoff = pending.get(paneId);
    if (handoff) {
      pending.delete(paneId);
      annotationCount -= handoff.attachments.length;
    }
    return handoff;
  };

  return {
    prepare: ({ owner, paneId, scopeKey, attachments }) => {
      const annotations = browserAnnotations(attachments);
      const previous = take(paneId);
      if (annotations.length === 0) {
        release(previous?.attachments);
        return;
      }
      const retainedIds = new Set(annotations.map((attachment) => attachment.id));
      release(previous?.attachments.filter((attachment) => !retainedIds.has(attachment.id)));
      if (!owner || disposed) {
        release(annotations);
        return;
      }
      pending.set(paneId, { owner, scopeKey, attachments: annotations });
      annotationCount += annotations.length;
      // Route handoffs normally consume immediately. Bounds make abandoned
      // split panes release their payload owners instead of leaking for the tab lifetime.
      for (const oldestPaneId of pending.keys()) {
        if (
          pending.size <= MAX_PENDING_BROWSER_ANNOTATION_ENTRIES &&
          annotationCount <= MAX_PENDING_BROWSER_ANNOTATIONS
        ) {
          break;
        }
        release(take(oldestPaneId)?.attachments);
      }
    },
    consume: ({ owner, paneId, scopeKey }) => {
      const match = take(paneId);
      // Reusing a pane id with another session or Gateway is terminal for the
      // old owner; keeping it would allow a later remount to recover stale evidence.
      if (match?.owner === owner && match.scopeKey === scopeKey) {
        return match.attachments;
      }
      release(match?.attachments);
      return null;
    },
    clearPane: (paneId) => release(take(paneId)?.attachments),
    dispose: () => {
      disposed = true;
      for (const handoff of pending.values()) {
        release(handoff.attachments);
      }
      pending.clear();
      annotationCount = 0;
    },
  };
}
