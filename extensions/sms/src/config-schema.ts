// Sms helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  buildMultiAccountChannelSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const SecretInputSchema = buildSecretInputSchema();

const SmsCommonAccountShape = buildCommonChannelAccountShape({
  dmPolicyDefault: true,
  omit: [
    "capabilities",
    "markdown",
    "groupAllowFrom",
    "groupPolicy",
    "mentionPatterns",
    "contextVisibility",
    "historyLimit",
    "dmHistoryLimit",
    "dms",
    "streaming",
    "heartbeatVisibility",
    "healthMonitor",
    "responsePrefix",
    "mediaMaxMb",
    "replyToMode",
  ],
});

const SmsAccountConfigSchema = z
  .object({
    name: SmsCommonAccountShape.name,
    enabled: SmsCommonAccountShape.enabled,
    configWrites: SmsCommonAccountShape.configWrites,
    accountSid: z.string().optional(),
    authToken: SecretInputSchema.optional(),
    fromNumber: z.string().optional(),
    messagingServiceSid: z.string().optional(),
    defaultTo: SmsCommonAccountShape.defaultTo,
    webhookPath: z.string().optional(),
    publicWebhookUrl: z.string().optional(),
    dangerouslyDisableSignatureValidation: z.boolean().optional(),
    dmPolicy: SmsCommonAccountShape.dmPolicy,
    allowFrom: SmsCommonAccountShape.allowFrom,
    textChunkLimit: SmsCommonAccountShape.textChunkLimit,
  })
  .strict();

const SmsConfigSchema = buildMultiAccountChannelSchema(SmsAccountConfigSchema, {
  optionalAccount: true,
  refine: (value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "sms",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  },
});

export const SmsChannelConfigSchema = buildChannelConfigSchema(SmsConfigSchema, {
  uiHints: {
    "": {
      label: "SMS",
      help: "Twilio SMS/MMS channel configuration for inbound webhooks and outbound replies.",
    },
    accountSid: {
      label: "Twilio Account SID",
      help: "Twilio Account SID used for SMS outbound API calls.",
    },
    authToken: {
      label: "Twilio Auth Token",
      help: "Twilio Auth Token used to sign webhook validation and SMS outbound API calls.",
    },
    fromNumber: {
      label: "SMS From Number",
      help: "Twilio SMS-capable phone number in E.164 format; outbound attachments also require MMS capability.",
      presentation: "phone-number",
    },
    messagingServiceSid: {
      label: "Twilio Messaging Service SID",
      help: "Twilio Messaging Service SID to use instead of a dedicated fromNumber.",
    },
    defaultTo: {
      label: "SMS Default To Number",
      help: "Optional default outbound phone number used when a send flow omits an explicit SMS target.",
      presentation: "phone-number",
    },
    publicWebhookUrl: {
      label: "SMS Public Webhook URL",
      help: "Public URL configured in Twilio for incoming messages. Must match Twilio's signed URL exactly; outbound MMS also requires this same path to be reachable over HTTPS.",
    },
    webhookPath: {
      label: "SMS Webhook Path",
      help: "Gateway HTTP path that receives Twilio incoming-message webhooks. Use a distinct path per account.",
    },
    dmPolicy: {
      label: "SMS DM Policy",
      help: 'Direct SMS access control ("pairing" recommended). "open" requires channels.sms.allowFrom=["*"].',
    },
    allowFrom: {
      label: "SMS Allow From",
      help: "Allowed sender phone numbers in E.164 format, or * when dmPolicy is open.",
      presentation: "phone-number",
    },
    "accounts.*.fromNumber": { presentation: "phone-number" },
    "accounts.*.defaultTo": { presentation: "phone-number" },
    "accounts.*.allowFrom.*": { presentation: "phone-number" },
    textChunkLimit: {
      label: "SMS Text Chunk Limit",
      help: "Maximum characters per outbound SMS chunk before OpenClaw splits long replies.",
    },
  },
});
