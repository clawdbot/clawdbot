import type { ChatAttachment, ChatComposerMemoryFallback } from "../lib/chat/chat-types.ts";
import { releaseChatAttachmentPayloads } from "../pages/chat/attachment-payload-store.ts";
import type { ApplicationChatAttachmentHandoff } from "./context.ts";

const MAX_PENDING_CHAT_ATTACHMENT_ENTRIES = 32;
// Hidden split panes can remain unmounted indefinitely, so wall-clock expiry
// would lose valid drafts. Bounded oldest-first eviction owns abandoned cleanup.

type PendingChatAttachmentHandoff = {
  owner: NonNullable<Parameters<ApplicationChatAttachmentHandoff["prepare"]>[0]["owner"]>;
  paneId: string;
  scopeKey: string;
  attachments: ChatAttachment[];
  fallbacks: Record<string, ChatComposerMemoryFallback>;
};

export function createChatAttachmentHandoff(): ApplicationChatAttachmentHandoff {
  const pending = new Map<string, PendingChatAttachmentHandoff>();
  let disposed = false;

  const release = (attachments: readonly ChatAttachment[] = []) =>
    releaseChatAttachmentPayloads(attachments);
  const handoffAttachments = (handoff: PendingChatAttachmentHandoff) => {
    const byId = new Map(handoff.attachments.map((attachment) => [attachment.id, attachment]));
    for (const fallback of Object.values(handoff.fallbacks)) {
      for (const attachment of fallback.attachments) {
        byId.set(attachment.id, attachment);
      }
    }
    return [...byId.values()];
  };
  const releaseHandoff = (
    handoff: PendingChatAttachmentHandoff | undefined,
    retainedIds = new Set<string>(),
  ) => {
    if (!handoff) {
      return;
    }
    release(handoffAttachments(handoff).filter((attachment) => !retainedIds.has(attachment.id)));
  };
  const entryKey = (paneId: string, scopeKey: string) => JSON.stringify([paneId, scopeKey]);
  const take = (key: string) => {
    const handoff = pending.get(key);
    if (handoff) {
      pending.delete(key);
    }
    return handoff;
  };

  return {
    prepare: ({ owner, paneId, scopeKey, attachments, fallbacks }) => {
      const key = entryKey(paneId, scopeKey);
      const previous = take(key);
      const fallbackEntries = Object.entries(fallbacks);
      if (attachments.length === 0 && fallbackEntries.length === 0) {
        releaseHandoff(previous);
        return;
      }
      const retainedIds = new Set(attachments.map((attachment) => attachment.id));
      for (const fallback of Object.values(fallbacks)) {
        for (const attachment of fallback.attachments) {
          retainedIds.add(attachment.id);
        }
      }
      releaseHandoff(previous, retainedIds);
      if (!owner || disposed) {
        release(attachments);
        for (const fallback of Object.values(fallbacks)) {
          release(fallback.attachments);
        }
        return;
      }
      pending.set(key, {
        owner,
        paneId,
        scopeKey,
        attachments: [...attachments],
        fallbacks: Object.fromEntries(
          fallbackEntries.map(([fallbackKey, fallback]) => [
            fallbackKey,
            { ...fallback, attachments: [...fallback.attachments] },
          ]),
        ),
      });
      // Route handoffs normally consume immediately. Bounds make abandoned
      // split panes release their packages instead of leaking for the tab lifetime.
      for (const oldestKey of pending.keys()) {
        if (pending.size <= MAX_PENDING_CHAT_ATTACHMENT_ENTRIES) {
          break;
        }
        releaseHandoff(take(oldestKey));
      }
    },
    consume: ({ owner, paneId, scopeKey }) => {
      const match = take(entryKey(paneId, scopeKey));
      // A Gateway mismatch is terminal for this exact presentation. Other
      // retained session scopes under the same logical pane remain independent.
      if (match?.owner === owner) {
        return { attachments: match.attachments, fallbacks: match.fallbacks };
      }
      releaseHandoff(match);
      return null;
    },
    clearPane: (paneId) => {
      for (const [key, handoff] of pending) {
        if (handoff.paneId === paneId) {
          releaseHandoff(take(key));
        }
      }
    },
    dispose: () => {
      disposed = true;
      for (const handoff of pending.values()) {
        releaseHandoff(handoff);
      }
      pending.clear();
    },
  };
}
