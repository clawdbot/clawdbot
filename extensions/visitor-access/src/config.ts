import { z } from "zod";
import { buildPluginConfigSchema } from "../api.js";

export const visitorConfigSchema = z.strictObject({
  accountId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  appId: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[a-zA-Z0-9_-]+$/),
  apiToken: z.string().min(1),
  policyName: z.string().trim().min(1).max(200).default("Visitors (openclaw-managed)"),
  defaultTtlDays: z.number().int().min(0).max(3650).nullable().default(14),
  maxVisitors: z.number().int().min(1).max(500).default(50),
});

export type VisitorAccessConfig = z.output<typeof visitorConfigSchema>;

export const visitorPluginSchema = buildPluginConfigSchema(visitorConfigSchema);
