import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { z } from "zod";
import type { PluginRuntime } from "../api.js";
import {
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  resolveRequestClientIp,
  resolveConfiguredSecretInputString,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_IN_FLIGHT_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  type OpenClawConfig,
  type WebhookInFlightLimiter,
} from "../runtime-api.js";
import type { WebhookSecretInput } from "./config.js";

type BoundTaskFlowRuntime = ReturnType<PluginRuntime["taskFlow"]["bindSession"]>;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const nullableStringSchema = z.string().trim().min(1).nullable().optional();

const createFlowRequestSchema = z
  .object({
    action: z.literal("create_flow"),
    controllerId: z.string().trim().min(1).optional(),
    goal: z.string().trim().min(1),
    status: z.enum(["queued", "running", "waiting", "blocked"]).optional(),
    notifyPolicy: z.enum(["done_only", "state_changes", "silent"]).optional(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
    waitJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const getFlowRequestSchema = z
  .object({ action: z.literal("get_flow"), flowId: z.string().trim().min(1) })
  .strict();
const listFlowsRequestSchema = z.object({ action: z.literal("list_flows") }).strict();
const findLatestFlowRequestSchema = z.object({ action: z.literal("find_latest_flow") }).strict();
const resolveFlowRequestSchema = z
  .object({ action: z.literal("resolve_flow"), token: z.string().trim().min(1) })
  .strict();
const getTaskSummaryRequestSchema = z
  .object({ action: z.literal("get_task_summary"), flowId: z.string().trim().min(1) })
  .strict();

const setWaitingRequestSchema = z
  .object({
    action: z.literal("set_waiting"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
    waitJson: jsonValueSchema.nullable().optional(),
    blockedTaskId: nullableStringSchema,
    blockedSummary: nullableStringSchema,
  })
  .strict();

const resumeFlowRequestSchema = z
  .object({
    action: z.literal("resume_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    status: z.enum(["queued", "running"]).optional(),
    currentStep: nullableStringSchema,
    stateJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const finishFlowRequestSchema = z
  .object({
    action: z.literal("finish_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    stateJson: jsonValueSchema.nullable().optional(),
  })
  .strict();

const failFlowRequestSchema = z
  .object({
    action: z.literal("fail_flow"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    stateJson: jsonValueSchema.nullable().optional(),
    blockedTaskId: nullableStringSchema,
    blockedSummary: nullableStringSchema,
  })
  .strict();

const requestCancelRequestSchema = z
  .object({
    action: z.literal("request_cancel"),
    flowId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

const cancelFlowRequestSchema = z
  .object({
    action: z.literal("cancel_flow"),
    flowId: z.string().trim().min(1),
  })
  .strict();

const runTaskRequestSchema = z
  .object({
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
  .strict()
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

const webhookActionSchema = z.discriminatedUnion("action", [
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

type WebhookAction = z.infer<typeof webhookActionSchema>;

export type TaskFlowWebhookTarget = {
  routeId: string;
  path: string;
  secretInput: WebhookSecretInput;
  secretConfigPath: string;
  defaultControllerId: string;
  taskFlow: BoundTaskFlowRuntime;
};

type FlowView = {
  flowId: string;
  syncMode: "task_mirrored" | "managed";
  controllerId?: string;
  revision: number;
  status: string;
  notifyPolicy: string;
  goal: string;
  currentStep?: string;
  blockedTaskId?: string;
  blockedSummary?: string;
  stateJson?: JsonValue;
  waitJson?: JsonValue;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

type TaskView = {
  taskId: string;
  runtime: string;
  sourceId?: string;
  scopeKind: string;
  childSessionKey?: string;
  parentFlowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  task: string;
  status: string;
  deliveryStatus: string;
  notifyPolicy: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: string;
};

function pickOptionalFields<T extends object, TKey extends keyof T & string>(
  source: T,
  keys: readonly TKey[],
): Partial<Pick<T, TKey>> {
  const result: Partial<Pick<T, TKey>> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

function pickOptionalTruthyStringFields<T extends object, TKey extends keyof T & string>(
  source: T,
  keys: readonly TKey[],
): Partial<Pick<T, TKey>> {
  const result: Partial<Pick<T, TKey>> = {};
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value) {
      result[key] = value as T[TKey];
    }
  }
  return result;
}

function toFlowView(flow: FlowView): FlowView {
  return {
    flowId: flow.flowId,
    syncMode: flow.syncMode,
    ...pickOptionalTruthyStringFields(flow, [
      "controllerId",
      "currentStep",
      "blockedTaskId",
      "blockedSummary",
    ]),
    revision: flow.revision,
    status: flow.status,
    notifyPolicy: flow.notifyPolicy,
    goal: flow.goal,
    ...pickOptionalFields(flow, ["stateJson", "waitJson", "cancelRequestedAt"]),
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
    ...pickOptionalFields(flow, ["endedAt"]),
  };
}

function toTaskView(task: TaskView): TaskView {
  return {
    taskId: task.taskId,
    runtime: task.runtime,
    ...pickOptionalTruthyStringFields(task, [
      "sourceId",
      "childSessionKey",
      "parentFlowId",
      "parentTaskId",
      "agentId",
      "runId",
      "label",
      "error",
      "progressSummary",
      "terminalSummary",
      "terminalOutcome",
    ]),
    scopeKind: task.scopeKind,
    task: task.task,
    status: task.status,
    deliveryStatus: task.deliveryStatus,
    notifyPolicy: task.notifyPolicy,
    createdAt: task.createdAt,
    ...pickOptionalFields(task, ["startedAt", "endedAt", "lastEventAt", "cleanupAfter"]),
  };
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function extractSharedSecret(req: IncomingMessage): string {
  const authHeader = Array.isArray(req.headers.authorization)
    ? (req.headers.authorization[0] ?? "")
    : (req.headers.authorization ?? "");
  if (normalizeLowercaseStringOrEmpty(authHeader).startsWith("bearer ")) {
    return authHeader.slice("bearer ".length).trim();
  }
  const sharedHeader = req.headers["x-openclaw-webhook-secret"];
  return Array.isArray(sharedHeader) ? (sharedHeader[0] ?? "").trim() : (sharedHeader ?? "").trim();
}

function timingSafeEquals(left: string, right: string): boolean {
  // Reuse the shared helper so webhook auth semantics stay aligned across plugins.
  return safeEqualSecret(left, right);
}

function formatZodError(error: z.ZodError): string {
  const firstIssue = error.issues[0];
  if (!firstIssue) {
    return "invalid request";
  }
  const path = firstIssue.path.length > 0 ? `${firstIssue.path.join(".")}: ` : "";
  return `${path}${firstIssue.message}`;
}

function mapMutationResult(
  result:
    | {
        applied: true;
        flow: FlowView;
      }
    | {
        applied: false;
        code: string;
        current?: FlowView;
      },
): unknown {
  return result;
}

function mapFlowMutationResult(
  result:
    | {
        applied: true;
        flow: Parameters<typeof toFlowView>[0];
      }
    | {
        applied: false;
        code: string;
        current?: Parameters<typeof toFlowView>[0];
      },
): unknown {
  return mapMutationResult(
    result.applied
      ? { applied: true, flow: toFlowView(result.flow) }
      : {
          applied: false,
          code: result.code,
          ...(result.current ? { current: toFlowView(result.current) } : {}),
        },
  );
}

function mapMutationStatus(result: {
  applied: boolean;
  code?: "not_found" | "not_managed" | "revision_conflict";
}): { statusCode: number; code?: string; error?: string } {
  if (result.applied) {
    return { statusCode: 200 };
  }
  switch (result.code) {
    case "not_found":
      return {
        statusCode: 404,
        code: "not_found",
        error: "TaskFlow not found.",
      };
    case "not_managed":
      return {
        statusCode: 409,
        code: "not_managed",
        error: "TaskFlow is not managed by this webhook surface.",
      };
    case "revision_conflict":
      return {
        statusCode: 409,
        code: "revision_conflict",
        error: "TaskFlow changed since the caller's expected revision.",
      };
    default:
      return {
        statusCode: 409,
        code: "mutation_rejected",
        error: "TaskFlow mutation was rejected.",
      };
  }
}

function mapRunTaskStatus(result: { created: boolean; found: boolean; reason?: string }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  if (result.created) {
    return { statusCode: 200 };
  }
  if (!result.found) {
    return {
      statusCode: 404,
      code: "not_found",
      error: "TaskFlow not found.",
    };
  }
  if (result.reason === "Flow cancellation has already been requested.") {
    return {
      statusCode: 409,
      code: "cancel_requested",
      error: result.reason,
    };
  }
  if (result.reason === "Flow does not accept managed child tasks.") {
    return {
      statusCode: 409,
      code: "not_managed",
      error: result.reason,
    };
  }
  if (result.reason?.startsWith("Flow is already ")) {
    return {
      statusCode: 409,
      code: "terminal",
      error: result.reason,
    };
  }
  return {
    statusCode: 409,
    code: "task_not_created",
    error: result.reason ?? "TaskFlow task was not created.",
  };
}

function mapCancelStatus(result: { found: boolean; cancelled: boolean; reason?: string }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  if (result.cancelled) {
    return { statusCode: 200 };
  }
  if (!result.found) {
    return {
      statusCode: 404,
      code: "not_found",
      error: "TaskFlow not found.",
    };
  }
  if (result.reason === "One or more child tasks are still active.") {
    return {
      statusCode: 202,
      code: "cancel_pending",
      error: result.reason,
    };
  }
  if (result.reason === "Flow changed while cancellation was in progress.") {
    return {
      statusCode: 409,
      code: "revision_conflict",
      error: result.reason,
    };
  }
  if (result.reason?.startsWith("Flow is already ")) {
    return {
      statusCode: 409,
      code: "terminal",
      error: result.reason,
    };
  }
  return {
    statusCode: 409,
    code: "cancel_rejected",
    error: result.reason ?? "TaskFlow cancellation was rejected.",
  };
}

function describeWebhookOutcome(params: { action: WebhookAction; result: unknown }): {
  statusCode: number;
  code?: string;
  error?: string;
} {
  switch (params.action.action) {
    case "set_waiting":
    case "resume_flow":
    case "finish_flow":
    case "fail_flow":
    case "request_cancel":
      return mapMutationStatus(
        params.result as {
          applied: boolean;
          code?: "not_found" | "not_managed" | "revision_conflict";
        },
      );
    case "cancel_flow":
      return mapCancelStatus(
        params.result as {
          found: boolean;
          cancelled: boolean;
          reason?: string;
        },
      );
    case "run_task":
      return mapRunTaskStatus(
        params.result as {
          created: boolean;
          found: boolean;
          reason?: string;
        },
      );
    default:
      return { statusCode: 200 };
  }
}

async function executeWebhookAction(params: {
  action: WebhookAction;
  target: TaskFlowWebhookTarget;
  cfg: OpenClawConfig;
}): Promise<unknown> {
  const { action, target } = params;
  switch (action.action) {
    case "create_flow": {
      const flow = target.taskFlow.createManaged({
        controllerId: action.controllerId ?? target.defaultControllerId,
        goal: action.goal,
        status: action.status,
        notifyPolicy: action.notifyPolicy,
        currentStep: action.currentStep ?? undefined,
        stateJson: action.stateJson,
        waitJson: action.waitJson,
      });
      return { flow: toFlowView(flow) };
    }
    case "get_flow": {
      const flow = target.taskFlow.get(action.flowId);
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "list_flows":
      return { flows: target.taskFlow.list().map(toFlowView) };
    case "find_latest_flow": {
      const flow = target.taskFlow.findLatest();
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "resolve_flow": {
      const flow = target.taskFlow.resolve(action.token);
      return { flow: flow ? toFlowView(flow) : null };
    }
    case "get_task_summary":
      return { summary: target.taskFlow.getTaskSummary(action.flowId) ?? null };
    case "set_waiting": {
      const result = target.taskFlow.setWaiting({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        currentStep: action.currentStep,
        stateJson: action.stateJson,
        waitJson: action.waitJson,
        blockedTaskId: action.blockedTaskId,
        blockedSummary: action.blockedSummary,
      });
      return mapFlowMutationResult(result);
    }
    case "resume_flow": {
      const result = target.taskFlow.resume({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        status: action.status,
        currentStep: action.currentStep,
        stateJson: action.stateJson,
      });
      return mapFlowMutationResult(result);
    }
    case "finish_flow": {
      const result = target.taskFlow.finish({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        stateJson: action.stateJson,
      });
      return mapFlowMutationResult(result);
    }
    case "fail_flow": {
      const result = target.taskFlow.fail({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
        stateJson: action.stateJson,
        blockedTaskId: action.blockedTaskId,
        blockedSummary: action.blockedSummary,
      });
      return mapFlowMutationResult(result);
    }
    case "request_cancel": {
      const result = target.taskFlow.requestCancel({
        flowId: action.flowId,
        expectedRevision: action.expectedRevision,
      });
      return mapFlowMutationResult(result);
    }
    case "cancel_flow": {
      const result = await target.taskFlow.cancel({
        flowId: action.flowId,
        cfg: params.cfg,
      });
      return {
        found: result.found,
        cancelled: result.cancelled,
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.flow ? { flow: toFlowView(result.flow) } : {}),
        ...(result.tasks ? { tasks: result.tasks.map(toTaskView) } : {}),
      };
    }
    case "run_task": {
      const result = target.taskFlow.runTask({
        flowId: action.flowId,
        runtime: action.runtime,
        sourceId: action.sourceId,
        childSessionKey: action.childSessionKey,
        parentTaskId: action.parentTaskId,
        agentId: action.agentId,
        runId: action.runId,
        label: action.label,
        task: action.task,
        preferMetadata: action.preferMetadata,
        notifyPolicy: action.notifyPolicy,
        status: action.status,
        startedAt: action.startedAt,
        lastEventAt: action.lastEventAt,
        progressSummary: action.progressSummary,
      });
      if (result.created) {
        return {
          created: true,
          flow: toFlowView(result.flow),
          task: toTaskView(result.task),
        };
      }
      return {
        found: result.found,
        created: false,
        reason: result.reason,
        ...(result.flow ? { flow: toFlowView(result.flow) } : {}),
      };
    }
  }
  throw new Error("Unsupported webhook action");
}

export function createTaskFlowWebhookRequestHandler(params: {
  cfg: OpenClawConfig;
  targetsByPath: Map<string, TaskFlowWebhookTarget[]>;
  inFlightLimiter?: WebhookInFlightLimiter;
}): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const rateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });
  const inFlightLimiter =
    params.inFlightLimiter ??
    createWebhookInFlightLimiter({
      maxInFlightPerKey: WEBHOOK_IN_FLIGHT_DEFAULTS.maxInFlightPerKey,
      maxTrackedKeys: WEBHOOK_IN_FLIGHT_DEFAULTS.maxTrackedKeys,
    });
  const resolveTargetSecret = async (
    target: TaskFlowWebhookTarget,
  ): Promise<string | undefined> => {
    if (typeof target.secretInput === "string") {
      return target.secretInput;
    }
    const resolved = await resolveConfiguredSecretInputString({
      config: params.cfg,
      env: process.env,
      value: target.secretInput,
      path: target.secretConfigPath,
    });
    return resolved.value;
  };

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    return await withResolvedWebhookRequestPipeline({
      req,
      res,
      targetsByPath: params.targetsByPath,
      allowMethods: ["POST"],
      requireJsonContentType: true,
      rateLimiter,
      rateLimitKey: (() => {
        const clientIp =
          resolveRequestClientIp(
            req,
            params.cfg.gateway?.trustedProxies,
            params.cfg.gateway?.allowRealIpFallback === true,
          ) ??
          req.socket.remoteAddress ??
          "unknown";
        return `${new URL(req.url ?? "/", "http://localhost").pathname}:${clientIp}`;
      })(),
      inFlightLimiter,
      handle: async ({ targets }) => {
        const presentedSecret = extractSharedSecret(req);
        const target = await resolveWebhookTargetWithAuthOrReject({
          targets,
          res,
          isMatch: async (candidate) => {
            if (presentedSecret.length === 0) {
              return false;
            }
            const resolvedSecret = await resolveTargetSecret(candidate);
            return Boolean(resolvedSecret && timingSafeEquals(resolvedSecret, presentedSecret));
          },
        });
        if (!target) {
          return true;
        }

        const body = await readJsonWebhookBodyOrReject({
          req,
          res,
          maxBytes: 256 * 1024,
          timeoutMs: 15_000,
          emptyObjectOnEmpty: false,
          invalidJsonMessage: "invalid request body",
        });
        if (!body.ok) {
          return true;
        }

        const parsed = webhookActionSchema.safeParse(body.value);
        if (!parsed.success) {
          writeJson(res, 400, {
            ok: false,
            code: "invalid_request",
            error: formatZodError(parsed.error),
          });
          return true;
        }

        const result = await executeWebhookAction({
          action: parsed.data,
          target,
          cfg: params.cfg,
        });
        const outcome = describeWebhookOutcome({
          action: parsed.data,
          result,
        });
        writeJson(
          res,
          outcome.statusCode,
          outcome.statusCode < 400
            ? {
                ok: true,
                routeId: target.routeId,
                ...(outcome.code ? { code: outcome.code } : {}),
                result,
              }
            : {
                ok: false,
                routeId: target.routeId,
                code: outcome.code ?? "request_rejected",
                error: outcome.error ?? "request rejected",
                result,
              },
        );
        return true;
      },
    });
  };
}
