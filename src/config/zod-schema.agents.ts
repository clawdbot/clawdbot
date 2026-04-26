import { z } from "zod";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";
import { TranscribeAudioSchema } from "./zod-schema.core.js";

export const AgentsSchema = z
  .object({
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    list: z.array(AgentEntrySchema).optional(),
  })
  .strict()
  .optional();

const BindingMatchSchema = z
  .object({
    channel: z.string(),
    accountId: z.string().optional(),
    peer: z
      .object({
        kind: z.union([
          z.literal("direct"),
          z.literal("group"),
          z.literal("channel"),
          /** @deprecated Use `direct` instead. Kept for backward compatibility. */
          z.literal("dm"),
        ]),
        id: z.string(),
      })
      .strict()
      .optional(),
    guildId: z.string().optional(),
    teamId: z.string().optional(),
    roles: z.array(z.string()).optional(),
  })
  .strict();

const BindingSessionSchema = z
  .object({
    dmScope: z
      .union([
        z.literal("main"),
        z.literal("per-peer"),
        z.literal("per-channel-peer"),
        z.literal("per-account-channel-peer"),
      ])
      .optional(),
  })
  .strict();

const RouteBindingSchema = z
  .object({
    type: z.literal("route").optional(),
    agentId: z.string(),
    comment: z.string().optional(),
    match: BindingMatchSchema,
    session: BindingSessionSchema.optional(),
  })
  .strict();

const AcpBindingSchema = z
  .object({
    type: z.literal("acp"),
    agentId: z.string(),
    comment: z.string().optional(),
    match: BindingMatchSchema,
    acp: z
      .object({
        mode: z.enum(["persistent", "oneshot"]).optional(),
        label: z.string().optional(),
        cwd: z.string().optional(),
        backend: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const peerId = normalizeOptionalString(value.match.peer?.id) ?? "";
    if (!peerId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["match", "peer"],
        message: "ACP bindings require match.peer.id to target a concrete conversation.",
      });
      return;
    }
  });

export const BindingsSchema = z.array(z.union([RouteBindingSchema, AcpBindingSchema])).optional();

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
  .strict()
  .optional();
