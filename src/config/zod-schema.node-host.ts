import { z } from "zod";

export const BrowserSnapshotDefaultsSchema = z
  .object({
    mode: z.literal("efficient").optional(),
  })
  .strict()
  .optional();

export const NodeHostAgentRunsSchema = z
  .object({
    claude: z
      .object({
        enabled: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();
