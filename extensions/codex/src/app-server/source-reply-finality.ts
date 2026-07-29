import type {
  MessagingToolSend,
  MessagingToolSourceReplyPayload,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type SourceReplyDeliveryIntent = {
  record: MessagingToolSend | MessagingToolSourceReplyPayload;
  final: boolean | undefined;
};

const sourceReplyDeliveryIntents = new WeakMap<object, SourceReplyDeliveryIntent[]>();

/** Retain source-reply intent until the owning Codex turn has an authoritative outcome. */
export function recordCodexSourceReplyDeliveryIntent(
  owner: object,
  intent: SourceReplyDeliveryIntent,
): void {
  const intents = sourceReplyDeliveryIntents.get(owner);
  if (intents) {
    intents.push(intent);
    return;
  }
  sourceReplyDeliveryIntents.set(owner, [intent]);
}

/** Resolve omitted finality without changing explicit progress or final markers. */
export function settleCodexSourceReplyFinality(owner: object, turnSucceeded: boolean): boolean {
  const intents = sourceReplyDeliveryIntents.get(owner);
  if (!intents) {
    return false;
  }
  const lastIntent = intents.at(-1);
  for (const intent of intents) {
    if (intent.final !== undefined) {
      continue;
    }
    // An omitted marker is progress until the owning turn succeeds. Only the
    // latest omitted reply can complete the conversation; a later explicit
    // progress/final marker remains authoritative.
    intent.record.sourceReplyFinal = turnSucceeded && intent === lastIntent;
  }
  sourceReplyDeliveryIntents.delete(owner);
  return turnSucceeded && intents.some((intent) => intent.record.sourceReplyFinal === true);
}
