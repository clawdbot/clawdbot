// Public facade for Control UI grouped chat message rendering.
import "../../../components/tooltip.ts";

export { getAssistantAttachmentAvailabilityRenderVersion } from "./chat-message-attachments.ts";
export {
  dismissConfirmedActionPopovers,
  openChatHideConfirmation,
  openChatRewindConfirmation,
} from "./chat-message-confirmation.ts";
export { renderMessageGroup } from "./chat-message-group.ts";
export type { MessageReplyTarget } from "./chat-message-markdown.ts";
export { renderStreamGroup, renderWorkGroupSummary } from "./chat-message-stream.ts";
