import { z } from "zod";
import { collectExecDenylistErrors } from "../infra/exec-approvals-denylist.js";

export const ToolExecDenylistSchema = z
  .array(
    z
      .object({
        pattern: z.string().refine((value) => value.trim().length > 0, {
          message: "pattern must be a non-empty string",
        }),
        reason: z.string().optional(),
      })
      .strict(),
  )
  .superRefine((value, ctx) => {
    for (const message of collectExecDenylistErrors(value, "denylist")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });
