import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import {
  PROGRESS_CARD_MAX_STEP_UTF8_BYTES,
  PROGRESS_CARD_MAX_STEPS,
  PROGRESS_CARD_MAX_UTF8_BYTES,
  type ProgressCardStep,
} from "../../packages/gateway-protocol/src/index.js";
import { stripInvisibleUnicode } from "../infra/unicode-visibility.js";

export class ProgressCardInputError extends Error {}

type NormalizedProgressCardInput = {
  markdown?: string;
  steps?: ProgressCardStep[];
};

function isProgressCardStepStatus(value: unknown): value is ProgressCardStep["status"] {
  return value === "pending" || value === "in_progress" || value === "completed";
}

/** Validates and normalizes the replace-on-write progress-card payload. */
export function normalizeProgressCardInput(input: {
  markdown?: unknown;
  plan?: unknown;
}): NormalizedProgressCardInput {
  let markdown: string | undefined;
  if (input.markdown !== undefined) {
    if (typeof input.markdown !== "string") {
      throw new ProgressCardInputError("markdown must be a string");
    }
    if (Buffer.byteLength(input.markdown, "utf8") > PROGRESS_CARD_MAX_UTF8_BYTES) {
      throw new ProgressCardInputError(
        `progress card markdown exceeds ${PROGRESS_CARD_MAX_UTF8_BYTES} UTF-8 bytes`,
      );
    }
    const sanitized = stripInvisibleUnicode(input.markdown);
    if (sanitized.trim()) {
      markdown = sanitized;
    }
  }

  let steps: ProgressCardStep[] | undefined;
  if (input.plan !== undefined) {
    if (!Array.isArray(input.plan)) {
      throw new ProgressCardInputError("plan must be an array");
    }
    if (input.plan.length > PROGRESS_CARD_MAX_STEPS) {
      throw new ProgressCardInputError(`plan can contain at most ${PROGRESS_CARD_MAX_STEPS} steps`);
    }
    const normalizedSteps: ProgressCardStep[] = [];
    let inProgressCount = 0;
    for (const [index, entry] of input.plan.entries()) {
      const record = asOptionalObjectRecord(entry);
      if (!record) {
        throw new ProgressCardInputError(`plan[${index}] must be an object`);
      }
      if (typeof record.step !== "string") {
        throw new ProgressCardInputError(`plan[${index}].step must be a string`);
      }
      if (Buffer.byteLength(record.step, "utf8") > PROGRESS_CARD_MAX_STEP_UTF8_BYTES) {
        throw new ProgressCardInputError(
          `plan[${index}].step exceeds ${PROGRESS_CARD_MAX_STEP_UTF8_BYTES} UTF-8 bytes`,
        );
      }
      const step = stripInvisibleUnicode(record.step);
      if (!step.trim()) {
        throw new ProgressCardInputError(`plan[${index}].step must not be empty`);
      }
      if (!isProgressCardStepStatus(record.status)) {
        throw new ProgressCardInputError(
          `plan[${index}].status must be one of pending, in_progress, completed`,
        );
      }
      if (record.status === "in_progress") {
        inProgressCount += 1;
      }
      normalizedSteps.push({ step, status: record.status });
    }
    if (inProgressCount > 1) {
      throw new ProgressCardInputError("plan can contain at most one in_progress step");
    }
    if (normalizedSteps.length > 0) {
      steps = normalizedSteps;
    }
  }

  return {
    ...(markdown ? { markdown } : {}),
    ...(steps ? { steps } : {}),
  };
}
