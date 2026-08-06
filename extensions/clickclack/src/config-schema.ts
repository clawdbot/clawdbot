/**
 * Zod-backed config schema for ClickClack channel accounts.
 */
import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildSecretInputSchema } from "openclaw/plugin-sdk/secret-input";
import { z } from "zod";

const MANAGED_AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

const ClickClackAccountConfigSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    // Managed-only accounts accept only bound host-managed channels and are
    // selected by agent id for session discussions.
    managedOnly: z.boolean().optional(),
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
    defaultTo: z.string().optional(),
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

function validateManagedOnlyAccount(
  value: { managedOnly?: boolean; agentId?: string },
  ctx: z.RefinementCtx,
): void {
  if (value.managedOnly === true && !MANAGED_AGENT_ID_RE.test(value.agentId?.trim() ?? "")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["agentId"],
      message: "managedOnly accounts require a valid agentId",
    });
  }
}

type ClickClackDiscussionConfigValue = {
  enabled?: boolean;
};

type ClickClackManagedAccountConfigValue = {
  managedOnly?: boolean;
  discussions?: ClickClackDiscussionConfigValue;
};

function validateManagedOnlyDiscussions(
  value: ClickClackManagedAccountConfigValue & {
    accounts?: Record<string, ClickClackManagedAccountConfigValue>;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.managedOnly === true && value.discussions?.enabled !== true) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["discussions", "enabled"],
      message: "managedOnly accounts require discussions.enabled=true",
    });
  }
  for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
    if (
      account.managedOnly === true &&
      (account.discussions?.enabled ?? value.discussions?.enabled) !== true
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accounts", accountId, "discussions", "enabled"],
        message: "managedOnly accounts require discussions.enabled=true",
      });
    }
  }
}

const ClickClackAccountConfigSchema = ClickClackAccountConfigSchemaBase.superRefine(
  validateManagedOnlyAccount,
);
const ClickClackConfigSchema = buildMultiAccountChannelSchema(ClickClackAccountConfigSchema, {
  accountSchema: ClickClackAccountConfigSchemaBase.partial().superRefine(
    validateManagedOnlyAccount,
  ),
});
const ClickClackValidatedConfigSchema = ClickClackConfigSchema.superRefine(
  validateManagedOnlyDiscussions,
);

/**
 * Config schema exported to core so `openclaw doctor` and config validation
 * understand both default and named ClickClack accounts.
 */
export const clickClackConfigSchema = buildChannelConfigSchema(ClickClackValidatedConfigSchema);
