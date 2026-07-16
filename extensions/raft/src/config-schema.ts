// Raft channel configuration schema.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const RaftAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    profile: z.string().min(1).optional(),
  })
  .strict();

const RaftConfigSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    profile: z.string().min(1).optional(),
    defaultAccount: z.string().optional(),
    accounts: z.record(z.string(), RaftAccountSchema).optional(),
  })
  .strict();

export const raftChannelConfigSchema = buildChannelConfigSchema(RaftConfigSchema);
