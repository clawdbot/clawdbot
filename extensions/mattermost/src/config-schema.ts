import { z } from "zod";

import { BlockStreamingCoalesceSchema } from "clawdbot/plugin-sdk";

const MattermostAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    botToken: z.string().optional(),
    baseUrl: z.string().optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    textChunkLimit: z.number().int().positive().optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
  })
  .strict();

export const MattermostConfigSchema = MattermostAccountSchema.extend({
  accounts: z.record(z.string(), MattermostAccountSchema.optional()).optional(),
});
