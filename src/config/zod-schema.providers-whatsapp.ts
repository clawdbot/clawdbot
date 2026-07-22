// Defines WhatsApp provider schema fragments for config parsing.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { z } from "zod";
import { buildGroupEntrySchema } from "../channels/plugins/config-schema.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import {
  ChannelSendReadReceiptsSchema,
  buildChannelReactionShape,
  buildCommonChannelAccountShape,
} from "./zod-schema.channel-messaging-common.js";
import { ChannelDeliveryStreamingConfigSchema } from "./zod-schema.core.js";

const WhatsAppGroupEntrySchema = buildGroupEntrySchema(undefined, {
  omit: ["skills", "enabled", "allowFrom"],
}).optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppDirectEntrySchema = z
  .object({
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

const WhatsAppDirectSchema = z.record(z.string(), WhatsAppDirectEntrySchema).optional();

const WhatsAppPluginHooksSchema = z
  .object({
    messageReceived: z.boolean().optional(),
  })
  .strict()
  .optional();

function buildWhatsAppCommonShape(params: { useDefaults: boolean }) {
  return {
    ...buildCommonChannelAccountShape({
      useDefaults: params.useDefaults,
      omit: ["name"],
      allowFrom: z.array(z.string()).optional(),
      groupAllowFrom: z.array(z.string()).optional(),
      streaming: ChannelDeliveryStreamingConfigSchema.optional(),
      mediaMaxMb: z.number().int().positive().optional(),
    }),
    sendReadReceipts: ChannelSendReadReceiptsSchema,
    selfChatMode: z.boolean().optional(),
    groups: WhatsAppGroupsSchema,
    direct: WhatsAppDirectSchema,
    ...buildChannelReactionShape({
      reactionLevels: ["off", "ack", "minimal", "extensive"],
    }),
    debounceMs: params.useDefaults
      ? z.number().int().nonnegative().optional().default(0)
      : z.number().int().nonnegative().optional(),
    pluginHooks: WhatsAppPluginHooksSchema,
  };
}

function enforceOpenDmPolicyAllowFromStar(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
  path?: Array<string | number>;
}) {
  if (params.dmPolicy !== "open") {
    return;
  }
  const allow = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []);
  if (allow.includes("*")) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path ?? ["allowFrom"],
    message: params.message,
  });
}

function enforceAllowlistDmPolicyAllowFrom(params: {
  dmPolicy: unknown;
  allowFrom: unknown;
  ctx: z.RefinementCtx;
  message: string;
  path?: Array<string | number>;
}) {
  if (params.dmPolicy !== "allowlist") {
    return;
  }
  const allow = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : []);
  if (allow.length > 0) {
    return;
  }
  params.ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: params.path ?? ["allowFrom"],
    message: params.message,
  });
}

const WhatsAppAccountObjectSchema = z
  .object({
    ...buildWhatsAppCommonShape({ useDefaults: false }),
    name: z.string().optional(),
    /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
    authDir: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
  })
  .strict();

const WhatsAppAccountSchema = WhatsAppAccountObjectSchema;

const WhatsAppConfigObjectSchema = z
  .object({
    ...buildWhatsAppCommonShape({ useDefaults: true }),
    accounts: z.record(z.string(), WhatsAppAccountSchema.optional()).optional(),
    defaultAccount: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional().default(50),
    actions: z
      .object({
        reactions: z.boolean().optional(),
        sendMessage: z.boolean().optional(),
        polls: z.boolean().optional(),
        calls: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const defaultAccount = resolveAccountEntry(value.accounts, "default");
    enforceOpenDmPolicyAllowFromStar({
      dmPolicy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.whatsapp.dmPolicy="open" requires channels.whatsapp.allowFrom to include "*"',
    });
    enforceAllowlistDmPolicyAllowFrom({
      dmPolicy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      message:
        'channels.whatsapp.dmPolicy="allowlist" requires channels.whatsapp.allowFrom to contain at least one sender ID',
    });
    if (!value.accounts) {
      return;
    }
    for (const [accountId, account] of Object.entries(value.accounts)) {
      if (!account) {
        continue;
      }
      const effectivePolicy =
        account.dmPolicy ??
        (accountId === "default" ? undefined : defaultAccount?.dmPolicy) ??
        value.dmPolicy;
      const effectiveAllowFrom =
        account.allowFrom ??
        (accountId === "default" ? undefined : defaultAccount?.allowFrom) ??
        value.allowFrom;
      enforceOpenDmPolicyAllowFromStar({
        dmPolicy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.whatsapp.accounts.*.dmPolicy="open" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to include "*"',
      });
      enforceAllowlistDmPolicyAllowFrom({
        dmPolicy: effectivePolicy,
        allowFrom: effectiveAllowFrom,
        ctx,
        path: ["accounts", accountId, "allowFrom"],
        message:
          'channels.whatsapp.accounts.*.dmPolicy="allowlist" requires channels.whatsapp.accounts.*.allowFrom (or channels.whatsapp.allowFrom) to contain at least one sender ID',
      });
    }
  });

export const WhatsAppConfigSchema = WhatsAppConfigObjectSchema;
