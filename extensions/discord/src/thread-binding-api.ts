// Discord API module exposes the plugin public contract.
// Single source for the top-level artifact and the runtime plugin so the
// fast-path placement hint cannot drift from conversationBindings.
export const defaultTopLevelPlacement = "child" as const;
