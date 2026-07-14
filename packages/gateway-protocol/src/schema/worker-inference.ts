import { Type, type TProperties, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./closed-object.js";
import {
  WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
  WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
  type WorkerErrorShape,
  WorkerErrorShapeSchema,
  type WorkerTranscriptMessage,
} from "./worker-admission.js";

export const WORKER_INFERENCE_PROTOCOL_FEATURE = "worker-inference-v1";
export const WORKER_INFERENCE_METHODS = [
  "worker.inference.start",
  "worker.inference.cancel",
] as const;
export const WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const WORKER_INFERENCE_MAX_CONTEXT_MESSAGES = 1_024;
export const WORKER_INFERENCE_MAX_TOOLS = 256;
export const WORKER_INFERENCE_MAX_OUTPUT_TOKENS = 1_000_000;

const WorkerIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH,
  pattern: "^\\S(?:.*\\S)?$",
});
const WorkerFrameIdSchema = Type.String({
  minLength: 1,
  maxLength: WORKER_PROTOCOL_MAX_FRAME_ID_LENGTH,
});
const WorkerErrorResponseFrameSchema = closedObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(false),
  error: WorkerErrorShapeSchema,
});

function workerInferenceObject<const Properties extends TProperties>(properties: Properties) {
  return closedObject(properties);
}

const LiveTextSchema = Type.String({
  maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES,
});
const InferenceTextSchema = Type.String({
  maxLength: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
});
const OptionalInferenceTextSchema = Type.Optional(InferenceTextSchema);
const LiveIntegerSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const LiveSequenceSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});

const WorkerTranscriptUsageSchema = closedObject({
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  contextUsage: Type.Optional(
    Type.Union([
      closedObject({
        state: Type.Literal("available"),
        promptTokens: Type.Number({ minimum: 0 }),
        totalTokens: Type.Number({ minimum: 0 }),
      }),
      closedObject({ state: Type.Literal("unavailable") }),
    ]),
  ),
  totalTokens: Type.Number({ minimum: 0 }),
  cost: closedObject({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    total: Type.Number({ minimum: 0 }),
    totalOrigin: Type.Optional(Type.Literal("provider-billed")),
  }),
});

const WorkerTranscriptAssistantDiagnosticSchema = closedObject({
  type: WorkerIdentifierSchema,
  timestamp: Type.Integer({ minimum: 0 }),
  error: Type.Optional(
    closedObject({
      name: Type.Optional(Type.String({ maxLength: 256 })),
      message: Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES }),
      stack: Type.Optional(Type.String({ maxLength: WORKER_PROTOCOL_MAX_PAYLOAD_BYTES })),
      code: Type.Optional(Type.Union([Type.String({ maxLength: 256 }), Type.Number()])),
    }),
  ),
  details: Type.Optional(
    Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
  ),
});

const WorkerInferenceTextContentSchema = workerInferenceObject({
  type: Type.Literal("text"),
  text: InferenceTextSchema,
  textSignature: OptionalInferenceTextSchema,
});

const WorkerInferenceImageContentSchema = workerInferenceObject({
  type: Type.Literal("image"),
  data: Type.String({
    minLength: 1,
    maxLength: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
  }),
  mimeType: Type.String({ minLength: 1, maxLength: 256 }),
});

const WorkerInferenceThinkingContentSchema = workerInferenceObject({
  type: Type.Literal("thinking"),
  thinking: InferenceTextSchema,
  thinkingSignature: OptionalInferenceTextSchema,
  redacted: Type.Optional(Type.Boolean()),
});

const WorkerInferenceToolCallSchema = workerInferenceObject({
  type: Type.Literal("toolCall"),
  id: WorkerIdentifierSchema,
  name: WorkerIdentifierSchema,
  arguments: Type.Record(Type.String({ minLength: 1, maxLength: 256 }), Type.Unknown()),
  thoughtSignature: OptionalInferenceTextSchema,
  executionMode: Type.Optional(Type.Union([Type.Literal("sequential"), Type.Literal("parallel")])),
});

const WorkerInferenceUserMessageSchema = workerInferenceObject({
  role: Type.Literal("user"),
  content: Type.Union([
    InferenceTextSchema,
    Type.Array(Type.Union([WorkerInferenceTextContentSchema, WorkerInferenceImageContentSchema]), {
      minItems: 1,
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
  ]),
  timestamp: LiveIntegerSchema,
  runtimeContextCarrier: Type.Optional(Type.Boolean()),
});

const WorkerInferenceAssistantMessageProperties = {
  role: Type.Literal("assistant"),
  content: Type.Array(
    Type.Union([
      WorkerInferenceTextContentSchema,
      WorkerInferenceThinkingContentSchema,
      WorkerInferenceToolCallSchema,
    ]),
    { maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
  ),
  api: WorkerIdentifierSchema,
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
  responseModel: Type.Optional(WorkerIdentifierSchema),
  responseId: Type.Optional(WorkerIdentifierSchema),
  usage: WorkerTranscriptUsageSchema,
  timestamp: LiveIntegerSchema,
};

const WorkerInferenceAssistantMessageSchema = workerInferenceObject({
  ...WorkerInferenceAssistantMessageProperties,
  stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("toolUse")]),
});

const WorkerInferenceContextAssistantMessageSchema = workerInferenceObject({
  ...WorkerInferenceAssistantMessageProperties,
  diagnostics: Type.Optional(
    Type.Array(WorkerTranscriptAssistantDiagnosticSchema, {
      maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
    }),
  ),
  stopReason: Type.Union([
    Type.Literal("stop"),
    Type.Literal("length"),
    Type.Literal("toolUse"),
    Type.Literal("error"),
    Type.Literal("aborted"),
  ]),
  errorMessage: OptionalInferenceTextSchema,
  errorCode: Type.Optional(Type.String({ maxLength: 256 })),
  errorType: Type.Optional(Type.String({ maxLength: 256 })),
  errorBody: OptionalInferenceTextSchema,
});

const WorkerInferenceMessageSchema = Type.Union([
  WorkerInferenceUserMessageSchema,
  WorkerInferenceContextAssistantMessageSchema,
  workerInferenceObject({
    role: Type.Literal("toolResult"),
    toolCallId: WorkerIdentifierSchema,
    toolName: WorkerIdentifierSchema,
    content: Type.Array(
      Type.Union([WorkerInferenceTextContentSchema, WorkerInferenceImageContentSchema]),
      { maxItems: WORKER_TRANSCRIPT_MAX_CONTENT_PARTS },
    ),
    details: Type.Optional(Type.Unknown()),
    isError: Type.Boolean(),
    timestamp: LiveIntegerSchema,
  }),
]);

const WorkerInferenceToolSchema = workerInferenceObject({
  name: WorkerIdentifierSchema,
  description: LiveTextSchema,
  parameters: Type.Unknown(),
});

export const WorkerInferenceModelRefSchema: TSchema = workerInferenceObject({
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
});

export const WorkerInferenceContextSchema: TSchema = workerInferenceObject({
  systemPrompt: Type.Optional(InferenceTextSchema),
  messages: Type.Array(WorkerInferenceMessageSchema, {
    maxItems: WORKER_INFERENCE_MAX_CONTEXT_MESSAGES,
  }),
  tools: Type.Optional(
    Type.Array(WorkerInferenceToolSchema, { maxItems: WORKER_INFERENCE_MAX_TOOLS }),
  ),
});

const WorkerInferenceReasoningSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("adaptive"),
  Type.Literal("max"),
]);

const WorkerInferenceThinkingBudgetSchema = Type.Integer({
  minimum: 0,
  maximum: WORKER_INFERENCE_MAX_OUTPUT_TOKENS,
});

const WorkerInferenceThinkingBudgetsSchema = workerInferenceObject({
  minimal: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  low: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  medium: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  high: Type.Optional(WorkerInferenceThinkingBudgetSchema),
  max: Type.Optional(WorkerInferenceThinkingBudgetSchema),
});

export const WorkerInferenceOptionsSchema: TSchema = workerInferenceObject({
  temperature: Type.Optional(Type.Number({ minimum: 0, maximum: 2 })),
  maxTokens: Type.Optional(
    Type.Integer({ minimum: 1, maximum: WORKER_INFERENCE_MAX_OUTPUT_TOKENS }),
  ),
  reasoning: Type.Optional(WorkerInferenceReasoningSchema),
  thinkingBudgets: Type.Optional(WorkerInferenceThinkingBudgetsSchema),
});

const WorkerInferenceIdentityProperties = {
  runEpoch: LiveIntegerSchema,
  sessionId: WorkerIdentifierSchema,
  runId: WorkerIdentifierSchema,
  turnId: WorkerIdentifierSchema,
};

export const WorkerInferenceStartParamsSchema: TSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
  modelRef: WorkerInferenceModelRefSchema,
  context: WorkerInferenceContextSchema,
  options: WorkerInferenceOptionsSchema,
});

export const WorkerInferenceStartResultSchema: TSchema = workerInferenceObject({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("replayed")]),
});

export const WorkerInferenceErrorReasonSchema: TSchema = Type.Union([
  Type.Literal("model-not-approved"),
  Type.Literal("invalid-context"),
  Type.Literal("epoch-mismatch"),
  Type.Literal("session-not-attached"),
  Type.Literal("provider-error"),
  Type.Literal("cancelled"),
]);

export const WorkerInferenceErrorShapeSchema: TSchema = workerInferenceObject({
  code: Type.Union([Type.Literal("INVALID_REQUEST"), Type.Literal("UNAVAILABLE")]),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: workerInferenceObject({ reason: WorkerInferenceErrorReasonSchema }),
});

export const WorkerInferenceStartRequestFrameSchema: TSchema = workerInferenceObject({
  type: Type.Literal("req"),
  id: WorkerFrameIdSchema,
  method: Type.Literal(WORKER_INFERENCE_METHODS[0]),
  params: WorkerInferenceStartParamsSchema,
});

const WorkerInferenceStartSuccessResponseFrameSchema = workerInferenceObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: WorkerInferenceStartResultSchema,
});

const WorkerInferenceErrorResponseFrameSchema = workerInferenceObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(false),
  error: WorkerInferenceErrorShapeSchema,
});

export const WorkerInferenceStartResponseFrameSchema: TSchema = Type.Union([
  WorkerInferenceStartSuccessResponseFrameSchema,
  WorkerInferenceErrorResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

export const WorkerInferenceCancelParamsSchema: TSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
});

export const WorkerInferenceCancelResultSchema: TSchema = workerInferenceObject({
  status: Type.Literal("cancelled"),
});

export const WorkerInferenceCancelRequestFrameSchema: TSchema = workerInferenceObject({
  type: Type.Literal("req"),
  id: WorkerFrameIdSchema,
  method: Type.Literal(WORKER_INFERENCE_METHODS[1]),
  params: WorkerInferenceCancelParamsSchema,
});

const WorkerInferenceCancelSuccessResponseFrameSchema = workerInferenceObject({
  type: Type.Literal("res"),
  id: WorkerFrameIdSchema,
  ok: Type.Literal(true),
  payload: WorkerInferenceCancelResultSchema,
});

export const WorkerInferenceCancelResponseFrameSchema: TSchema = Type.Union([
  WorkerInferenceCancelSuccessResponseFrameSchema,
  WorkerInferenceErrorResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

export const WorkerInferenceResolvedModelSchema: TSchema = workerInferenceObject({
  api: WorkerIdentifierSchema,
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
});

const WorkerInferenceStreamEventSchema = Type.Union([
  workerInferenceObject({
    type: Type.Literal("start"),
    resolvedModel: WorkerInferenceResolvedModelSchema,
    timestamp: LiveIntegerSchema,
  }),
  workerInferenceObject({
    type: Type.Literal("text_start"),
    contentIndex: LiveIntegerSchema,
    contentSignature: OptionalInferenceTextSchema,
  }),
  workerInferenceObject({
    type: Type.Literal("text_delta"),
    contentIndex: LiveIntegerSchema,
    delta: InferenceTextSchema,
  }),
  workerInferenceObject({
    type: Type.Literal("text_end"),
    contentIndex: LiveIntegerSchema,
    contentSignature: OptionalInferenceTextSchema,
  }),
  workerInferenceObject({ type: Type.Literal("thinking_start"), contentIndex: LiveIntegerSchema }),
  workerInferenceObject({
    type: Type.Literal("thinking_delta"),
    contentIndex: LiveIntegerSchema,
    delta: InferenceTextSchema,
  }),
  workerInferenceObject({
    type: Type.Literal("thinking_end"),
    contentIndex: LiveIntegerSchema,
    contentSignature: OptionalInferenceTextSchema,
  }),
  workerInferenceObject({
    type: Type.Literal("toolcall_start"),
    contentIndex: LiveIntegerSchema,
    id: WorkerIdentifierSchema,
    toolName: WorkerIdentifierSchema,
  }),
  workerInferenceObject({
    type: Type.Literal("toolcall_delta"),
    contentIndex: LiveIntegerSchema,
    delta: InferenceTextSchema,
  }),
  workerInferenceObject({ type: Type.Literal("toolcall_end"), contentIndex: LiveIntegerSchema }),
]);

export const WorkerInferenceEventParamsSchema: TSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
  seq: LiveSequenceSchema,
  event: WorkerInferenceStreamEventSchema,
});

export const WorkerInferenceEventFrameSchema: TSchema = workerInferenceObject({
  type: Type.Literal("event"),
  event: Type.Literal("worker.inference.event"),
  payload: WorkerInferenceEventParamsSchema,
});

const WorkerInferenceTerminalDoneSchema = workerInferenceObject({
  type: Type.Literal("done"),
  message: WorkerInferenceAssistantMessageSchema,
});

const WorkerInferenceTerminalErrorSchema = workerInferenceObject({
  type: Type.Literal("error"),
  reason: WorkerInferenceErrorReasonSchema,
  message: Type.String({ minLength: 1, maxLength: 256 }),
  usage: Type.Optional(WorkerTranscriptUsageSchema),
});

export const WorkerInferenceTerminalOutcomeSchema: TSchema = Type.Union([
  WorkerInferenceTerminalDoneSchema,
  WorkerInferenceTerminalErrorSchema,
]);

export const WorkerInferenceTerminalParamsSchema: TSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
  seq: LiveSequenceSchema,
  outcome: WorkerInferenceTerminalOutcomeSchema,
});

export const WorkerInferenceTerminalFrameSchema: TSchema = workerInferenceObject({
  type: Type.Literal("event"),
  event: Type.Literal("worker.inference.terminal"),
  payload: WorkerInferenceTerminalParamsSchema,
});

type WorkerInferenceUserMessage = Omit<
  Extract<WorkerTranscriptMessage, { role: "user" }>,
  "content"
> & {
  content: string | Extract<WorkerTranscriptMessage, { role: "user" }>["content"];
  runtimeContextCarrier?: boolean;
};
type WorkerInferenceContextMessage =
  | WorkerInferenceUserMessage
  | Extract<WorkerTranscriptMessage, { role: "assistant" | "toolResult" }>;
type WorkerInferenceTool = { name: string; description: string; parameters: unknown };
type WorkerInferenceIdentity = {
  runEpoch: number;
  sessionId: string;
  runId: string;
  turnId: string;
};
type WorkerInferenceThinkingBudgets = {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
  max?: number;
};
type WorkerInferenceUsage = Extract<WorkerTranscriptMessage, { role: "assistant" }>["usage"];
type WorkerInferenceAssistantMessage = Omit<
  Extract<WorkerTranscriptMessage, { role: "assistant" }>,
  "diagnostics" | "stopReason" | "errorMessage" | "errorCode" | "errorType" | "errorBody"
> & { stopReason: "stop" | "length" | "toolUse" };

export type WorkerInferenceModelRef = { provider: string; model: string };
export type WorkerInferenceContext = {
  systemPrompt?: string;
  messages: WorkerInferenceContextMessage[];
  tools?: WorkerInferenceTool[];
};
export type WorkerInferenceOptions = {
  temperature?: number;
  maxTokens?: number;
  reasoning?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
  thinkingBudgets?: WorkerInferenceThinkingBudgets;
};
export type WorkerInferenceStartParams = WorkerInferenceIdentity & {
  modelRef: WorkerInferenceModelRef;
  context: WorkerInferenceContext;
  options: WorkerInferenceOptions;
};
export type WorkerInferenceStartResult = { status: "accepted" | "replayed" };
export type WorkerInferenceErrorReason =
  | "model-not-approved"
  | "invalid-context"
  | "epoch-mismatch"
  | "session-not-attached"
  | "provider-error"
  | "cancelled";
export type WorkerInferenceErrorShape = {
  code: "INVALID_REQUEST" | "UNAVAILABLE";
  message: string;
  details: { reason: WorkerInferenceErrorReason };
};
export type WorkerInferenceStartRequestFrame = {
  type: "req";
  id: string;
  method: "worker.inference.start";
  params: WorkerInferenceStartParams;
};
type WorkerInferenceResponseErrorFrame = {
  type: "res";
  id: string;
  ok: false;
  error: WorkerInferenceErrorShape | WorkerErrorShape;
};
export type WorkerInferenceStartResponseFrame =
  | { type: "res"; id: string; ok: true; payload: WorkerInferenceStartResult }
  | WorkerInferenceResponseErrorFrame;
export type WorkerInferenceCancelParams = WorkerInferenceIdentity;
export type WorkerInferenceCancelResult = { status: "cancelled" };
export type WorkerInferenceCancelRequestFrame = {
  type: "req";
  id: string;
  method: "worker.inference.cancel";
  params: WorkerInferenceCancelParams;
};
export type WorkerInferenceCancelResponseFrame =
  | { type: "res"; id: string; ok: true; payload: WorkerInferenceCancelResult }
  | WorkerInferenceResponseErrorFrame;
export type WorkerInferenceResolvedModel = { api: string; provider: string; model: string };
type WorkerInferenceStreamEvent =
  | { type: "start"; resolvedModel: WorkerInferenceResolvedModel; timestamp: number }
  | { type: "text_start"; contentIndex: number; contentSignature?: string }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; contentSignature?: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; contentSignature?: string }
  | { type: "toolcall_start"; contentIndex: number; id: string; toolName: string }
  | { type: "toolcall_delta"; contentIndex: number; delta: string }
  | { type: "toolcall_end"; contentIndex: number };
export type WorkerInferenceEventParams = WorkerInferenceIdentity & {
  seq: number;
  event: WorkerInferenceStreamEvent;
};
export type WorkerInferenceEventFrame = {
  type: "event";
  event: "worker.inference.event";
  payload: WorkerInferenceEventParams;
};
export type WorkerInferenceTerminalOutcome =
  | { type: "done"; message: WorkerInferenceAssistantMessage }
  | {
      type: "error";
      reason: WorkerInferenceErrorReason;
      message: string;
      usage?: WorkerInferenceUsage;
    };
export type WorkerInferenceTerminalParams = WorkerInferenceIdentity & {
  seq: number;
  outcome: WorkerInferenceTerminalOutcome;
};
export type WorkerInferenceTerminalFrame = {
  type: "event";
  event: "worker.inference.terminal";
  payload: WorkerInferenceTerminalParams;
};

function isSafeWorkerInferenceJson(data: unknown): boolean {
  const stack: Array<{ depth: number; value: unknown }> = [{ depth: 0, value: data }];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || current.depth > WORKER_TRANSCRIPT_MAX_JSON_DEPTH) {
      return false;
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value !== "object" || seen.has(current.value)) {
      return false;
    }
    seen.add(current.value);
    const values = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const value of values) {
      stack.push({ depth: current.depth + 1, value });
    }
  }
  return true;
}

export function validateWorkerInferenceStartParams(
  data: unknown,
): data is WorkerInferenceStartParams {
  return isSafeWorkerInferenceJson(data) && Value.Check(WorkerInferenceStartParamsSchema, data);
}

export function validateWorkerInferenceCancelParams(
  data: unknown,
): data is WorkerInferenceCancelParams {
  return isSafeWorkerInferenceJson(data) && Value.Check(WorkerInferenceCancelParamsSchema, data);
}

export function validateWorkerInferenceTerminalOutcome(
  data: unknown,
): data is WorkerInferenceTerminalOutcome {
  return isSafeWorkerInferenceJson(data) && Value.Check(WorkerInferenceTerminalOutcomeSchema, data);
}

export function validateWorkerInferenceEventFrame(
  data: unknown,
): data is WorkerInferenceEventFrame {
  return isSafeWorkerInferenceJson(data) && Value.Check(WorkerInferenceEventFrameSchema, data);
}

export function validateWorkerInferenceTerminalFrame(
  data: unknown,
): data is WorkerInferenceTerminalFrame {
  return isSafeWorkerInferenceJson(data) && Value.Check(WorkerInferenceTerminalFrameSchema, data);
}
