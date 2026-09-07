// Zalo plugin module implements actions behavior.
import { sendMessageZalo as sendMessageZaloImpl } from "./send.js";

export const zaloActionsRuntime = {
  sendMessageZalo: sendMessageZaloImpl,
};
