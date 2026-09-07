// Defines agent-related Zod schema fragments for config parsing.
import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { AgentDefaultsSchema } from "./zod-schema.agent-defaults.js";
import { AgentEntrySchema } from "./zod-schema.agent-runtime.js";

const AgentEntryConfigSchema = z.preprocess(
  (value, ctx) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.getOwnPropertyNames(value)) {
        if (!isBlockedObjectKey(key)) {
          continue;
        }
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "agent entries must not contain blocked object keys",
        });
        return z.NEVER;
      }
    }
    return value;
  },
  AgentEntrySchema.omit({ id: true }).extend({ default: z.boolean().optional() }),
);

export const AgentsSchema = z
  .object({
    ownership: z.literal("explicit").optional(),
    defaults: z.lazy(() => AgentDefaultsSchema).optional(),
    entries: z
      .record(
        z.string().regex(/^[a-z0-9_][a-z0-9_-]{0,63}$/i, "Invalid agent id"),
        AgentEntryConfigSchema,
      )
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const entries = Object.entries(value.entries ?? {});
    if (entries.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: "agents.entries must contain at least one configured agent",
      });
    }
    const firstKeyByAgentId = new Map<string, string>();
    for (const [key] of entries) {
      const agentId = normalizeAgentId(key);
      const firstKey = firstKeyByAgentId.get(agentId);
      if (!firstKey) {
        firstKeyByAgentId.set(agentId, key);
        continue;
      }
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries", key],
        message: `agents.entries keys "${firstKey}" and "${key}" resolve to the same agent id "${agentId}"; rename one key so each agent has a unique id`,
      });
    }
    const marked = entries.filter(([, entry]) => entry.default === true);
    if (marked.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["entries"],
        message: `agents.entries must contain at most one default=true entry (found ${marked.length})`,
      });
    }
    if (value.ownership === "explicit" && marked.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownership"],
        message: "agents.ownership=explicit cannot be combined with a legacy default=true marker",
      });
    }
    if (entries.length > 1 && marked.length === 0 && value.ownership !== "explicit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ownership"],
        message:
          'multi-agent rosters require agents.ownership="explicit" or one legacy default=true marker; add agents.ownership="explicit" or run openclaw doctor',
      });
    }
  })
  .optional();

const BindingMatchSchema = z
  .object({
    channel: z.string(),
    accountId: z.string().optional(),
    peer: z
      .object({
        kind: z.union([z.literal("direct"), z.literal("group"), z.literal("channel")]),
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
      .enum(["main", "per-peer", "per-channel-peer", "per-account-channel-peer"])
      .optional(),
    groupScope: z.enum(["main", "per-group"]).optional(),
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
    }
  });

export const BindingsSchema = z.array(z.union([RouteBindingSchema, AcpBindingSchema])).optional();

const BroadcastStrategySchema = z.enum(["parallel", "sequential"]);

export const BroadcastSchema = z
  .object({
    strategy: BroadcastStrategySchema.optional(),
  })
  .catchall(z.array(z.string()))
  .optional();
