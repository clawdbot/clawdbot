// Shared spawn mode enums used by the session tool, registry, and announce
// delivery code. Keep these narrow so tool schemas and persisted registry rows
// agree on the same literals.
export const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];

/** Sandbox escalation policy requested for a spawned subagent. */
export const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];

/** Prompt context relationship between the parent session and spawned subagent. */
export const SUBAGENT_SPAWN_CONTEXT_MODES = ["isolated", "fork"] as const;
export type SpawnSubagentContextMode = (typeof SUBAGENT_SPAWN_CONTEXT_MODES)[number];
