import { z } from "zod";

const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const PublicKeySchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/);

export const ReefFriendSchema = z
  .object({
    autonomy: z.enum(["notify-only", "bounded", "extended"]).default("bounded"),
    ed25519PublicKey: PublicKeySchema,
    x25519PublicKey: PublicKeySchema,
    keyEpoch: z.number().int().positive(),
    safetyNumberChanged: z.boolean().default(false),
  })
  .strict();

export const ReefChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    relayUrl: z.url().default("https://reefwire.ai"),
    handle: HandleSchema.optional(),
    email: z.email().optional(),
    guard: z
      .object({
        provider: z.enum(["anthropic", "openai"]),
        pinnedModel: z.string().min(1),
        apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
        policyVersion: z.string().min(1),
        timeoutMs: z.number().int().min(100).max(120_000),
      })
      .strict()
      .optional(),
    stateDir: z.string().min(1).optional(),
    friends: z.record(HandleSchema, ReefFriendSchema).default({}),
    requestPolicy: z.enum(["code-only", "friends-of-friends", "open"]).default("code-only"),
    dmPolicy: z.literal("pairing").default("pairing"),
    allowFrom: z.array(HandleSchema).default([]),
  })
  .strict();

export type ReefChannelConfig = z.infer<typeof ReefChannelConfigSchema>;
export type ReefFriendConfig = z.infer<typeof ReefFriendSchema>;

export type ReefCoreConfig = {
  channels?: { reef?: Partial<ReefChannelConfig> };
  commands?: { useAccessGroups?: boolean };
  session?: { store?: string };
};

export function resolveReefConfig(cfg: ReefCoreConfig): ReefChannelConfig {
  return ReefChannelConfigSchema.parse(cfg.channels?.reef ?? {});
}

export function normalizeReefTarget(raw: string): string | undefined {
  const target = raw
    .trim()
    .replace(/^(reef:|@)/i, "")
    .toLowerCase();
  return HandleSchema.safeParse(target).success ? target : undefined;
}

export function autonomyBudget(autonomy: ReefFriendConfig["autonomy"]): {
  notifyOnly: boolean;
  botLoopProtection: {
    enabled: true;
    maxEventsPerWindow: number;
    windowSeconds: number;
    cooldownSeconds: number;
  };
} {
  return {
    notifyOnly: autonomy === "notify-only",
    botLoopProtection: {
      enabled: true,
      maxEventsPerWindow: autonomy === "extended" ? 12 : autonomy === "bounded" ? 3 : 1,
      windowSeconds: autonomy === "extended" ? 3600 : 86400,
      cooldownSeconds: 86400,
    },
  };
}
