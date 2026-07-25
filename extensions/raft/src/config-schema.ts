// Raft channel configuration schema.
import {
  buildChannelConfigSchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const RaftAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    profile: z.string().min(1).optional(),
  })
  .strict();

const RaftConfigSchema = buildMultiAccountChannelSchema(RaftAccountSchema);

export const raftChannelConfigSchema = buildChannelConfigSchema(RaftConfigSchema);
