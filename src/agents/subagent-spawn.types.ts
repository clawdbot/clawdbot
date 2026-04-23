export const SUBAGENT_SPAWN_MODES = ["run", "session"] as const;
export type SpawnSubagentMode = (typeof SUBAGENT_SPAWN_MODES)[number];

export const SUBAGENT_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnSubagentSandboxMode = (typeof SUBAGENT_SPAWN_SANDBOX_MODES)[number];

export const SUBAGENT_SPAWN_CONTEXT_MODES = ["isolated", "fork"] as const;
export type SpawnSubagentContextMode = (typeof SUBAGENT_SPAWN_CONTEXT_MODES)[number];
