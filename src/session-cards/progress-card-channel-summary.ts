import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeProgressCardInput, ProgressCardInputError } from "./progress-card-input.js";

const PLAN_PROGRESS_TOOL_NAMES = new Set(["progress_card", "update_plan"]);

export function isAgentPlanProgressToolName(name: string | undefined): boolean {
  return PLAN_PROGRESS_TOOL_NAMES.has(name?.trim().toLowerCase() ?? "");
}

/** Projects durable card state without interpreting renderer-owned Markdown or HTML. */
export function projectProgressCardChannelUpdate(input: unknown) {
  const record = asOptionalRecord(input);
  if (!record) {
    return undefined;
  }
  try {
    const normalized = normalizeProgressCardInput(record);
    const steps = normalized.steps ?? [];
    const completed = steps.filter((step) => step.status === "completed").length;
    const explanation = steps.length
      ? `${completed}/${steps.length} complete`
      : normalized.markdown
        ? "Progress updated"
        : undefined;
    return { steps, ...(explanation ? { explanation } : {}) };
  } catch (error) {
    if (error instanceof ProgressCardInputError) {
      return undefined;
    }
    throw error;
  }
}
