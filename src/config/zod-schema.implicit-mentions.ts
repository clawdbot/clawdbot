import { z } from "zod";

export const ChannelImplicitMentionsSchema = z
  .object({
    replyToBot: z.boolean().optional(),
    quotedBot: z.boolean().optional(),
    threadParticipation: z.boolean().optional(),
  })
  .strict();
