import { z } from "zod";
import { HOSTING_PROFILE_IDS } from "../hosting/profiles.js";

export const HostingConfigSchema = z
  .strictObject({
    profile: z.enum(HOSTING_PROFILE_IDS).optional(),
  })
  .optional();
