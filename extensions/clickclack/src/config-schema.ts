/**
 * Zod-backed config schema for ClickClack channel accounts.
 */
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const ClickClackCommonAccountShape = buildCommonChannelAccountShape({
  omit: [
    "capabilities",
    "markdown",
    "dmPolicy",
    "allowFrom",
    "groupAllowFrom",
    "groupPolicy",
    "mentionPatterns",
    "contextVisibility",
    "historyLimit",
    "dmHistoryLimit",
    "dms",
    "textChunkLimit",
    "streaming",
    "heartbeatVisibility",
    "healthMonitor",
    "responsePrefix",
    "mediaMaxMb",
    "replyToMode",
  ],
});

const ClickClackAccountConfigSchema = z
  .object({
    name: ClickClackCommonAccountShape.name,
    enabled: ClickClackCommonAccountShape.enabled,
    configWrites: ClickClackCommonAccountShape.configWrites,
    baseUrl: z.string().url().optional(),
    apiBaseUrl: z.string().url().optional(),
    token: buildSecretInputSchema().optional(),
    tokenFile: z.string().optional(),
    workspace: z.string().optional(),
    botUserId: z.string().optional(),
    agentId: z.string().optional(),
    replyMode: z.enum(["agent", "model"]).optional(),
    model: z.string().optional(),
    systemPrompt: z.string().optional(),
    toolsAllow: z.array(z.string()).optional(),
    defaultTo: ClickClackCommonAccountShape.defaultTo,
    allowFrom: z.array(z.string()).optional(),
    reconnectMs: z.number().int().min(100).max(60_000).optional(),
    agentActivity: z.boolean().optional(),
    commandMenu: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    mentionPatterns: z.array(z.string()).optional(),
    groups: z
      .record(
        z.string(),
        z
          .object({
            requireMention: z.boolean().optional(),
            mentionPatterns: z.array(z.string()).optional(),
          })
          .strict(),
      )
      .optional(),
    discussions: z
      .object({
        enabled: z.boolean().optional(),
        workspace: z.string().optional(),
        controlUrlBase: z.string().url().optional(),
        section: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ClickClackConfigSchema = buildMultiAccountChannelSchema(ClickClackAccountConfigSchema, {
  accountSchema: ClickClackAccountConfigSchema.partial(),
});

/**
 * Config schema exported to core so `openclaw doctor` and config validation
 * understand both default and named ClickClack accounts.
 */
export const clickClackConfigSchema = buildChannelConfigSchema(ClickClackConfigSchema);
