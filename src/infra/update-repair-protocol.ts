import { z } from "zod";
import { updateFailureSchema, type TriageUpdateFailure } from "../commands/triage-update.js";

export const updateRepairBudgetSchema = z.object({
  maxTurns: z.number().int().nonnegative().default(3),
  wallClockMs: z.number().int().positive().max(2_147_483_647).default(600_000),
  perTurnMs: z.number().int().positive().max(2_147_483_647).default(300_000),
  maxToolCalls: z.number().int().nonnegative().default(40),
});
export const updateRepairValidationSchema = z.object({
  ok: z.boolean(),
  score: z.number().finite(),
  summary: z.string(),
  stopReason: z.string().max(1024).optional(),
});
const text = z.string().max(1024);
const wireValidation = updateRepairValidationSchema.extend({ summary: text });
const status = z.enum(["repaired", "improved", "unrepaired", "unavailable", "aborted"]);
const turn = z.number().int().positive();
const attempt = z.object({
  turn,
  model: text,
  provider: text,
  durationMs: z.number().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  validation: wireValidation,
  summary: text,
});
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("route-selected"), model: text, provider: text }),
  z.object({ type: z.literal("turn-started"), turn, model: text, provider: text }),
  attempt.extend({ type: z.literal("turn-finished") }),
  z.object({
    type: z.literal("validation"),
    turn: z.number().int().nonnegative(),
    validation: wireValidation,
  }),
  z.object({ type: z.literal("stopped"), status, reason: text.optional() }),
]);
export const updateRepairWorkerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("validate"), id: turn }),
  z.object({ type: z.literal("cancel-validation"), id: turn }),
  z.object({ type: z.literal("event"), event }),
  z.object({
    type: z.literal("result"),
    result: z.object({
      status,
      attempts: z.array(attempt),
      finalValidation: wireValidation,
      reason: text.optional(),
    }),
  }),
]);
export const updateRepairParentMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    runId: text.optional(),
    requester: z
      .object({ channel: text.optional(), accountId: text.optional(), senderId: text.optional() })
      .optional(),
    target: z.object({
      stateDir: z.string(),
      configPath: z.string(),
      workspaceDir: z.string(),
      installRoot: z.string(),
    }),
    failure: updateFailureSchema,
    context: z.object({
      beforeVersion: text.optional(),
      targetVersion: text.optional(),
      symptoms: z.array(text).max(20).optional(),
    }),
    budget: updateRepairBudgetSchema,
  }),
  z.object({
    type: z.literal("validation-result"),
    id: turn,
    validation: wireValidation,
  }),
  z.object({ type: z.literal("validation-error"), id: turn, reason: text }),
  z.object({ type: z.literal("cancel"), reason: text }),
]);
export type UpdateRepairWorkerMessage = z.infer<typeof updateRepairWorkerMessageSchema>;
export type UpdateRepairParentMessage = z.infer<typeof updateRepairParentMessageSchema>;
export const UPDATE_REPAIR_IPC_MAX_BYTES = 64 * 1024;

export type UpdateRepairTarget = Extract<UpdateRepairParentMessage, { type: "start" }>["target"] & {
  candidateRoot?: string;
  environment?: NodeJS.ProcessEnv;
};
export type UpdateRepairValidation = z.infer<typeof updateRepairValidationSchema>;
export type UpdateRepairResult = Extract<UpdateRepairWorkerMessage, { type: "result" }>["result"];
export type UpdateRepairEvent = Extract<UpdateRepairWorkerMessage, { type: "event" }>["event"];
export type UpdateRepairParams = {
  target: UpdateRepairTarget;
  nodeRunner?: string;
  runId?: string;
  requester?: { channel?: string; accountId?: string; senderId?: string };
  context: TriageUpdateFailure & {
    phase: "validating" | "verifying";
    beforeVersion?: string;
    targetVersion?: string;
    symptoms?: string[];
  };
  /** Read-only oracle for the captured target. Honor the signal to cancel diagnostics. */
  validate: (signal: AbortSignal) => Promise<UpdateRepairValidation>;
  budget?: z.input<typeof updateRepairBudgetSchema>;
  onEvent?: (event: UpdateRepairEvent) => void;
  signal?: AbortSignal;
  /** The admitting update still owns this repair slot. */
  isCurrent?: () => boolean;
};
