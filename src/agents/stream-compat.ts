import type { AssistantMessage, AssistantMessageEvent } from "../llm/types.js";

export interface MutableAssistantMessageEventStream extends AsyncIterable<AssistantMessageEvent> {
  result: () => Promise<AssistantMessage>;
}
