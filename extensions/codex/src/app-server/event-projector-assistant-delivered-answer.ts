// Item-id mirror of the assistant projector's collectAssistantTexts(): the Activity
// "selected answer" must name the item whose text delivery actually chooses. Without
// this, a trailing silent token shadows the real answer in the operator UI while the
// channel correctly receives the audible reply.
import { isSilentReplyPayloadText } from "openclaw/plugin-sdk/reply-chunking";

export type DeliveredAnswerItemLookup = {
  assistantItemOrder: readonly string[];
  assistantPhaseByItem: ReadonlyMap<string, string>;
  assistantTextByItem: ReadonlyMap<string, string>;
  persistableAssistantBarrier: number;
  isToolProgressEchoText: (itemId: string, text: string) => boolean;
  resolveFinalAssistantTextItemId: () => string | undefined;
};

/** Resolves the item id delivery would pick, skipping commentary and silent tokens. */
export function resolveDeliveredAnswerItemId(
  lookup: DeliveredAnswerItemLookup,
): string | undefined {
  const pickLast = (minIndex: number, audibleOnly: boolean): string | undefined => {
    for (let i = lookup.assistantItemOrder.length - 1; i >= minIndex; i -= 1) {
      const itemId = lookup.assistantItemOrder[i];
      if (!itemId || lookup.assistantPhaseByItem.get(itemId) === "commentary") {
        continue;
      }
      const text = lookup.assistantTextByItem.get(itemId)?.trim();
      if (!text || lookup.isToolProgressEchoText(itemId, text)) {
        continue;
      }
      if (audibleOnly && isSilentReplyPayloadText(text)) {
        continue;
      }
      return itemId;
    }
    return undefined;
  };
  return (
    pickLast(lookup.persistableAssistantBarrier, true) ??
    pickLast(lookup.persistableAssistantBarrier, false) ??
    pickLast(0, true) ??
    lookup.resolveFinalAssistantTextItemId()
  );
}
