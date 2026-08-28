import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const a2aPeerNamePattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const a2aHttpUrlSchema = z
  .string()
  .url()
  .and(z.string().regex(/^https?:\/\//, "A2A URLs must use HTTP or HTTPS"));

const a2aPeerConfigSchema = z
  .object({
    token: z.string().min(1),
    url: a2aHttpUrlSchema.optional(),
    outboundToken: z.string().min(1).optional(),
  })
  .strict();

const a2aChannelConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    advertisedUrl: a2aHttpUrlSchema.optional(),
    replyTimeoutMs: z.number().int().min(5_000).max(600_000).optional(),
    rateLimitPerMinute: z.number().int().min(0).optional(),
    exposeAgents: z.array(z.string()).optional(),
    peers: z.record(z.string().regex(a2aPeerNamePattern), a2aPeerConfigSchema).optional(),
  })
  .strict();

export const a2aPluginConfigSchema = buildChannelConfigSchema(a2aChannelConfigSchema, {
  uiHints: {
    advertisedUrl: {
      label: "Advertised Gateway URL",
      help: "Public Gateway origin included in the A2A agent card.",
    },
    replyTimeoutMs: { label: "Blocking Reply Timeout (ms)", advanced: true },
    rateLimitPerMinute: { label: "Requests Per Peer Per Minute", advanced: true },
    exposeAgents: { label: "Exposed Agent IDs" },
    "peers.*.token": { label: "Inbound Bearer Token", sensitive: true },
    "peers.*.outboundToken": { label: "Outbound Bearer Token", sensitive: true },
  },
});
