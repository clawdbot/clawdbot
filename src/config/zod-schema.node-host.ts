import { z } from "zod";
import { NODE_WORKER_CAPACITY_MAX } from "../infra/node-runner-inventory.js";

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

export const NodeHostWorkerRunsSchema = z
  .object({
    enabled: z.boolean().optional(),
    capacity: z.number().int().min(1).max(NODE_WORKER_CAPACITY_MAX).optional(),
    isolation: z.enum(["none", "container"]).optional(),
    containerImage: z.string().trim().min(1).optional(),
  })
  .strict()
  .optional();
