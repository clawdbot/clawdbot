/** Built-in blocking user-question tool and its active-session answer bridge. */
import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import type {
  QuestionAnswers,
  QuestionRequestQuestion,
  QuestionWaitAnswerResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerPendingAgentQuestion } from "../harness/gateway-question.js";
import { ASK_USER_TOOL_DISPLAY_SUMMARY, describeAskUserTool } from "../tool-description-presets.js";
import { type AnyAgentTool, ToolInputError, textResult } from "./common.js";
import { callGatewayTool, type GatewayCallOptions } from "./gateway.js";

const DEFAULT_ASK_USER_TIMEOUT_SECONDS = 900;
const MIN_ASK_USER_TIMEOUT_SECONDS = 30;
const MAX_ASK_USER_TIMEOUT_SECONDS = 3600;
const ASK_USER_RPC_GRACE_MS = 10_000;
const ASK_USER_PROMPT_RECHECK_MS = 50;
const QUESTION_ID_PATTERN = /^[a-z][a-z0-9_]*$/;
const TERMINAL_QUESTION_ERROR_REASONS = new Set([
  "QUESTION_ALREADY_TERMINAL",
  "QUESTION_NOT_FOUND",
]);

const AskUserToolSchema = Type.Object(
  {
    questions: Type.Array(
      Type.Object(
        {
          id: Type.String({
            minLength: 1,
            pattern: "^[a-z][a-z0-9_]*$",
            description: "Unique snake_case answer key.",
          }),
          header: Type.String({
            minLength: 1,
            description: "Short chip label; longer input is truncated to 12 characters.",
          }),
          question: Type.String({
            minLength: 1,
            description: "Single-sentence question for the user.",
          }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1 }),
                description: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            { minItems: 2, maxItems: 4 },
          ),
          multiSelect: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    timeoutSeconds: Type.Optional(Type.Integer()),
  },
  { additionalProperties: false },
);

type AskUserGatewayCall = (
  method: string,
  opts: GatewayCallOptions,
  params?: unknown,
  extra?: { signal?: AbortSignal },
) => Promise<unknown>;

type AskUserQuestionPhase =
  | { kind: "reserved" }
  | { kind: "registering" }
  | { kind: "prompting" }
  | { kind: "answerable" }
  | { kind: "resolving" }
  | { kind: "prompt-failed"; error: unknown };

type AskUserQuestionState = {
  questionId: string;
  sessionKey: string;
  questions: QuestionRequestQuestion[];
  expiresAtMs: number;
  phase: AskUserQuestionPhase;
  gatewayCall?: AskUserGatewayCall;
  answer?: Promise<QuestionWaitAnswerResult>;
  claim?: ReturnType<typeof registerPendingAgentQuestion>;
  waiters: Set<() => void>;
};

const ASK_USER_QUESTIONS_KEY = Symbol.for("openclaw.askUserQuestions");
const askUserGlobal = globalThis as Record<PropertyKey, unknown>;
// Tool execution and subscriber delivery can live in separate production bundles.
// Keep one process registry or prompt readiness never reaches the delivery waiter.
const askUserQuestions = (() => {
  const existing = askUserGlobal[ASK_USER_QUESTIONS_KEY];
  if (existing instanceof Map) {
    return existing as Map<string, AskUserQuestionState>;
  }
  const questions = new Map<string, AskUserQuestionState>();
  askUserGlobal[ASK_USER_QUESTIONS_KEY] = questions;
  return questions;
})();

type NormalizedAskUserParams = {
  questions: QuestionRequestQuestion[];
  timeoutSeconds: number;
};

function readRequiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolInputError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOption(value: unknown, questionIndex: number, optionIndex: number) {
  const labelPrefix = `questions[${questionIndex}].options[${optionIndex}]`;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${labelPrefix} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const label = readRequiredString(record.label, `${labelPrefix}.label`);
  // Telegram button text caps at 64 chars — the tightest native transport.
  // Bounding here keeps schema-valid prompts deliverable on every channel.
  if (label.length > 64) {
    throw new ToolInputError(`${labelPrefix}.label must be at most 64 characters (use 1-5 words)`);
  }
  if (record.description !== undefined && typeof record.description !== "string") {
    throw new ToolInputError(`${labelPrefix}.description must be a string`);
  }
  const description =
    typeof record.description === "string" ? record.description.trim() : undefined;
  return { label, ...(description ? { description } : {}) };
}

/** Validates and canonicalizes model-authored ask_user arguments. */
export function normalizeAskUserParams(value: unknown): NormalizedAskUserParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError("ask_user arguments must be an object");
  }
  const params = value as Record<string, unknown>;
  if (
    !Array.isArray(params.questions) ||
    params.questions.length < 1 ||
    params.questions.length > 3
  ) {
    throw new ToolInputError("questions must contain 1 to 3 questions");
  }
  const ids = new Set<string>();
  const questions = params.questions.map(
    (questionValue, questionIndex): QuestionRequestQuestion => {
      const prefix = `questions[${questionIndex}]`;
      if (!questionValue || typeof questionValue !== "object" || Array.isArray(questionValue)) {
        throw new ToolInputError(`${prefix} must be an object`);
      }
      const question = questionValue as Record<string, unknown>;
      const id = readRequiredString(question.id, `${prefix}.id`);
      if (!QUESTION_ID_PATTERN.test(id)) {
        throw new ToolInputError(`${prefix}.id must be snake_case (for example, deploy_target)`);
      }
      if (ids.has(id)) {
        throw new ToolInputError(`duplicate question id '${id}'`);
      }
      ids.add(id);
      const header = truncateUtf16Safe(readRequiredString(question.header, `${prefix}.header`), 12);
      const questionText = readRequiredString(question.question, `${prefix}.question`);
      if (
        !Array.isArray(question.options) ||
        question.options.length < 2 ||
        question.options.length > 4
      ) {
        throw new ToolInputError(`${prefix}.options must contain 2 to 4 options`);
      }
      if (question.multiSelect !== undefined && typeof question.multiSelect !== "boolean") {
        throw new ToolInputError(`${prefix}.multiSelect must be a boolean`);
      }
      return {
        questionId: id,
        header,
        question: questionText,
        options: question.options.map((option, optionIndex) =>
          normalizeOption(option, questionIndex, optionIndex),
        ),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
        isOther: true,
      };
    },
  );

  const rawTimeoutSeconds = params.timeoutSeconds;
  if (
    rawTimeoutSeconds !== undefined &&
    (typeof rawTimeoutSeconds !== "number" ||
      !Number.isFinite(rawTimeoutSeconds) ||
      !Number.isInteger(rawTimeoutSeconds))
  ) {
    throw new ToolInputError("timeoutSeconds must be an integer");
  }
  const timeoutSeconds = Math.min(
    MAX_ASK_USER_TIMEOUT_SECONDS,
    Math.max(MIN_ASK_USER_TIMEOUT_SECONDS, rawTimeoutSeconds ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS),
  );
  return { questions, timeoutSeconds };
}

/** Stable client-generated gateway question id shared with tool-start delivery. */
function buildAskUserQuestionId(toolCallId: string, sessionKey?: string, runId?: string): string {
  const owner = runId?.trim() || sessionKey?.trim() || "";
  const identity = `${owner}\0${toolCallId}`;
  return `ask_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function askUserSessionKey(sessionKey: string | undefined, agentId?: string): string {
  return sessionKey?.trim() || (agentId?.trim() ? `agent:${agentId.trim()}` : "session:unknown");
}

function findAskUserQuestionForSession(sessionKey: string): AskUserQuestionState | undefined {
  for (const question of askUserQuestions.values()) {
    if (question.sessionKey === sessionKey) {
      return question;
    }
  }
  return undefined;
}

function transitionAskUserQuestion(state: AskUserQuestionState, phase: AskUserQuestionPhase): void {
  state.phase = phase;
  for (const wake of state.waiters) {
    wake();
  }
  state.waiters.clear();
}

function releaseAskUserQuestion(questionId: string): void {
  const state = askUserQuestions.get(questionId);
  if (!state) {
    return;
  }
  askUserQuestions.delete(questionId);
  state.claim?.dispose();
  for (const wake of state.waiters) {
    wake();
  }
  state.waiters.clear();
}

async function waitForQuestionChange(
  state: AskUserQuestionState,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const wake = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      state.waiters.delete(wake);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("ask_user aborted"));
    };
    state.waiters.add(wake);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Reserves one visible ask_user prompt slot before subscriber delivery. */
export function reserveAskUserPromptDelivery(params: {
  toolCallId: string;
  sessionKey?: string;
  runId?: string;
  questions: QuestionRequestQuestion[];
  timeoutSeconds?: number;
}): { questionId: string } | undefined {
  const sessionKey = askUserSessionKey(params.sessionKey);
  if (findAskUserQuestionForSession(sessionKey)) {
    return undefined;
  }
  const questionId = buildAskUserQuestionId(params.toolCallId, params.sessionKey, params.runId);
  if (askUserQuestions.has(questionId)) {
    return undefined;
  }
  askUserQuestions.set(questionId, {
    questionId,
    sessionKey,
    questions: params.questions,
    expiresAtMs: Date.now() + (params.timeoutSeconds ?? DEFAULT_ASK_USER_TIMEOUT_SECONDS) * 1_000,
    phase: { kind: "reserved" },
    waiters: new Set(),
  });
  return { questionId };
}

/** Waits until policy-accepted tool execution has registered the gateway question. */
export async function waitForAskUserPromptReady(
  questionId: string,
  gatewayCall: AskUserGatewayCall = callGatewayTool,
): Promise<QuestionRequestQuestion[] | undefined> {
  const state = askUserQuestions.get(questionId);
  if (!state) {
    return undefined;
  }
  while (askUserQuestions.get(questionId) === state) {
    if (
      state.phase.kind === "prompting" ||
      state.phase.kind === "answerable" ||
      state.phase.kind === "resolving" ||
      state.phase.kind === "prompt-failed"
    ) {
      return state.questions;
    }
    try {
      const status = await readAskUserQuestionStatus(questionId, gatewayCall);
      if (status === "pending") {
        // The executor may live in another JS realm or process. The Gateway record
        // is the cross-runtime readiness boundary when local state cannot signal.
        return state.questions;
      }
      if (typeof status === "string") {
        return undefined;
      }
    } catch {
      // Registration and local Gateway credentials may still be coming online.
      // Local state can win on the next pass; isolated runtimes retry the record.
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return undefined;
}

async function readAskUserQuestionStatus(
  questionId: string,
  gatewayCall: AskUserGatewayCall,
): Promise<string | undefined> {
  const result = await gatewayCall("question.list", { timeoutMs: ASK_USER_RPC_GRACE_MS }, {});
  const questions =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as { questions?: unknown }).questions
      : undefined;
  const question = Array.isArray(questions)
    ? questions.find(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          (candidate as { id?: unknown }).id === questionId,
      )
    : undefined;
  const status =
    question && typeof question === "object" && !Array.isArray(question)
      ? (question as { status?: unknown }).status
      : undefined;
  return typeof status === "string" ? status : undefined;
}

type AskUserPromptStatusRead =
  | { kind: "status"; status: string | undefined }
  | { kind: "error" }
  | { kind: "expired" };

async function readAskUserQuestionStatusBeforeExpiry(
  questionId: string,
  expiresAtMs: number,
  gatewayCall: AskUserGatewayCall,
): Promise<AskUserPromptStatusRead> {
  const remainingMs = expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    return { kind: "expired" };
  }
  return await new Promise<AskUserPromptStatusRead>((resolve) => {
    let settled = false;
    const finish = (result: AskUserPromptStatusRead) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(expiryTimer);
      resolve(result);
    };
    const expiryTimer = setTimeout(() => finish({ kind: "expired" }), remainingMs);
    void readAskUserQuestionStatus(questionId, gatewayCall).then(
      (status) => finish({ kind: "status", status }),
      () => finish({ kind: "error" }),
    );
  });
}

/** Opens prompt delivery after question.request succeeds. */
function markAskUserPromptReady(questionId: string, questions: QuestionRequestQuestion[]): void {
  const state = askUserQuestions.get(questionId);
  if (!state || (state.phase.kind !== "reserved" && state.phase.kind !== "registering")) {
    return;
  }
  state.questions = questions;
  transitionAskUserQuestion(state, { kind: "prompting" });
}

/** Records whether the originating-conversation prompt reached its delivery callback. */
export function settleAskUserPromptDelivery(questionId: string, error?: unknown): void {
  const state = askUserQuestions.get(questionId);
  if (!state || state.phase.kind !== "prompting") {
    return;
  }
  transitionAskUserQuestion(
    state,
    error === undefined ? { kind: "answerable" } : { kind: "prompt-failed", error },
  );
}

/** Rechecks the Gateway immediately before exposing an answerable prompt. */
export async function isAskUserPromptPending(
  questionId: string,
  gatewayCall: AskUserGatewayCall = callGatewayTool,
): Promise<boolean> {
  const state = askUserQuestions.get(questionId);
  if (!state) {
    return false;
  }
  while (askUserQuestions.get(questionId) === state) {
    if (state.phase.kind === "resolving" || state.phase.kind === "prompt-failed") {
      return false;
    }
    const read = await readAskUserQuestionStatusBeforeExpiry(
      questionId,
      state.expiresAtMs,
      gatewayCall,
    );
    if (read.kind === "expired") {
      return false;
    }
    // Cancellation can win while the Gateway request is in flight. Recheck local
    // ownership before trusting an older remote `pending` snapshot.
    const currentState = askUserQuestions.get(questionId);
    if (
      currentState !== state ||
      currentState.phase.kind === "resolving" ||
      currentState.phase.kind === "prompt-failed"
    ) {
      return false;
    }
    if (read.kind === "status" && read.status === "pending") {
      return true;
    }
    if (read.kind === "status" && typeof read.status === "string") {
      return false;
    }
    if (read.kind === "error") {
      // Keep the prompt private until Gateway state is authoritative again.
      // Failing open here can expose a stale question after remote terminalization.
    }
    const remainingMs = state.expiresAtMs - Date.now();
    if (remainingMs <= 0) {
      return false;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(ASK_USER_PROMPT_RECHECK_MS, remainingMs));
    });
  }
  return false;
}

/** Releases a tool-start reservation when policy rejects execution. */
export function cancelAskUserPromptDelivery(
  toolCallId: string,
  sessionKey?: string,
  runId?: string,
): void {
  releaseAskUserQuestion(buildAskUserQuestionId(toolCallId, sessionKey, runId));
}

function answeredResult(questions: readonly QuestionRequestQuestion[], answers: QuestionAnswers) {
  const payload = { status: "answered" as const, answers };
  const lines = questions.map((question) => {
    const values = answers.answers[question.questionId] ?? [];
    return `${question.header}: ${values.length > 0 ? values.join(", ") : "(no answer)"}`;
  });
  return textResult(`${lines.join("\n")}\n\n${JSON.stringify(payload, null, 2)}`, payload);
}

function noAnswerResult(status: Exclude<QuestionWaitAnswerResult["status"], "answered">) {
  const payload = { status: "no_answer" as const };
  const note =
    status === "cancelled"
      ? "The question was cancelled; proceed with best judgment."
      : "No answer arrived; proceed with best judgment.";
  return textResult(`${note}\n\n${JSON.stringify(payload, null, 2)}`, payload);
}

async function waitForPromptDelivery(
  state: AskUserQuestionState,
  signal?: AbortSignal,
): Promise<{ error?: unknown }> {
  while (askUserQuestions.get(state.questionId) === state) {
    if (state.phase.kind === "answerable" || state.phase.kind === "resolving") {
      return {};
    }
    if (state.phase.kind === "prompt-failed") {
      return { error: state.phase.error };
    }
    await waitForQuestionChange(state, signal);
  }
  return { error: new Error("ask_user prompt is no longer active") };
}

function readQuestionErrorReason(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const requestError = error as { details?: unknown; name?: unknown };
  if (requestError.name !== "GatewayClientRequestError") {
    return undefined;
  }
  const details = requestError.details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : undefined;
}

function isTerminalQuestionResolveError(error: unknown): boolean {
  const reason = readQuestionErrorReason(error);
  return reason !== undefined && TERMINAL_QUESTION_ERROR_REASONS.has(reason);
}

function resetPendingAskUserQuestionsForTest(): void {
  for (const questionId of askUserQuestions.keys()) {
    releaseAskUserQuestion(questionId);
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.askUserToolTestApi")] = {
    resetPendingAskUserQuestionsForTest,
  };
}

/** Creates the main-session-only blocking ask_user tool. */
export function createAskUserTool(params: {
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  gatewayCall?: AskUserGatewayCall;
}): AnyAgentTool {
  const gatewayCall: AskUserGatewayCall = params.gatewayCall ?? callGatewayTool;
  return {
    label: "Ask User",
    name: "ask_user",
    displaySummary: ASK_USER_TOOL_DISPLAY_SUMMARY,
    description: describeAskUserTool(),
    parameters: AskUserToolSchema,
    execute: async (toolCallId, args, signal) => {
      const questionId = buildAskUserQuestionId(toolCallId, params.sessionKey, params.runId);
      let normalized: NormalizedAskUserParams;
      try {
        signal?.throwIfAborted();
        normalized = normalizeAskUserParams(args);
      } catch (error) {
        releaseAskUserQuestion(questionId);
        throw error;
      }
      const sessionKey = askUserSessionKey(params.sessionKey, params.agentId);
      const reserved = askUserQuestions.get(questionId);
      const existing = findAskUserQuestionForSession(sessionKey);
      if ((reserved && reserved.phase.kind !== "reserved") || (existing && existing !== reserved)) {
        throw new ToolInputError(
          "ask_user already has a pending question for this session; wait for it to resolve before asking another",
        );
      }

      const timeoutMs = normalized.timeoutSeconds * 1_000;
      const deliverPrompt = reserved?.phase.kind === "reserved";
      const state: AskUserQuestionState =
        reserved ??
        ({
          questionId,
          sessionKey,
          questions: normalized.questions,
          expiresAtMs: Date.now() + timeoutMs,
          phase: { kind: "registering" },
          gatewayCall,
          waiters: new Set(),
        } satisfies AskUserQuestionState);
      Object.assign(state, { sessionKey, questions: normalized.questions });
      state.expiresAtMs = Date.now() + timeoutMs;
      state.gatewayCall = gatewayCall;
      transitionAskUserQuestion(state, { kind: "registering" });
      askUserQuestions.set(questionId, state);
      let cancellation:
        | Promise<Extract<QuestionWaitAnswerResult, { status: "answered" }> | undefined>
        | undefined;
      let registered = false;
      const cancelPendingQuestion = (resolvedBy: string) => {
        cancellation ??= (async () => {
          try {
            await gatewayCall(
              "question.resolve",
              { timeoutMs: ASK_USER_RPC_GRACE_MS },
              { id: questionId, cancel: true, resolvedBy },
            );
            return undefined;
          } catch (error) {
            if (!isTerminalQuestionResolveError(error)) {
              return undefined;
            }
            try {
              const result = (await gatewayCall(
                "question.waitAnswer",
                { timeoutMs: ASK_USER_RPC_GRACE_MS },
                { id: questionId, timeoutMs: 1_000 },
              )) as QuestionWaitAnswerResult;
              return result.status === "answered" ? result : undefined;
            } catch {
              return undefined;
            }
          }
        })();
        return cancellation;
      };
      const cancelOnAbort = () => {
        if (askUserQuestions.get(questionId) === state) {
          releaseAskUserQuestion(questionId);
        }
        void cancelPendingQuestion("run-abort");
      };
      const finishWait = async (result: QuestionWaitAnswerResult) => {
        if (result.status === "pending") {
          const answered = await cancelPendingQuestion("wait-timeout");
          if (answered) {
            return answeredResult(normalized.questions, answered.answers);
          }
        }
        if (result.status === "answered") {
          return answeredResult(normalized.questions, result.answers);
        }
        if (
          result.status === "pending" ||
          result.status === "expired" ||
          result.status === "cancelled"
        ) {
          return noAnswerResult(result.status);
        }
        throw new Error("question.waitAnswer returned an invalid status");
      };
      try {
        state.claim = registerPendingAgentQuestion({
          questionId,
          sessionKey,
          questions: normalized.questions.map(({ questionId: id, ...question }) => ({
            ...question,
            id,
          })),
          gatewayCall,
          onCancel: () => {
            if (
              askUserQuestions.get(questionId) === state &&
              state.phase.kind !== "reserved" &&
              state.phase.kind !== "resolving" &&
              state.phase.kind !== "prompt-failed"
            ) {
              transitionAskUserQuestion(state, { kind: "resolving" });
            }
          },
        });
        const registration = Promise.resolve().then(
          () =>
            gatewayCall(
              "question.request",
              {},
              {
                id: questionId,
                questions: normalized.questions,
                ...(params.agentId ? { agentId: params.agentId } : {}),
                ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
                timeoutMs,
              },
              signal ? { signal } : undefined,
            ) as Promise<{ id?: unknown }>,
        );
        state.claim.attachRegistration(registration);
        const requestResult = await registration;
        registered = true;
        if (requestResult.id !== questionId) {
          throw new Error("question.request returned an unexpected question id");
        }
        if (state.claim.isCancellationRequested()) {
          const answered = await cancelPendingQuestion("superseded-input");
          return answered
            ? answeredResult(normalized.questions, answered.answers)
            : noAnswerResult("cancelled");
        }
        signal?.addEventListener("abort", cancelOnAbort, { once: true });
        if (signal?.aborted) {
          cancelOnAbort();
          signal.throwIfAborted();
        }
        const answerPromise = gatewayCall(
          "question.waitAnswer",
          { timeoutMs: timeoutMs + ASK_USER_RPC_GRACE_MS },
          { id: questionId, timeoutMs },
          signal ? { signal } : undefined,
        ) as Promise<QuestionWaitAnswerResult>;
        state.answer = answerPromise;
        const bufferedAnswer = await state.claim.setAnswer(answerPromise);
        if (bufferedAnswer) {
          return await finishWait(await answerPromise);
        }
        if (deliverPrompt && !state.claim.isResolving()) {
          // Tool-start reserves the prompt, but only a committed Gateway record opens delivery.
          // This prevents channels from exposing a question ID that cannot accept an answer.
          // A registration-time claim in flight suppresses delivery entirely: the
          // user already answered, so a late prompt would be stale and the race
          // below could stall on a delivery that never happens.
          markAskUserPromptReady(questionId, normalized.questions);
          const promptDeliveryPromise = waitForPromptDelivery(state, signal);
          const first = await Promise.race([
            promptDeliveryPromise.then((result) => ({
              kind: "delivery" as const,
              result,
            })),
            answerPromise.then((result) => ({ kind: "answer" as const, result })),
          ]);
          signal?.throwIfAborted();
          if (first.kind === "answer") {
            return await finishWait(first.result);
          }
          const deliveryResult = first.result;
          if (deliveryResult.error !== undefined) {
            const answered = await cancelPendingQuestion("prompt-delivery-failed");
            if (answered) {
              return answeredResult(normalized.questions, answered.answers);
            }
            throw new Error("ask_user prompt delivery failed", { cause: deliveryResult.error });
          }
        } else if (!state.claim.isResolving()) {
          transitionAskUserQuestion(state, { kind: "answerable" });
        }
        const result = await state.answer;
        signal?.throwIfAborted();
        return await finishWait(result);
      } catch (error) {
        if (registered || readQuestionErrorReason(error) !== "QUESTION_ID_IN_USE") {
          const answered = await cancelPendingQuestion(
            signal?.aborted ? "run-abort" : registered ? "tool-error" : "registration-failed",
          );
          if (!signal?.aborted && answered) {
            return answeredResult(normalized.questions, answered.answers);
          }
        }
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancelOnAbort);
        if (askUserQuestions.get(questionId) === state) {
          releaseAskUserQuestion(questionId);
        }
      }
    },
  };
}
