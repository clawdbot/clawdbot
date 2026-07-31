/** Named queue lanes for work that must not interleave with the main command stream. */
export const enum CommandLane {
  Main = "main",
  SystemAgent = "system-agent",
  Cron = "cron",
  CronNested = "cron-nested",
  SkillWorkshopReview = "skill-workshop-review",
  Subagent = "subagent",
  Nested = "nested",
}
