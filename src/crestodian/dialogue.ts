// Crestodian dialogue parses direct commands and optionally asks the assistant planner.
import type { RuntimeEnv } from "../runtime.js";
import type { CrestodianAssistantPlan, CrestodianAssistantPlanner } from "./assistant.js";
import {
  describeCrestodianPersistentOperation,
  parseCrestodianOperation,
  type CrestodianOperation,
} from "./operations.js";
import { loadCrestodianOverview, type CrestodianOverview } from "./overview.js";

/**
 * Dialogue helpers for turning user text into Crestodian operations.
 *
 * Direct command parsing wins; the assistant planner is only consulted for
 * non-empty text that did not parse into a known operation.
 */
type CrestodianDialogueOptions = {
  loadOverview?: typeof loadCrestodianOverview;
  planWithAssistant?: CrestodianAssistantPlanner;
};

/** Format the interactive approval prompt for a persistent operation. */
export function approvalQuestion(operation: CrestodianOperation): string {
  return `Apply this operation: ${describeCrestodianPersistentOperation(operation)}?`;
}

/** Parse affirmative approval text accepted by the interactive dialogue. */
export function isYes(input: string): boolean {
  return /^(y|yes|apply|do it|approved?)$/i.test(input.trim());
}

/** Resolve user input to a Crestodian operation, optionally using the assistant planner. */
export async function resolveCrestodianOperation(
  input: string,
  runtime: RuntimeEnv,
  opts: CrestodianDialogueOptions,
): Promise<CrestodianOperation> {
  const operation = parseCrestodianOperation(input);
  if (!shouldAskAssistant(input, operation)) {
    return operation;
  }
  const overview = await (opts.loadOverview ?? loadCrestodianOverview)();
  const planner = opts.planWithAssistant ?? (await import("./assistant.js")).planCrestodianCommand;
  const plan = await planner({ input, overview });
  if (!plan) {
    return operation;
  }
  const planned = parseCrestodianOperation(plan.command);
  if (planned.kind === "none") {
    return operation;
  }
  logAssistantPlan(runtime, plan, overview);
  return planned;
}

function shouldAskAssistant(input: string, operation: CrestodianOperation): boolean {
  if (operation.kind !== "none") {
    return false;
  }
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed === "quit" || trimmed === "exit") {
    return false;
  }
  return true;
}

function logAssistantPlan(
  runtime: RuntimeEnv,
  plan: CrestodianAssistantPlan,
  overview: CrestodianOverview,
): void {
  // Assistant plans are echoed before execution so the user can see the interpreted command.
  const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
  runtime.log(`[crestodian] planner: ${modelLabel}`);
  if (plan.reply) {
    runtime.log(plan.reply);
  }
  runtime.log(`[crestodian] interpreted: ${plan.command}`);
}
