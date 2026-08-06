// Raft channel configuration schema.
import {
  buildChannelConfigSchema,
  buildCommonChannelAccountShape,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "zod";

const RaftCommonAccountShape = buildCommonChannelAccountShape({
  omit: [
    "capabilities",
    "markdown",
    "dmPolicy",
    "allowFrom",
    "defaultTo",
    "groupAllowFrom",
    "groupPolicy",
    "mentionPatterns",
    "contextVisibility",
    "historyLimit",
    "dmHistoryLimit",
    "dms",
    "textChunkLimit",
    "streaming",
    "heartbeatVisibility",
    "healthMonitor",
    "responsePrefix",
    "mediaMaxMb",
    "replyToMode",
  ],
});

const RaftAccountSchema = z
  .object({
    name: RaftCommonAccountShape.name,
    enabled: RaftCommonAccountShape.enabled,
    configWrites: RaftCommonAccountShape.configWrites,
    profile: z.string().min(1).optional(),
  })
  .strict();

const RaftConfigSchema = buildMultiAccountChannelSchema(RaftAccountSchema);

export const raftChannelConfigSchema = buildChannelConfigSchema(RaftConfigSchema);
