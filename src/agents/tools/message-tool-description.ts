import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";

const MESSAGE_TOOL_THREAD_READ_HINT = ' Missing thread context: action="read" + threadId.';

export function appendMessageToolReadHint(
  description: string,
  actions: Iterable<ChannelMessageActionName | "send">,
): string {
  for (const action of actions) {
    if (action === "read") {
      return `${description}${MESSAGE_TOOL_THREAD_READ_HINT}`;
    }
  }
  return description;
}
