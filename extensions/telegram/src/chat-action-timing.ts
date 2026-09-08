// Telegram typing expires after five seconds; renew before that without
// fighting the account-scoped sendChatAction coalescing window.
export const TELEGRAM_CHAT_ACTION_INTERVAL_MS = 4_000;

// Detached-run terminal events are best-effort presentation signals. Bound
// each run so a missed terminal event cannot pulse Telegram indefinitely.
export const TELEGRAM_SUBAGENT_TYPING_MAX_DURATION_MS = 20 * 60_000;
