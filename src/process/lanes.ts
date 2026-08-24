/** Named queue lanes for work that must not interleave with the main command stream. */
export const enum CommandLane {
  Main = "main",
  SystemAgent = "system-agent",
  Cron = "cron",
  CronNested = "cron-nested",
  /**
   * External hook agent-run dispatch. Distinct from `cron-nested` so hook work
   * is schedulable in its own right; capacity is bounded by the shared lane
   * group rather than by adding a slot outside the cron budget.
   */
  HookDispatch = "hook-dispatch",
  SkillWorkshopReview = "skill-workshop-review",
  Subagent = "subagent",
  Nested = "nested",
}

// Keep the exported diagnostics inventory closed so per-session lanes cannot
// turn a saturation snapshot into an unbounded payload.
export const STATIC_COMMAND_LANES = [
  CommandLane.Main,
  CommandLane.SystemAgent,
  CommandLane.Cron,
  CommandLane.CronNested,
  CommandLane.HookDispatch,
  CommandLane.SkillWorkshopReview,
  CommandLane.Subagent,
  CommandLane.Nested,
] as const;
