import { z } from "zod";
import { GUARD_RULES_MAX_CHARS } from "../protocol/guard.js";
import type { ReefAutonomy } from "./friend-types.js";

const HandleSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
// No trim transform: the raw text is hashed into the policy identity, and the
// manifest JSON Schemas must express identical validity (non-blank via \S).
const GuardRuleTextSchema = z
  .string()
  .max(GUARD_RULES_MAX_CHARS)
  .regex(/\S/, "rules text must not be blank");
const RelayUrlSchema = z
  .string()
  .regex(
    /^[hH][tT][tT][pP][sS]?:\/\/[^\\/?#@]+\/?$/,
    "Reef relay URL must be an HTTP(S) origin without credentials, path, query, or hash",
  )
  .url();
export const OpenAiOAuthProfileIdSchema = z.string().regex(/^openai:[^\s:/][^\s/]*$/);

const GuardCommonSchema = {
  pinnedModel: z.string().min(1),
  policyVersion: z.string().min(1),
  timeoutMs: z.number().int().min(100).max(120_000),
  rules: z
    .object({
      outbound: GuardRuleTextSchema.optional(),
      inbound: GuardRuleTextSchema.optional(),
    })
    .strict()
    .optional(),
} as const;

const GuardSchema = z.union([
  z
    .object({
      provider: z.literal("openai"),
      authMode: z.literal("oauth"),
      // Direct plugin completions encode the profile as a trailing model-ref
      // suffix, whose grammar deliberately excludes '/'. Reject values that
      // cannot round-trip through that host boundary.
      authProfileId: OpenAiOAuthProfileIdSchema,
      ...GuardCommonSchema,
    })
    .strict(),
  z
    .object({
      provider: z.enum(["anthropic", "openai"]),
      authMode: z.literal("api-key").optional(),
      apiKeyEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
      ...GuardCommonSchema,
    })
    .strict(),
]);

export const ReefChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    configWrites: z.boolean().optional(),
    relayUrl: RelayUrlSchema.default("https://reefwire.ai"),
    handle: HandleSchema.optional(),
    email: z.email().optional(),
    guard: GuardSchema.optional(),
    stateDir: z.string().min(1).optional(),
    requestPolicy: z.enum(["code-only", "friends-of-friends", "open"]).default("code-only"),
    // Upgrade-only snapshot. Runtime trust is SQLite-backed; doctor imports valid rows.
    friends: z.unknown().optional(),
  })
  .strict();

export type ReefChannelConfig = z.infer<typeof ReefChannelConfigSchema>;

export type ReefCoreConfig = {
  channels?: { reef?: Partial<ReefChannelConfig> };
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

export function parseReefRelayUrl(raw: string): string {
  return new URL(RelayUrlSchema.parse(raw)).origin;
}

export function autonomyBudget(autonomy: ReefAutonomy): {
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
