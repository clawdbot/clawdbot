// Telegram plugin module implements bot native commandselivery behavior.
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import { deliverReplies, emitTelegramMessageSentHooks } from "./bot/delivery.js";

export { createChannelMessageReplyPipeline, deliverReplies, emitTelegramMessageSentHooks };
