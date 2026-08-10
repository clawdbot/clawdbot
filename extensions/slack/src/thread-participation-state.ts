// Slack thread participation uses one bounded, non-expiring plugin-state namespace.
export const SLACK_THREAD_PARTICIPATION_STORE_OPTIONS = {
  namespace: "slack.thread-participation",
  maxEntries: 1000,
  clearExistingExpiryOnOpen: true,
} as const;
