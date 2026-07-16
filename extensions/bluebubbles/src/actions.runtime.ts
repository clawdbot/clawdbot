import { sendBlueBubblesAttachment as sendBlueBubblesAttachmentImpl } from "./attachments.js";
import {
  addBlueBubblesParticipant as addBlueBubblesParticipantImpl,
  editBlueBubblesMessage as editBlueBubblesMessageImpl,
  leaveBlueBubblesChat as leaveBlueBubblesChatImpl,
  removeBlueBubblesParticipant as removeBlueBubblesParticipantImpl,
  renameBlueBubblesChat as renameBlueBubblesChatImpl,
  setGroupIconBlueBubbles as setGroupIconBlueBubblesImpl,
  unsendBlueBubblesMessage as unsendBlueBubblesMessageImpl,
} from "./chat.js";
import { resolveBlueBubblesMessageId as resolveBlueBubblesMessageIdImpl } from "./monitor-reply-cache.js";
import { sendBlueBubblesReaction as sendBlueBubblesReactionImpl } from "./reactions.js";
import {
  resolveChatGuidForTarget as resolveChatGuidForTargetImpl,
  sendMessageBlueBubbles as sendMessageBlueBubblesImpl,
} from "./send.js";

export const blueBubblesActionsRuntime = {
  sendBlueBubblesAttachment: sendBlueBubblesAttachmentImpl,
  addBlueBubblesParticipant: addBlueBubblesParticipantImpl,
  editBlueBubblesMessage: editBlueBubblesMessageImpl,
  leaveBlueBubblesChat: leaveBlueBubblesChatImpl,
  removeBlueBubblesParticipant: removeBlueBubblesParticipantImpl,
  renameBlueBubblesChat: renameBlueBubblesChatImpl,
  setGroupIconBlueBubbles: setGroupIconBlueBubblesImpl,
  unsendBlueBubblesMessage: unsendBlueBubblesMessageImpl,
  resolveBlueBubblesMessageId: resolveBlueBubblesMessageIdImpl,
  sendBlueBubblesReaction: sendBlueBubblesReactionImpl,
  resolveChatGuidForTarget: resolveChatGuidForTargetImpl,
  sendMessageBlueBubbles: sendMessageBlueBubblesImpl,
};
