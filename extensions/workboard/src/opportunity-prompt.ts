import type { OpenClawPluginApi } from "../api.js";

export const WORKBOARD_OPPORTUNITY_PROMPT_SECTION = [
  "## Workboard opportunity capture",
  "When the current-turn context contains `✨ SKILL OPPORTUNITY` and `workboard_create` is available, call it exactly once before replying.",
  "Use status=todo and the supplied Opportunity idempotency key as `idempotencyKey`; use a concise title and notes containing the observed workflow, benefit, evidence, source, proposal status, and explicit approval boundary.",
  "Do not claim a Workboard card id unless `workboard_create` succeeds. If the tool is unavailable or fails, keep the opportunity block visible and state `Workboard card: [blocked] <reason>`.",
  "Creating a Workboard card does not create, apply, publish, or modify a skill; keep the explicit approval boundary visible.",
  "",
].join("\n");

export function registerWorkboardOpportunityPrompt(params: { api: OpenClawPluginApi }): void {
  params.api.on("before_prompt_build", () => ({
    prependSystemContext: WORKBOARD_OPPORTUNITY_PROMPT_SECTION,
  }));
}
