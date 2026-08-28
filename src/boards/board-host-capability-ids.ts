export const CORE_BOARD_DATA_BINDING_IDS = [
  "sessions.list",
  "usage.status",
  "usage.cost",
  "cron.list",
  "cron.status",
  "agents.list",
  "health",
] as const;

const CORE_BOARD_ACTION_VERB_IDS = ["cron.trigger"] as const;

/** Widget grants share one string namespace across reads and actions. */
export const CORE_BOARD_HOST_CAPABILITY_IDS = [
  ...CORE_BOARD_DATA_BINDING_IDS,
  ...CORE_BOARD_ACTION_VERB_IDS,
] as const;
