import { z } from "zod";
import type { ChannelsConfig } from "./types.channels.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";
import { ContextVisibilityModeSchema, GroupPolicySchema } from "./zod-schema.core.js";

export * from "./zod-schema.providers-core.js";
export * from "./zod-schema.providers-whatsapp.js";
export { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

const ChannelModelByChannelSchema = z
  .record(z.string(), z.record(z.string(), z.string()))
  .optional();

function addLegacyChannelAcpBindingIssues(
  value: unknown,
  ctx: z.RefinementCtx,
  path: Array<string | number> = [],
) {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => addLegacyChannelAcpBindingIssues(entry, ctx, [...path, index]));
    return;
  }

  const record = value as Record<string, unknown>;
  const bindings = record.bindings;
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    const acp = (bindings as Record<string, unknown>).acp;
    if (acp && typeof acp === "object") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, "bindings", "acp"],
        message:
          "Legacy channel-local ACP bindings were removed; use top-level bindings[] entries.",
      });
    }
  }

  for (const [key, entry] of Object.entries(record)) {
    addLegacyChannelAcpBindingIssues(entry, ctx, [...path, key]);
  }
}

export const ChannelsSchema: z.ZodType<ChannelsConfig | undefined> = z
  .object({
    defaults: z
      .object({
        groupPolicy: GroupPolicySchema.optional(),
        contextVisibility: ContextVisibilityModeSchema.optional(),
        heartbeat: ChannelHeartbeatVisibilitySchema,
      })
      .strict()
      .optional(),
    modelByChannel: ChannelModelByChannelSchema,
  })
  .passthrough() // Allow extension channel configs (nostr, matrix, zalo, etc.)
  .superRefine((value, ctx) => {
    addLegacyChannelAcpBindingIssues(value, ctx);
  })
  .optional() as z.ZodType<ChannelsConfig | undefined>;
