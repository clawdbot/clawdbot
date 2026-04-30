import { z } from "zod";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeStringEntries } from "../shared/string-normalization.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import {
  ChannelHealthMonitorSchema,
  ChannelHeartbeatVisibilitySchema,
} from "./zod-schema.channels.js";
import {
  BlockStreamingCoalesceSchema,
  ContextVisibilityModeSchema,
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyToModeSchema,
} from "./zod-schema.core.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const WhatsAppGroupEntrySchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

const WhatsAppGroupsSchema = z.record(z.string(), WhatsAppGroupEntrySchema).optional();

const WhatsAppDirectEntrySchema = z
  .object({
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

const WhatsAppDirectSchema = z.record(z.string(), WhatsAppDirectEntrySchema).optional();

const WhatsAppAckReactionSchema = z
  .object({
    emoji: z.string().optional(),
    direct: z.boolean().optional().default(true),
    group: z.enum(["always", "mentions", "never"]).optional().default("mentions"),
  })
  .strict()
  .optional();

function stripDeprecatedWhatsAppNoopKeys(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  if (!Object.hasOwn(value, "exposeErrorText")) {
    return value;
  }
  const next = { ...(value as Record<string, unknown>) };
  delete next.exposeErrorText;
  return next;
}

function buildWhatsAppCommonShape(params: { useDefaults: boolean }) {
  return {
    enabled: z.boolean().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    configWrites: z.boolean().optional(),
    sendReadReceipts: z.boolean().optional(),
    messagePrefix: z.string().optional(),
    responsePrefix: z.string().optional(),
    dmPolicy: params.useDefaults
      ? DmPolicySchema.optional().default("pairing")
      : DmPolicySchema.optional(),
    selfChatMode: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    defaultTo: z.string().optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groupPolicy: params.useDefaults
      ? GroupPolicySchema.optional().default("allowlist")
      : GroupPolicySchema.optional(),
    contextVisibility: ContextVisibilityModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    groups: WhatsAppGroupsSchema,
    direct: WhatsAppDirectSchema,
    ackReaction: WhatsAppAckReactionSchema,
    reactionLevel: z.enum(["off", "ack", "minimal", "extensive"]).optional(),
    debounceMs: params.useDefaults
      ? z.number().int().nonnegative().optional().default(0)
      : z.number().int().nonnegative().optional(),
    replyToMode: ReplyToModeSchema.optional(),
    heartbeat: ChannelHeartbeatVisibilitySchema,
    healthMonitor: ChannelHealthMonitorSchema,
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
    enabled: z.boolean().optional(),
    /** Override auth directory for this WhatsApp account (Baileys multi-file auth state). */
    authDir: z.string().optional(),
    mediaMaxMb: z.number().int().positive().optional(),
  })
  .strict();

export const WhatsAppAccountSchema = z.preprocess(
  stripDeprecatedWhatsAppNoopKeys,
  WhatsAppAccountObjectSchema,
);

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

export const WhatsAppConfigSchema = z.preprocess(
  stripDeprecatedWhatsAppNoopKeys,
  WhatsAppConfigObjectSchema,
);
