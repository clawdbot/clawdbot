import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { z } from "zod";
import type { UpdateRunRecordSchema } from "./update-run-schema.js";
import type { UpdateStepResult } from "./update-runner-types.js";

/** A bounded diagnostic excerpt for a failed update step, never its command log or cwd. */
export function summarizeUpdateStepFailure(
  step: Pick<UpdateStepResult, "exitCode" | "termination" | "stdoutTail" | "stderrTail">,
): string {
  return truncateUtf16Safe(
    [
      step.termination ?? `Exit code: ${step.exitCode ?? "unknown"}`,
      ...[step.stdoutTail, step.stderrTail].map((tail) =>
        sliceUtf16Safe(tail?.trim().split(/\r?\n/u).at(-1) ?? "", -120),
      ),
    ]
      .filter(Boolean)
      .join("; "),
    300,
  );
}

export type UpdateRunRecord = z.infer<typeof UpdateRunRecordSchema>;
export type UpdateRunPhase = UpdateRunRecord["phase"];
export type UpdateRunStep = UpdateRunRecord["steps"][number];
