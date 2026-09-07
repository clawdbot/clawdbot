// Slack plugin module implements limits behavior.
export const SLACK_TEXT_LIMIT = 8000;

// Slack recommends no more than 4,000 characters for chat.postMessage text.
// Longer fallback posts can be split while the API returns only one timestamp.
// https://api.slack.com/methods/chat.postMessage#truncating
export const SLACK_MESSAGE_TEXT_RECOMMENDED_LIMIT = 4_000;

// chat.update documents 4,000 characters but rejects text above 4,000 UTF-8 bytes in live use.
// https://docs.slack.dev/reference/methods/chat.update/#errors
export const SLACK_EDIT_TEXT_MAX_BYTES = 4_000;

// Slack truncates chat.postMessage text above 40,000 characters.
// https://api.slack.com/methods/chat.postMessage#truncating
export const SLACK_MESSAGE_TEXT_HARD_LIMIT = 40_000;
