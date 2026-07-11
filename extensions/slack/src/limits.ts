// Slack plugin module implements limits behavior.
export const SLACK_TEXT_LIMIT = 8000;

// chat.update rejects text above 4,000 characters with msg_too_long.
// https://docs.slack.dev/reference/methods/chat.update/#errors
export const SLACK_EDIT_TEXT_LIMIT = 4_000;

// Slack truncates chat.postMessage text above 40,000 characters.
// https://api.slack.com/methods/chat.postMessage#truncating
export const SLACK_MESSAGE_TEXT_HARD_LIMIT = 40_000;
