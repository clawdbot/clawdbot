import { z } from "zod";

const jsonValueSchema = z.json();
export type JsonValue = z.infer<typeof jsonValueSchema>;

const nullableStringSchema = z.string().trim().min(1).nullable().optional();

const createFlowRequestSchema = z.strictObject({
  action: z.literal("create_flow"),
  controllerId: z.string().trim().min(1).optional(),
  goal: z.string().trim().min(1),
  status: z.enum(["queued", "running", "waiting", "blocked"]).optional(),
  notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
  currentStep: nullableStringSchema,
  stateJson: jsonValueSchema.nullable().optional(),
  waitJson: jsonValueSchema.nullable().optional(),
});

const getFlowRequestSchema = z.strictObject({
  action: z.literal("get_flow"),
  flowId: z.string().trim().min(1),
});
const listFlowsRequestSchema = z.strictObject({ action: z.literal("list_flows") });
const findLatestFlowRequestSchema = z.strictObject({ action: z.literal("find_latest_flow") });
const resolveFlowRequestSchema = z.strictObject({
  action: z.literal("resolve_flow"),
  token: z.string().trim().min(1),
});
const getTaskSummaryRequestSchema = z.strictObject({
  action: z.literal("get_task_summary"),
  flowId: z.string().trim().min(1),
});

const setWaitingRequestSchema = z.strictObject({
  action: z.literal("set_waiting"),
  flowId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  currentStep: nullableStringSchema,
  stateJson: jsonValueSchema.nullable().optional(),
  waitJson: jsonValueSchema.nullable().optional(),
  blockedTaskId: nullableStringSchema,
  blockedSummary: nullableStringSchema,
});

const resumeFlowRequestSchema = z.strictObject({
  action: z.literal("resume_flow"),
  flowId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  status: z.enum(["queued", "running"]).optional(),
  currentStep: nullableStringSchema,
  stateJson: jsonValueSchema.nullable().optional(),
});

const finishFlowRequestSchema = z.strictObject({
  action: z.literal("finish_flow"),
  flowId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  stateJson: jsonValueSchema.nullable().optional(),
});

const failFlowRequestSchema = z.strictObject({
  action: z.literal("fail_flow"),
  flowId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
  stateJson: jsonValueSchema.nullable().optional(),
  blockedTaskId: nullableStringSchema,
  blockedSummary: nullableStringSchema,
});

const requestCancelRequestSchema = z.strictObject({
  action: z.literal("request_cancel"),
  flowId: z.string().trim().min(1),
  expectedRevision: z.number().int().nonnegative(),
});

const cancelFlowRequestSchema = z.strictObject({
  action: z.literal("cancel_flow"),
  flowId: z.string().trim().min(1),
});

const runTaskRequestSchema = z
  .strictObject({
    action: z.literal("run_task"),
    flowId: z.string().trim().min(1),
    runtime: z.enum(["subagent", "acp"]),
    sourceId: z.string().trim().min(1).optional(),
    childSessionKey: z.string().trim().min(1).optional(),
    parentTaskId: z.string().trim().min(1).optional(),
    agentId: z.string().trim().min(1).optional(),
    runId: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    task: z.string().trim().min(1),
    preferMetadata: z.boolean().optional(),
    notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
    status: z.enum(["queued", "running"]).optional(),
    startedAt: z.number().int().nonnegative().optional(),
    lastEventAt: z.number().int().nonnegative().optional(),
    progressSummary: nullableStringSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.status !== "running" &&
      (value.startedAt !== undefined ||
        value.lastEventAt !== undefined ||
        value.progressSummary !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "status must be running when startedAt, lastEventAt, or progressSummary is provided",
        path: ["status"],
      });
    }
  });

export const webhookActionSchema = z.discriminatedUnion("action", [
  createFlowRequestSchema,
  getFlowRequestSchema,
  listFlowsRequestSchema,
  findLatestFlowRequestSchema,
  resolveFlowRequestSchema,
  getTaskSummaryRequestSchema,
  setWaitingRequestSchema,
  resumeFlowRequestSchema,
  finishFlowRequestSchema,
  failFlowRequestSchema,
  requestCancelRequestSchema,
  cancelFlowRequestSchema,
  runTaskRequestSchema,
]);

export type WebhookAction = z.infer<typeof webhookActionSchema>;

export function formatZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return "invalid request";
  }
  const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
  return `${path}${firstIssue.message}`;
}
