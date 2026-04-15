import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { z } from "openclaw/plugin-sdk/zod";
export { z };
import { buildSecretInputSchema, hasConfiguredSecretInput } from "./secret-input.js";

const ChannelActionsSchema = z
  .object({
    reactions: z.boolean().optional(),
  })
  .strict()
  .optional();

const DmPolicySchema = z.enum(["open", "pairing", "allowlist"]);
const GroupPolicySchema = z.union([
  z.enum(["open", "allowlist", "disabled"]),
  z.literal("allowall").transform(() => "open" as const),
]);
const FeishuDomainSchema = z.union([
  z.enum(["feishu", "lark"]),
  z.string().url().startsWith("https://"),
]);
const FeishuConnectionModeSchema = z.enum(["websocket", "webhook"]);

const ToolPolicySchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

const DmConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    systemPrompt: z.string().optional(),
  })
  .strict()
  .optional();

const MarkdownConfigSchema = z
  .object({
    mode: z.enum(["native", "escape", "strip"]).optional(),
    tableMode: z.enum(["native", "ascii", "simple"]).optional(),
  })
  .strict()
  .optional();

// Message render mode: auto (default) = detect markdown, raw = plain text, card = always card
const RenderModeSchema = z.enum(["auto", "raw", "card"]).optional();

// Streaming card mode: when enabled, card replies use Feishu's Card Kit streaming API
// for incremental text display with a "Thinking..." placeholder
const StreamingModeSchema = z.boolean().optional();

const BlockStreamingCoalesceSchema = z
  .object({
    enabled: z.boolean().optional(),
    minDelayMs: z.number().int().positive().optional(),
    maxDelayMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const ChannelHeartbeatVisibilitySchema = z
  .object({
    visibility: z.enum(["visible", "hidden"]).optional(),
    intervalMs: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

/**
 * Dynamic agent creation configuration.
 * When enabled, a new agent is created for each unique DM user.
 */
const DynamicAgentCreationSchema = z
  .object({
    enabled: z.boolean().optional(),
    workspaceTemplate: z.string().optional(),
    agentDirTemplate: z.string().optional(),
    maxAgents: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

/**
 * Feishu tools configuration.
 * Controls which tool categories are enabled.
 *
 * Dependencies:
 * - wiki requires doc (wiki content is edited via doc tools)
 * - perm can work independently but is typically used with drive
 */
const FeishuToolsConfigSchema = z
  .object({
    doc: z.boolean().optional(), // Document operations (default: true)
    chat: z.boolean().optional(), // Chat info + member query operations (default: true)
    wiki: z.boolean().optional(), // Knowledge base operations (default: true, requires doc)
    drive: z.boolean().optional(), // Cloud storage operations (default: true)
    perm: z.boolean().optional(), // Permission management (default: false, sensitive)
    scopes: z.boolean().optional(), // App scopes diagnostic (default: true)
  })
  .strict()
  .optional();

/**
 * Group session scope for routing Feishu group messages.
 * - "group" (default): one session per group chat
 * - "group_sender": one session per (group + sender)
 * - "group_topic": one session per group topic thread (falls back to group if no topic)
 * - "group_topic_sender": one session per (group + topic thread + sender),
 *   falls back to (group + sender) if no topic
 */
const GroupSessionScopeSchema = z
  .enum(["group", "group_sender", "group_topic", "group_topic_sender"])
  .optional();

/**
 * @deprecated Use groupSessionScope instead.
 *
 * Topic session isolation mode for group chats.
 * - "disabled" (default): All messages in a group share one session
 * - "enabled": Messages in different topics get separate sessions
 *
 * Topic routing uses `root_id` when present to keep session continuity and
 * falls back to `thread_id` when `root_id` is unavailable.
 */
const TopicSessionModeSchema = z.enum(["disabled", "enabled"]).optional();
const ReactionNotificationModeSchema = z.enum(["off", "own", "all"]).optional();

/**
 * Reply-in-thread mode for group chats.
 * - "disabled" (default): Bot replies are normal inline replies
 * - "enabled": Bot replies create or continue a Feishu topic thread
 *
 * When enabled, the Feishu reply API is called with `reply_in_thread: true`,
 * causing the reply to appear as a topic (话题) under the original message.
 */
const ReplyInThreadSchema = z.enum(["disabled", "enabled"]).optional();

export const FeishuGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
    groupSessionScope: GroupSessionScopeSchema,
    topicSessionMode: TopicSessionModeSchema,
    replyInThread: ReplyInThreadSchema,
  })
  .strict();

const FeishuSharedConfigShape = {
  webhookHost: z.string().optional(),
  webhookPort: z.number().int().positive().optional(),
  capabilities: z.array(z.string()).optional(),
  markdown: MarkdownConfigSchema,
  configWrites: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupPolicy: GroupPolicySchema.optional(),
  groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  groupSenderAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  requireMention: z.boolean().optional(),
  groups: z.record(z.string(), FeishuGroupSchema.optional()).optional(),
  historyLimit: z.number().int().min(0).optional(),
  dmHistoryLimit: z.number().int().min(0).optional(),
  dms: z.record(z.string(), DmConfigSchema).optional(),
  textChunkLimit: z.number().int().positive().optional(),
  chunkMode: z.enum(["length", "newline"]).optional(),
  blockStreamingCoalesce: BlockStreamingCoalesceSchema,
  mediaMaxMb: z.number().positive().optional(),
  httpTimeoutMs: z.number().int().positive().max(300_000).optional(),
  heartbeat: ChannelHeartbeatVisibilitySchema,
  renderMode: RenderModeSchema,
  streaming: StreamingModeSchema,
  tools: FeishuToolsConfigSchema,
  actions: ChannelActionsSchema,
  replyInThread: ReplyInThreadSchema,
  reactionNotifications: ReactionNotificationModeSchema,
  typingIndicator: z.boolean().optional(),
  resolveSenderNames: z.boolean().optional(),
};

/**
 * Per-account configuration.
 * All fields are optional - missing fields inherit from top-level config.
 */
export const FeishuAccountConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(), // Display name for this account
    appId: z.string().optional(),
    appSecret: buildSecretInputSchema().optional(),
    encryptKey: buildSecretInputSchema().optional(),
    verificationToken: buildSecretInputSchema().optional(),
    domain: FeishuDomainSchema.optional(),
    connectionMode: FeishuConnectionModeSchema.optional(),
    webhookPath: z.string().optional(),
    ...FeishuSharedConfigShape,
    groupSessionScope: GroupSessionScopeSchema,
    topicSessionMode: TopicSessionModeSchema,
  })
  .strict();

export const FeishuConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    defaultAccount: z.string().optional(),
    // Top-level credentials (backward compatible for single-account mode)
    appId: z.string().optional(),
    appSecret: buildSecretInputSchema().optional(),
    encryptKey: buildSecretInputSchema().optional(),
    verificationToken: buildSecretInputSchema().optional(),
    domain: FeishuDomainSchema.optional().default("feishu"),
    connectionMode: FeishuConnectionModeSchema.optional().default("websocket"),
    webhookPath: z.string().optional().default("/feishu/events"),
    ...FeishuSharedConfigShape,
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    reactionNotifications: ReactionNotificationModeSchema.optional().default("own"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    requireMention: z.boolean().optional(),
    groupSessionScope: GroupSessionScopeSchema,
    topicSessionMode: TopicSessionModeSchema,
    // Dynamic agent creation for DM users
    dynamicAgentCreation: DynamicAgentCreationSchema,
    // Optimization flags
    typingIndicator: z.boolean().optional().default(true),
    resolveSenderNames: z.boolean().optional().default(true),
    // Multi-account configuration
    accounts: z.record(z.string(), FeishuAccountConfigSchema.optional()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const defaultAccount = value.defaultAccount?.trim();
    if (defaultAccount && value.accounts && Object.keys(value.accounts).length > 0) {
      const normalizedDefaultAccount = normalizeAccountId(defaultAccount);
      if (!Object.prototype.hasOwnProperty.call(value.accounts, normalizedDefaultAccount)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["defaultAccount"],
          message: `channels.feishu.defaultAccount="${defaultAccount}" does not match a configured account key`,
        });
      }
    }

    const defaultConnectionMode = value.connectionMode ?? "websocket";
    const defaultVerificationTokenConfigured = hasConfiguredSecretInput(value.verificationToken);
    const defaultEncryptKeyConfigured = hasConfiguredSecretInput(value.encryptKey);
    if (defaultConnectionMode === "webhook") {
      if (!defaultVerificationTokenConfigured) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["verificationToken"],
          message:
            'channels.feishu.connectionMode="webhook" requires channels.feishu.verificationToken',
        });
      }
      if (!defaultEncryptKeyConfigured) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["encryptKey"],
          message: 'channels.feishu.connectionMode="webhook" requires channels.feishu.encryptKey',
        });
      }
    }

    for (const [accountId, account] of Object.entries(value.accounts ?? {})) {
      if (!account) {
        continue;
      }
      const accountConnectionMode = account.connectionMode ?? defaultConnectionMode;
      if (accountConnectionMode !== "webhook") {
        continue;
      }
      const accountVerificationTokenConfigured =
        hasConfiguredSecretInput(account.verificationToken) || defaultVerificationTokenConfigured;
      const accountEncryptKeyConfigured =
        hasConfiguredSecretInput(account.encryptKey) || defaultEncryptKeyConfigured;
      if (!accountVerificationTokenConfigured) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["accounts", accountId, "verificationToken"],
          message:
            `channels.feishu.accounts.${accountId}.connectionMode="webhook" requires ` +
            "a verificationToken (account-level or top-level)",
        });
      }
      if (!accountEncryptKeyConfigured) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["accounts", accountId, "encryptKey"],
          message:
            `channels.feishu.accounts.${accountId}.connectionMode="webhook" requires ` +
            "an encryptKey (account-level or top-level)",
        });
      }
    }

    if (value.dmPolicy === "open") {
      const allowFrom = value.allowFrom ?? [];
      const hasWildcard = allowFrom.some((entry) => String(entry).trim() === "*");
      if (!hasWildcard) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["allowFrom"],
          message:
            'channels.feishu.dmPolicy="open" requires channels.feishu.allowFrom to include "*"',
        });
      }
    }
  });
