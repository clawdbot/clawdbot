import AjvPkg, { type ValidateFunction } from "ajv";
import dynamicToolCallParamsSchema from "./protocol-generated/json/DynamicToolCallParams.json" with { type: "json" };
import errorNotificationSchema from "./protocol-generated/json/v2/ErrorNotification.json" with { type: "json" };
import modelListResponseSchema from "./protocol-generated/json/v2/ModelListResponse.json" with { type: "json" };
import threadResumeResponseSchema from "./protocol-generated/json/v2/ThreadResumeResponse.json" with { type: "json" };
import threadStartResponseSchema from "./protocol-generated/json/v2/ThreadStartResponse.json" with { type: "json" };
import turnCompletedNotificationSchema from "./protocol-generated/json/v2/TurnCompletedNotification.json" with { type: "json" };
import turnStartResponseSchema from "./protocol-generated/json/v2/TurnStartResponse.json" with { type: "json" };
import type {
  CodexDynamicToolCallParams,
  CodexErrorNotification,
  CodexModelListResponse,
  CodexThreadResumeResponse,
  CodexThreadStartResponse,
  CodexTurn,
  CodexTurnCompletedNotification,
  CodexTurnStartResponse,
} from "./protocol.js";

type AjvInstance = import("ajv").default;

const AjvCtor = AjvPkg as unknown as new (opts?: object) => AjvInstance;
const ajv = new AjvCtor({
  allErrors: true,
  strict: false,
  useDefaults: true,
  validateFormats: false,
});

const validateDynamicToolCallParams = ajv.compile<CodexDynamicToolCallParams>(
  dynamicToolCallParamsSchema,
);
const validateErrorNotification = ajv.compile<CodexErrorNotification>(errorNotificationSchema);
const validateModelListResponse = ajv.compile<CodexModelListResponse>(modelListResponseSchema);
const validateThreadResumeResponse = ajv.compile<CodexThreadResumeResponse>(
  threadResumeResponseSchema,
);
const validateThreadStartResponse =
  ajv.compile<CodexThreadStartResponse>(threadStartResponseSchema);
const validateTurnCompletedNotification = ajv.compile<CodexTurnCompletedNotification>(
  turnCompletedNotificationSchema,
);
const validateTurnStartResponse = ajv.compile<CodexTurnStartResponse>(turnStartResponseSchema);

export function assertCodexThreadStartResponse(value: unknown): CodexThreadStartResponse {
  return assertCodexShape(
    validateThreadStartResponse,
    normalizeThreadResponse(value),
    "thread/start response",
  );
}

export function assertCodexThreadResumeResponse(value: unknown): CodexThreadResumeResponse {
  return assertCodexShape(
    validateThreadResumeResponse,
    normalizeThreadResponse(value),
    "thread/resume response",
  );
}

export function assertCodexTurnStartResponse(value: unknown): CodexTurnStartResponse {
  return assertCodexShape(
    validateTurnStartResponse,
    normalizeTurnStartResponse(value),
    "turn/start response",
  );
}

export function readCodexDynamicToolCallParams(
  value: unknown,
): CodexDynamicToolCallParams | undefined {
  return readCodexShape(validateDynamicToolCallParams, value);
}

export function readCodexErrorNotification(value: unknown): CodexErrorNotification | undefined {
  return readCodexShape(validateErrorNotification, value);
}

export function readCodexModelListResponse(value: unknown): CodexModelListResponse | undefined {
  return readCodexShape(validateModelListResponse, value);
}

export function readCodexTurn(value: unknown): CodexTurn | undefined {
  const response = readCodexShape(validateTurnStartResponse, { turn: normalizeTurn(value) });
  return response?.turn;
}

export function readCodexTurnCompletedNotification(
  value: unknown,
): CodexTurnCompletedNotification | undefined {
  return readCodexShape(
    validateTurnCompletedNotification,
    normalizeTurnCompletedNotification(value),
  );
}

function assertCodexShape<T>(validate: ValidateFunction<T>, value: unknown, label: string): T {
  if (validate(value)) {
    return value;
  }
  throw new Error(`Invalid Codex app-server ${label}: ${formatAjvErrors(validate)}`);
}

function readCodexShape<T>(validate: ValidateFunction<T>, value: unknown): T | undefined {
  return validate(value) ? value : undefined;
}

function normalizeTurn(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  return {
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...value,
    items: Array.isArray((value as { items?: unknown }).items)
      ? (value as { items: unknown[] }).items.map(normalizeThreadItem)
      : [],
  };
}

function normalizeThreadItem(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const item = value as { type?: unknown };
  switch (item.type) {
    case "agentMessage":
      return { phase: null, memoryCitation: null, ...value };
    case "plan":
      return { text: "", ...value };
    case "reasoning":
      return { summary: [], content: [], ...value };
    case "dynamicToolCall":
      return {
        namespace: null,
        arguments: null,
        status: "completed",
        contentItems: null,
        success: null,
        durationMs: null,
        ...value,
      };
    default:
      return value;
  }
}

function normalizeThreadResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("thread" in value)) {
    return value;
  }
  const thread = (value as { thread?: unknown }).thread;
  if (thread && typeof thread === "object" && !Array.isArray(thread)) {
    const t = thread as { id?: string; sessionId?: string };
    if (typeof t.id === "string" && typeof t.sessionId !== "string") {
      return { ...value, thread: { ...thread, sessionId: t.id } };
    }
    if (typeof t.sessionId === "string" && typeof t.id !== "string") {
      return { ...value, thread: { ...thread, id: t.sessionId } };
    }
  }
  return value;
}

function normalizeTurnStartResponse(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("turn" in value)) {
    return value;
  }
  return {
    ...value,
    turn: normalizeTurn((value as { turn?: unknown }).turn),
  };
}

function normalizeTurnCompletedNotification(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("turn" in value)) {
    return value;
  }
  return {
    ...value,
    turn: normalizeTurn((value as { turn?: unknown }).turn),
  };
}

function formatAjvErrors(validate: ValidateFunction): string {
  const errors = validate.errors;
  if (!errors || errors.length === 0) {
    return "schema validation failed";
  }
  return ajv.errorsText(errors, { separator: "; " });
}
