import type { SkillWorkshopConfig } from "./config.js";

export function buildWorkshopGuidance(config: SkillWorkshopConfig): string {
  const writeMode =
    config.approvalPolicy === "auto"
      ? "Auto mode: apply safe workspace-skill updates; apply=false queues instead."
      : "Pending mode: queue suggestions; use apply action after explicit approval.";
  return [
    "<skill_workshop>",
    "Use for durable procedural memory, not facts/preferences.",
    "Capture only repeatable workflows, user corrections, non-obvious successful procedures, recurring pitfalls.",
    "If a loaded skill is stale/wrong/thin, suggest append/replace; keep useful parts.",
    "After long tool loops or hard fixes, save the reusable procedure.",
    "Keep skill text short, imperative, tool-aware. No transcript dumps.",
    writeMode,
    "</skill_workshop>",
  ].join("\n");
}
