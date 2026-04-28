import {
  AllowFromListSchema,
  buildChannelConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const AudioFormatPolicySchema = z
  .object({
    sttDirectFormats: z.array(z.string()).optional(),
    uploadDirectFormats: z.array(z.string()).optional(),
    transcodeEnabled: z.boolean().optional(),
  })
  .optional();

const QQBotSttSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
  })
  .strict()
  .optional();

/** When `true`, same as `mode: "partial"` and `c2cStreamApi: true` for C2C. Object form kept for legacy configs. */
const QQBotStreamingSchema = z
  .union([
    z.boolean(),
    z
      .object({
        /** "partial" (default) enables block streaming; "off" disables it. */
        mode: z.enum(["off", "partial"]).default("partial"),
        /** Use QQ C2C official stream_messages API; legacy, prefer `streaming: true`. */
        c2cStreamApi: z.boolean().optional(),
      })
      .passthrough(),
  ])
  .optional();

const QQBotExecApprovalsSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal("auto")]).optional(),
    approvers: z.array(z.string()).optional(),
    agentFilter: z.array(z.string()).optional(),
    sessionFilter: z.array(z.string()).optional(),
    target: z.enum(["dm", "channel", "both"]).optional(),
  })
  .strict()
  .optional();

const QQBotDmPolicySchema = z.enum(["open", "allowlist", "disabled"]).optional();
const QQBotGroupPolicySchema = z.enum(["open", "allowlist", "disabled"]).optional();

const QQBotAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    appId: z.string().optional(),
    clientSecret: buildSecretInputSchema().optional(),
    clientSecretFile: z.string().optional(),
    allowFrom: AllowFromListSchema,
    groupAllowFrom: AllowFromListSchema,
    dmPolicy: QQBotDmPolicySchema,
    groupPolicy: QQBotGroupPolicySchema,
    systemPrompt: z.string().optional(),
    markdownSupport: z.boolean().optional(),
    voiceDirectUploadFormats: z.array(z.string()).optional(),
    audioFormatPolicy: AudioFormatPolicySchema,
    urlDirectUpload: z.boolean().optional(),
    upgradeUrl: z.string().optional(),
    upgradeMode: z.enum(["doc", "hot-reload"]).optional(),
    streaming: QQBotStreamingSchema,
    execApprovals: QQBotExecApprovalsSchema,
  })
  .passthrough();

export const QQBotConfigSchema = QQBotAccountSchema.extend({
  stt: QQBotSttSchema,
  accounts: z.object({}).catchall(QQBotAccountSchema.passthrough()).optional(),
  defaultAccount: z.string().optional(),
}).passthrough();
export const qqbotChannelConfigSchema = buildChannelConfigSchema(QQBotConfigSchema);
