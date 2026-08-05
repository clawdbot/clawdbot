import { z } from "zod";
import { HOSTING_PROFILE_IDS } from "../hosting/types.js";

export const HostingConfigSchema = z
  .strictObject({
    profile: z.enum(HOSTING_PROFILE_IDS).optional(),
  })
  .optional();
