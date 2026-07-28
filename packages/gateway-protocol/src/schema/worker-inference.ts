import { Type, type Static, type TProperties } from "typebox";
import { Value } from "typebox/value";
import { closedObject } from "./closed-object.js";
import {
  WORKER_TRANSCRIPT_MAX_CONTENT_PARTS,
  WORKER_TRANSCRIPT_MAX_JSON_DEPTH,
} from "./worker-admission.js";
import {
  LiveIntegerSchema,
  LiveSequenceSchema,
  LiveTextSchema,
  WorkerErrorResponseFrameSchema,
  WorkerFrameIdSchema,
  WorkerIdentifierSchema,
  WorkerTranscriptAssistantDiagnosticSchema,
  WorkerTranscriptUsageSchema,
} from "./worker-protocol-primitives.js";

export const WORKER_INFERENCE_PROTOCOL_FEATURE = "worker-inference-v1";
export const WORKER_INFERENCE_METHODS = [
  "worker.inference.start",
  "worker.inference.cancel",
] as const;
export const WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const WORKER_INFERENCE_MAX_CONTEXT_MESSAGES = 1_024;
const WORKER_INFERENCE_MAX_TOOLS = 256;
export const WORKER_INFERENCE_MAX_OUTPUT_TOKENS = 1_000_000;

function workerInferenceObject<const Properties extends TProperties>(properties: Properties) {
  return closedObject(properties);
}

const InferenceTextSchema = Type.String({
  maxLength: WORKER_PROTOCOL_MAX_INFERENCE_PAYLOAD_BYTES,
});
const OptionalInferenceTextSchema = Type.Optional(InferenceTextSchema);
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

export const WorkerInferenceModelRefSchema = workerInferenceObject({
  provider: WorkerIdentifierSchema,
  model: WorkerIdentifierSchema,
});

const WorkerInferenceContextSchema = workerInferenceObject({
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

export const WorkerInferenceOptionsSchema = workerInferenceObject({
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

const WorkerInferenceStartParamsSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
  modelRef: WorkerInferenceModelRefSchema,
  context: WorkerInferenceContextSchema,
  options: WorkerInferenceOptionsSchema,
});

const WorkerInferenceStartResultSchema = workerInferenceObject({
  status: Type.Union([Type.Literal("accepted"), Type.Literal("replayed")]),
});

const WorkerInferenceErrorReasonSchema = Type.Union([
  Type.Literal("model-not-approved"),
  Type.Literal("invalid-context"),
  Type.Literal("epoch-mismatch"),
  Type.Literal("session-not-attached"),
  Type.Literal("provider-error"),
  Type.Literal("cancelled"),
]);

const WorkerInferenceErrorShapeSchema = workerInferenceObject({
  code: Type.Union([Type.Literal("INVALID_REQUEST"), Type.Literal("UNAVAILABLE")]),
  message: Type.String({ minLength: 1, maxLength: 256 }),
  details: workerInferenceObject({ reason: WorkerInferenceErrorReasonSchema }),
});

export const WorkerInferenceStartRequestFrameSchema = workerInferenceObject({
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

export const WorkerInferenceStartResponseFrameSchema = Type.Union([
  WorkerInferenceStartSuccessResponseFrameSchema,
  WorkerInferenceErrorResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

const WorkerInferenceCancelParamsSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
});

const WorkerInferenceCancelResultSchema = workerInferenceObject({
  status: Type.Literal("cancelled"),
});

export const WorkerInferenceCancelRequestFrameSchema = workerInferenceObject({
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

export const WorkerInferenceCancelResponseFrameSchema = Type.Union([
  WorkerInferenceCancelSuccessResponseFrameSchema,
  WorkerInferenceErrorResponseFrameSchema,
  WorkerErrorResponseFrameSchema,
]);

const WorkerInferenceResolvedModelSchema = workerInferenceObject({
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

const WorkerInferenceEventParamsSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
  seq: LiveSequenceSchema,
  event: WorkerInferenceStreamEventSchema,
});

const WorkerInferenceEventFrameSchema = workerInferenceObject({
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

const WorkerInferenceTerminalOutcomeSchema = Type.Union([
  WorkerInferenceTerminalDoneSchema,
  WorkerInferenceTerminalErrorSchema,
]);

const WorkerInferenceTerminalParamsSchema = workerInferenceObject({
  ...WorkerInferenceIdentityProperties,
  seq: LiveSequenceSchema,
  outcome: WorkerInferenceTerminalOutcomeSchema,
});

const WorkerInferenceTerminalFrameSchema = workerInferenceObject({
  type: Type.Literal("event"),
  event: Type.Literal("worker.inference.terminal"),
  payload: WorkerInferenceTerminalParamsSchema,
});

export type WorkerInferenceModelRef = Static<typeof WorkerInferenceModelRefSchema>;
export type WorkerInferenceContext = Static<typeof WorkerInferenceContextSchema>;
export type WorkerInferenceOptions = Static<typeof WorkerInferenceOptionsSchema>;
export type WorkerInferenceStartParams = Static<typeof WorkerInferenceStartParamsSchema>;
export type WorkerInferenceStartResult = Static<typeof WorkerInferenceStartResultSchema>;
export type WorkerInferenceErrorReason = Static<typeof WorkerInferenceErrorReasonSchema>;
export type WorkerInferenceErrorShape = Static<typeof WorkerInferenceErrorShapeSchema>;
export type WorkerInferenceStartRequestFrame = Static<
  typeof WorkerInferenceStartRequestFrameSchema
>;
export type WorkerInferenceStartResponseFrame = Static<
  typeof WorkerInferenceStartResponseFrameSchema
>;
export type WorkerInferenceCancelParams = Static<typeof WorkerInferenceCancelParamsSchema>;
export type WorkerInferenceCancelResult = Static<typeof WorkerInferenceCancelResultSchema>;
export type WorkerInferenceCancelRequestFrame = Static<
  typeof WorkerInferenceCancelRequestFrameSchema
>;
export type WorkerInferenceCancelResponseFrame = Static<
  typeof WorkerInferenceCancelResponseFrameSchema
>;
export type WorkerInferenceEventParams = Static<typeof WorkerInferenceEventParamsSchema>;
export type WorkerInferenceEventFrame = Static<typeof WorkerInferenceEventFrameSchema>;
export type WorkerInferenceTerminalOutcome = Static<typeof WorkerInferenceTerminalOutcomeSchema>;
export type WorkerInferenceTerminalParams = Static<typeof WorkerInferenceTerminalParamsSchema>;
export type WorkerInferenceTerminalFrame = Static<typeof WorkerInferenceTerminalFrameSchema>;

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
