/** Largest history page accepted by the Gateway wire contract. */
export const CHAT_HISTORY_MAX_ENTRIES = 1000;
/** Display-only custody records; never transcript branch entry IDs. */
export const CHAT_PENDING_INPUT_MESSAGE_PREFIX = "pending:";
/** Browser send reconciliation stays bounded independently of transcript length. */
export const CHAT_INPUT_CONSUMPTION_MAX_RUN_IDS = 50;
export const CHAT_INPUT_RUN_ID_MAX_CHARS = 256;
