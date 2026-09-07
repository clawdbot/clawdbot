import type { ChatLog } from "./components/chat-log.js";

const TUI_AGENT_BUSY_MESSAGE = "agent is busy — press Esc to abort before sending a new message";

export function addBlockedChatSubmitNotice(chatLog: Pick<ChatLog, "addSystem">) {
  chatLog.addSystem(TUI_AGENT_BUSY_MESSAGE, { coalesceConsecutive: true });
}
