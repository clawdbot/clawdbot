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
