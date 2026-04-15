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

const QQBotSpeechQueryParamsSchema = z.record(z.string(), z.string()).optional();

const QQBotTtsSchema = z
  .object({
    enabled: z.boolean().optional(),
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    model: z.string().optional(),
    voice: z.string().optional(),
    authStyle: z.enum(["bearer", "api-key"]).optional(),
    queryParams: QQBotSpeechQueryParamsSchema,
    speed: z.number().optional(),
  })
  .strict()
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

const QQBotStreamingSchema = z
  .union([
    z.boolean(),
    z
      .object({
        /** "partial" (default) enables block streaming; "off" disables it. */
        mode: z.enum(["off", "partial"]).default("partial"),
      })
      .passthrough(),
  ])
  .optional();

const QQBotAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    appId: z.string().optional(),
    clientSecret: buildSecretInputSchema().optional(),
    clientSecretFile: z.string().optional(),
    allowFrom: AllowFromListSchema,
    systemPrompt: z.string().optional(),
    markdownSupport: z.boolean().optional(),
    voiceDirectUploadFormats: z.array(z.string()).optional(),
    audioFormatPolicy: AudioFormatPolicySchema,
    urlDirectUpload: z.boolean().optional(),
    upgradeUrl: z.string().optional(),
    upgradeMode: z.enum(["doc", "hot-reload"]).optional(),
    streaming: QQBotStreamingSchema,
  })
  .passthrough();

export const QQBotConfigSchema = QQBotAccountSchema.extend({
  tts: QQBotTtsSchema,
  stt: QQBotSttSchema,
  accounts: z.object({}).catchall(QQBotAccountSchema.passthrough()).optional(),
  defaultAccount: z.string().optional(),
}).passthrough();
export const qqbotChannelConfigSchema = buildChannelConfigSchema(QQBotConfigSchema);
