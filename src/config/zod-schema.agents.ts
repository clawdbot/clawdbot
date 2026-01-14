import { z } from "zod";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .optional();

export const BindingsSchema = z
  .array(
    z.object({
      agentId: z.string(),
      match: z.object({
        channel: z.string(),
        accountId: z.string().optional(),
        peer: z
          .object({
            kind: z.union([
              z.literal("dm"),
              z.literal("group"),
              z.literal("channel"),
            ]),
            id: z.string(),
          })
          .optional(),
        guildId: z.string().optional(),
        teamId: z.string().optional(),
      }),
    }),
  )
  .optional();

export const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();

export const AudioSchema = z
  .object({
    transcription: TranscribeAudioSchema,
  })
  .optional();
