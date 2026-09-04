// Native session flags override these layers. Legacy managed layers sit above
// them, so app admission and restricted turns cannot replace their tool policy.
export const CODEX_SESSION_OVERRIDABLE_LAYER_TYPES = new Set([
  "packagedDefaults",
  "mdm",
  "system",
  "enterpriseManaged",
  "user",
  "project",
  "sessionFlags",
]);
