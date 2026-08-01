// Leaf contract for memory plugin role identifiers shared by config, SDK, hooks, and runtime surfaces.
export const MEMORY_PLUGIN_ROLES = [
  "recall",
  "compaction",
  "capture",
  "dreaming",
  "userModel",
] as const;

export type MemoryPluginRole = (typeof MEMORY_PLUGIN_ROLES)[number];
export type MemoryPluginRoleSlotKey = `memory.${MemoryPluginRole}`;

export const MEMORY_PLUGIN_ROLE_SLOT_KEYS = MEMORY_PLUGIN_ROLES.map(
  (role): MemoryPluginRoleSlotKey => `memory.${role}`,
);
