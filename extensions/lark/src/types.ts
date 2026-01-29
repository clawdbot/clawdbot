import { z } from "clawdbot/plugin-sdk";

/**
 * DM policy for Lark channel
 * - "open": Accept messages from anyone
 * - "allowlist": Only accept messages from users in allowFrom list
 * - "pairing": Require pairing code for new users (default)
 */
export const LarkDmPolicySchema = z.enum(["open", "allowlist", "pairing"]).default("pairing");

/**
 * Group configuration for Lark
 */
export const LarkGroupConfigSchema = z.object({
  requireMention: z.boolean().optional().describe("Require @mention to trigger in this group"),
  toolPolicy: z.enum(["full", "limited", "none"]).optional().describe("Tool access policy for this group"),
}).passthrough();

export const LarkConfigSchema = z.object({
  enabled: z.boolean().default(true),
  appId: z.string().describe("Feishu App ID"),
  appSecret: z.string().describe("Feishu App Secret"),
  encryptKey: z.string().optional().describe("Event subscription encrypt key"),
  verificationToken: z.string().optional().describe("Event verification token"),
  baseUrl: z.string().default("https://open.feishu.cn").describe("API Base URL (e.g. https://open.larksuite.com)"),
  webhook: z.object({
    path: z.string().default("/lark/webhook"),
    port: z.number().default(3000),
  }).optional(),
  dmPolicy: LarkDmPolicySchema.optional().describe("DM access policy: open, allowlist, or pairing"),
  allowFrom: z.array(z.string()).optional().describe("List of allowed user IDs (open_id or user_id)"),
  groups: z.record(z.string(), LarkGroupConfigSchema).optional().describe("Group-specific configurations"),
  groupPolicy: z.enum(["open", "allowlist"]).optional().describe("Group access policy"),
});

export type LarkConfig = z.infer<typeof LarkConfigSchema>;
export type LarkDmPolicy = z.infer<typeof LarkDmPolicySchema>;
export type LarkGroupConfig = z.infer<typeof LarkGroupConfigSchema>;

export type LarkCredentials = {
  appId: string;
  appSecret: string;
  encryptKey?: string;
  verificationToken?: string;
  baseUrl: string;
};
