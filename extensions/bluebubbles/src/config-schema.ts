import {
  AllowFromListSchema,
  buildChannelConfigSchema,
  buildCatchallMultiAccountChannelSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ToolPolicySchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { z } from "openclaw/plugin-sdk/zod";
import { bluebubblesChannelConfigUiHints } from "./config-ui-hints.js";
import { buildSecretInputSchema, hasConfiguredSecretInput } from "./secret-input.js";

const bluebubblesActionSchema = z
  .object({
    reactions: z.boolean().default(true),
    edit: z.boolean().default(true),
    unsend: z.boolean().default(true),
    reply: z.boolean().default(true),
    sendWithEffect: z.boolean().default(true),
    renameGroup: z.boolean().default(true),
    setGroupIcon: z.boolean().default(true),
    addParticipant: z.boolean().default(true),
    removeParticipant: z.boolean().default(true),
    leaveGroup: z.boolean().default(true),
    sendAttachment: z.boolean().default(true),
  })
  .optional();

const bluebubblesGroupConfigSchema = z.object({
  requireMention: z.boolean().optional(),
  tools: ToolPolicySchema,
  /**
   * Free-form directive appended to the system prompt for every turn that
   * handles a message in this group. Use it for per-group persona tweaks or
   * behavioral rules (reply-threading, tapback conventions, etc.).
   */
  systemPrompt: z.string().optional(),
});

const bluebubblesNetworkSchema = z
  .object({
    /** Dangerous opt-in for same-host or trusted private/internal BlueBubbles deployments. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
  })
  .strict()
  .optional();

const bluebubblesCatchupSchema = z
  .object({
    /** Replay messages delivered while the gateway was unreachable. Defaults to on. */
    enabled: z.boolean().optional(),
    /** Hard ceiling on lookback window. Clamped to [1, 720] minutes. */
    maxAgeMinutes: z.number().int().positive().optional(),
    /** Upper bound on messages replayed in a single startup pass. Clamped to [1, 500]. */
    perRunLimit: z.number().int().positive().optional(),
    /** First-run lookback used when no cursor has been persisted yet. Clamped to [1, 720]. */
    firstRunLookbackMinutes: z.number().int().positive().optional(),
    /**
     * Consecutive-failure ceiling per message GUID. After this many failed
     * processMessage attempts against the same GUID, catchup logs a WARN
     * and skips the message on subsequent sweeps (letting the cursor
     * advance past a permanently malformed payload). Defaults to 10.
     * Clamped to [1, 1000].
     */
    maxFailureRetries: z.number().int().positive().optional(),
  })
  .strict()
  .optional();

const bluebubblesAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    actions: bluebubblesActionSchema,
    serverUrl: z.string().optional(),
    password: buildSecretInputSchema().optional(),
    webhookPath: z.string().optional(),
    dmPolicy: DmPolicySchema.optional(),
    allowFrom: AllowFromListSchema,
    groupAllowFrom: AllowFromListSchema,
    groupPolicy: GroupPolicySchema.optional(),
    enrichGroupParticipantsFromContacts: z.boolean().optional().default(true),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    sendTimeoutMs: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    mediaMaxMb: z.number().int().positive().optional(),
    mediaLocalRoots: z.array(z.string()).optional(),
    sendReadReceipts: z.boolean().optional(),
    network: bluebubblesNetworkSchema,
    catchup: bluebubblesCatchupSchema,
    blockStreaming: z.boolean().optional(),
    groups: z.object({}).catchall(bluebubblesGroupConfigSchema).optional(),
    coalesceSameSenderDms: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const serverUrl = value.serverUrl?.trim() ?? "";
    const passwordConfigured = hasConfiguredSecretInput(value.password);
    if (serverUrl && !passwordConfigured) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["password"],
        message: "password is required when serverUrl is configured",
      });
    }
  });

export const BlueBubblesConfigSchema = buildCatchallMultiAccountChannelSchema(
  bluebubblesAccountSchema,
).safeExtend({
  actions: bluebubblesActionSchema,
});

export const BlueBubblesChannelConfigSchema = buildChannelConfigSchema(BlueBubblesConfigSchema, {
  uiHints: bluebubblesChannelConfigUiHints,
});
