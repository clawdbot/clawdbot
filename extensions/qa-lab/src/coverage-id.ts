import { z } from "zod";

export const qaCoverageIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/, {
    message: "coverage ids must use exactly <surface-id>.<feature-id>",
  });
