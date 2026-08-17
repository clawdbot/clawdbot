// Microsoft Teams helper module supports config schema behavior.
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  ChannelDangerouslyAllowNameMatchingSchema,
  ChannelPreviewStreamingConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MSTeamsReplyStyleSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildSecretInputSchema,
  registerSensitiveConfigSchema,
} from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";
import { refineMSTeamsConfig } from "./config-schema-refinement.js";
import { msTeamsChannelConfigUiHints } from "./config-ui-hints.js";

const SecretInputSchema = buildSecretInputSchema();
const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const MSTeamsChannelSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
  })
  .strict();

const MSTeamsTeamSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    channels: z.record(z.string(), MSTeamsChannelSchema.optional()).optional(),
  })
  .strict();

const MSTEAMS_SERVICE_URL_HOST_ALLOWLIST = [
  "smba.trafficmanager.net",
  "smba.infra.gcc.teams.microsoft.com",
  "smba.infra.gov.teams.microsoft.us",
  "smba.infra.dod.teams.microsoft.us",
  "botframework.azure.cn",
] as const;

function isAllowedMSTeamsServiceUrl(value: string): boolean {
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:") {
      return false;
    }
    const host = parsed.hostname.toLowerCase();
    return MSTEAMS_SERVICE_URL_HOST_ALLOWLIST.some(
      (allowed) => host === allowed || host.endsWith(`.${allowed}`),
    );
  } catch {
    return false;
  }
}

const MSTeamsAccountConfigBaseSchema = z
  .object({
    name: z.string().optional(),
    ...buildCommonChannelAccountShape({
      useDefaults: true,
      omit: ["name", "mentionPatterns", "replyToMode"],
      allowFrom: z.array(z.string()).optional(),
      groupAllowFrom: z.array(z.string()).optional(),
      streaming: ChannelPreviewStreamingConfigSchema.optional(),
    }),
    dangerouslyAllowNameMatching: ChannelDangerouslyAllowNameMatchingSchema,
    appId: z.string().optional(),
    appPassword: registerSensitiveConfigSchema(SecretInputSchema.optional()),
    tenantId: z.string().optional(),
    cloud: z.enum(["Public", "USGov", "USGovDoD", "China"]).optional(),
    serviceUrl: z
      .string()
      .url()
      .refine(isAllowedMSTeamsServiceUrl, {
        message:
          "channels.msteams.serviceUrl must use a supported Microsoft Teams Bot Connector host",
      })
      .optional(),
    authType: z.enum(["secret", "federated"]).optional(),
    certificatePath: z.string().optional(),
    certificateThumbprint: z.string().optional(),
    useManagedIdentity: z.boolean().optional(),
    managedIdentityClientId: z.string().optional(),
    webhook: z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        path: z.string().optional(),
      })
      .strict()
      .optional(),
    typingIndicator: z.boolean().optional(),
    mediaAllowHosts: z.array(z.string()).optional(),
    mediaAuthAllowHosts: z.array(z.string()).optional(),
    graphMediaFallback: z.boolean().optional(),
    requireMention: z.boolean().optional(),
    replyStyle: MSTeamsReplyStyleSchema.optional(),
    teams: z.record(z.string(), MSTeamsTeamSchema.optional()).optional(),
    /** Max inbound and outbound media size in MB (default: 100MB). */
    /** SharePoint site ID for file uploads in group chats/channels (e.g., "contoso.sharepoint.com,guid1,guid2") */
    sharePointSiteId: z.string().optional(),
    welcomeCard: z.boolean().optional(),
    promptStarters: z.array(z.string()).optional(),
    groupWelcomeCard: z.boolean().optional(),
    feedbackEnabled: z.boolean().optional(),
    feedbackReflection: z.boolean().optional(),
    feedbackReflectionCooldownMs: z.number().int().min(0).optional(),
    delegatedAuth: z
      .object({
        enabled: z.boolean().optional(),
        scopes: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    sso: z
      .object({
        enabled: z.boolean().optional(),
        connectionName: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const MSTeamsAccountConfigSchema = MSTeamsAccountConfigBaseSchema.extend({
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  groupPolicy: GroupPolicySchema.optional().default("allowlist"),
});

export const MSTeamsConfigSchema = MSTeamsAccountConfigSchema.extend({
  accounts: z.record(z.string(), MSTeamsAccountConfigBaseSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
})
  .strict()
  .superRefine(refineMSTeamsConfig);

export const MSTeamsChannelConfigSchema = buildChannelConfigSchema(MSTeamsConfigSchema, {
  uiHints: msTeamsChannelConfigUiHints,
});
