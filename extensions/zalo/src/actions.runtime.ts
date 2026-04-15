import { sendMessageZalo as sendMessageZaloImpl } from "./send.js";

export const zaloActionsRuntime = {
  sendMessageZalo: sendMessageZaloImpl,
};
