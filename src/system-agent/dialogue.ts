// OpenClaw dialogue parses direct commands and optionally asks the assistant planner.
import type { RuntimeEnv } from "../runtime.js";
import type { SystemAgentAssistantPlan, SystemAgentAssistantPlanner } from "./assistant.js";
import { SystemAgentInferenceUnavailableError } from "./inference-error.js";
import {
  describeSystemAgentPersistentOperation,
  parseSystemAgentOperation,
  type SystemAgentOperation,
} from "./operations.js";
import { loadSystemAgentOverview, type SystemAgentOverview } from "./overview.js";
import {
  resolveSystemAgentVerifiedInferenceRoute,
  type SystemAgentVerifiedInferenceBinding,
  type SystemAgentVerifiedInferenceDeps,
} from "./verified-inference.js";

/**
 * Dialogue helpers for turning user text into OpenClaw operations.
 *
 * Direct command parsing wins; the assistant planner is only consulted for
 * non-empty text that did not parse into a known operation.
 */
type SystemAgentDialogueOptions = {
  loadOverview?: typeof loadSystemAgentOverview;
  planWithAssistant?: SystemAgentAssistantPlanner;
  deps?: SystemAgentVerifiedInferenceDeps;
  readonly verifiedInference: SystemAgentVerifiedInferenceBinding;
};

/** Format the interactive approval prompt for a persistent operation. */
export function approvalQuestion(operation: SystemAgentOperation): string {
  return `Apply this operation: ${describeSystemAgentPersistentOperation(operation)}?`;
}

/** Resolve user input to an OpenClaw operation, optionally using the assistant planner. */
export async function resolveSystemAgentOperation(
  input: string,
  runtime: RuntimeEnv,
  opts: SystemAgentDialogueOptions,
): Promise<SystemAgentOperation> {
  if (!opts.verifiedInference) {
    throw new SystemAgentInferenceUnavailableError("conversation");
  }
  const operation = parseSystemAgentOperation(input);
  if (!shouldAskAssistant(input, operation)) {
    return operation;
  }
  const overview = await (opts.loadOverview ?? loadSystemAgentOverview)();
  const planner = opts.planWithAssistant ?? (await import("./assistant.js")).planSystemAgentCommand;
  let plan: SystemAgentAssistantPlan | null;
  try {
    plan = await planner({
      input,
      overview,
      verifiedInference: opts.verifiedInference,
    });
    if (
      plan &&
      !(await resolveSystemAgentVerifiedInferenceRoute(opts.verifiedInference, opts.deps))
    ) {
      throw new SystemAgentInferenceUnavailableError("planner");
    }
  } catch (error) {
    if (error instanceof SystemAgentInferenceUnavailableError) {
      throw error;
    }
    throw new SystemAgentInferenceUnavailableError("planner", [error]);
  }
  if (!plan) {
    throw new SystemAgentInferenceUnavailableError("planner");
  }
  if (!plan.command) {
    if (!plan.reply?.trim()) {
      throw new SystemAgentInferenceUnavailableError("planner");
    }
    runtime.log(plan.reply);
    return { kind: "none", message: "" };
  }
  const planned = parseSystemAgentOperation(plan.command);
  if (planned.kind === "none") {
    throw new SystemAgentInferenceUnavailableError("planner");
  }
  logAssistantPlan(runtime, plan, overview);
  return planned;
}

function shouldAskAssistant(input: string, operation: SystemAgentOperation): boolean {
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
  plan: SystemAgentAssistantPlan,
  overview: SystemAgentOverview,
): void {
  // Assistant plans are echoed before execution so the user can see the interpreted command.
  const modelLabel = plan.modelLabel ?? overview.defaultModel ?? "configured model";
  runtime.log(`[openclaw] planner: ${modelLabel}`);
  if (plan.reply) {
    runtime.log(plan.reply);
  }
  runtime.log(`[openclaw] interpreted: ${plan.command}`);
}
