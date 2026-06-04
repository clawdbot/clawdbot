import type { AssistantMessage, AssistantMessageEvent } from "../llm/types.js";

// Mutable stream shape used by compatibility wrappers that decorate result()
// and async iteration without changing provider stream implementations.
export interface MutableAssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result: () => Promise<AssistantMessage>;
}
