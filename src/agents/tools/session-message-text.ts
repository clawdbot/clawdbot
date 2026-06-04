/**
 * Session message text extraction barrel.
 *
 * Session tools import this narrow surface for assistant/user text extraction
 * without reaching into chat-history helper internals.
 */
export { extractAssistantText, sanitizeTextContent } from "./chat-history-text.js";
