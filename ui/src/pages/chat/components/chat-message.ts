// Public facade for Control UI grouped chat message rendering.
import "../../../components/tooltip.ts";

export { getChatMediaRenderVersion } from "./chat-message-media.ts";
export {
  dismissConfirmedActionPopovers,
  openChatRewindConfirmation,
} from "./chat-message-confirmation.ts";
export {
  renderActivityGroup,
  renderMessageGroup,
  renderMessageGroupContent,
} from "./chat-message-group.ts";
export type { MessageReplyTarget } from "./chat-message-markdown.ts";
export {
  renderStreamGroup,
  renderStreamGroupParts,
  renderWorkGroupSummary,
} from "./chat-message-stream.ts";
export type { StreamGroupOptions, StreamGroupPart } from "./chat-message-stream.ts";
