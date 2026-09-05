/** Built-in blocking user-question tool and its active-session answer bridge. */
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type {
  QuestionAnswers,
  QuestionRequestQuestion,
  QuestionWaitAnswerResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { isReplyDispatchDeliveryError } from "../../auto-reply/reply/reply-dispatch-outcome.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  resolveAgentQuestionGatewayCall,
  type AgentHarnessQuestionGatewayCall,
  type AgentQuestionDispatcher,
} from "../harness/gateway-question-dispatch.js";
import { registerPendingAgentQuestion } from "../harness/gateway-question.js";
import {
  resolveAgentQuestionAnswerAuthority,
  withAgentQuestionAnswerAuthority,
} from "../harness/host-private-capabilities.js";
import { ASK_USER_TOOL_DISPLAY_SUMMARY, describeAskUserTool } from "../tool-description-presets.js";
import {
  DEFAULT_ASK_USER_TIMEOUT_SECONDS,
  type NormalizedAskUserParams,
  normalizeAskUserParams,
} from "./ask-user-tool-normalization.js";
import { type AnyAgentTool, ToolInputError, textResult } from "./common.js";
import {
  createGatewayQuestionCanceller,
  readQuestionErrorReason,
  type GatewayQuestionCall,
} from "./gateway-question-lifecycle.js";
import { type QuestionPromptDelivery, sendQuestionToolPrompt } from "./question-prompt-send.js";

const ASK_USER_RPC_GRACE_MS = 10_000;
const ASK_USER_PROMPT_RECHECK_MS = 50;

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
            description: "Single-sentence question only. Put all selectable choices in options.",
          }),
          options: Type.Array(
            Type.Object(
              {
                label: Type.String({ minLength: 1 }),
                description: Type.Optional(Type.String()),
              },
              { additionalProperties: false },
            ),
            {
              minItems: 2,
              maxItems: 4,
              description:
                "Every selectable choice. Put the recommended choice first; do not repeat choices only in the question text.",
            },
          ),
          multiSelect: Type.Optional(
            Type.Boolean({
              description: "True only when the user may choose several options at once.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 3 },
    ),
    timeoutSeconds: Type.Optional(
      Type.Integer({
        description:
          "Maximum human wait in seconds; default 900, clamped 30-3600. Earlier run cancellation or overall run timeout still applies.",
      }),
    ),
  },
  { additionalProperties: false },
);

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

export { normalizeAskUserParams } from "./ask-user-tool-normalization.js";

/** Stable client-generated gateway question id shared with tool-start delivery. */
function buildAskUserQuestionId(
  toolCallId: string,
  sessionKey?: string,
  runId?: string,
  agentId?: string,
): string {
  const owner = runId?.trim() || askUserSessionKey(sessionKey, agentId);
  const identity = `${owner}\0${toolCallId}`;
  return `ask_${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}

function askUserSessionKey(sessionKey: string | undefined, agentId?: string): string {
  const normalizedSessionKey = sessionKey?.trim();
  if (normalizedSessionKey && parseAgentSessionKey(normalizedSessionKey)) {
    return normalizedSessionKey;
  }
  return `${agentId?.trim() || "unknown"}\0${normalizedSessionKey || "session:unknown"}`;
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
  agentId?: string;
  questions: QuestionRequestQuestion[];
  timeoutSeconds?: number;
}): { questionId: string } | undefined {
  const sessionKey = askUserSessionKey(params.sessionKey, params.agentId);
  if (findAskUserQuestionForSession(sessionKey)) {
    return undefined;
  }
  const questionId = buildAskUserQuestionId(
    params.toolCallId,
    params.sessionKey,
    params.runId,
    params.agentId,
  );
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
  gatewayCall: GatewayQuestionCall = resolveAgentQuestionGatewayCall(),
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
  gatewayCall: GatewayQuestionCall,
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
  gatewayCall: GatewayQuestionCall,
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

/**
 * Settles the prompt wait from the same run that published the prompt.
 *
 * Detached on purpose: the waiter below races prompt delivery against the answer,
 * so this must not block the tool call that is registering that answer.
 */
function settleAfterOwnPromptDelivery(questionId: string, delivery: Promise<void>): void {
  void delivery.then(
    () => settleAskUserPromptDelivery(questionId),
    (error: unknown) => settleAskUserPromptDelivery(questionId, error),
  );
}

/** Rechecks the Gateway immediately before exposing an answerable prompt. */
export async function isAskUserPromptPending(
  questionId: string,
  gatewayCall: GatewayQuestionCall = resolveAgentQuestionGatewayCall(),
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
  agentId?: string,
): void {
  releaseAskUserQuestion(buildAskUserQuestionId(toolCallId, sessionKey, runId, agentId));
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

/** Shares question ownership and prompt delivery without installing a plaintext answer claim. */
export function beginAskUserPromptDelivery(params: {
  toolCallId: string;
  sessionKey?: string;
  runId?: string;
  agentId?: string;
  questions: QuestionRequestQuestion[];
  timeoutSeconds: number;
  /** Publishes the prompt when no harness reserved one for this call. */
  deliverPrompt?: (questionId: string) => Promise<void>;
}) {
  const questionId = buildAskUserQuestionId(
    params.toolCallId,
    params.sessionKey,
    params.runId,
    params.agentId,
  );
  const sessionKey = askUserSessionKey(params.sessionKey, params.agentId);
  const reserved = askUserQuestions.get(questionId);
  const existing = findAskUserQuestionForSession(sessionKey);
  if ((reserved && reserved.phase.kind !== "reserved") || (existing && existing !== reserved)) {
    throw new ToolInputError(
      "a question is already pending for this session; wait for it to resolve before requesting another",
    );
  }
  const state: AskUserQuestionState = reserved ?? {
    questionId,
    sessionKey,
    questions: params.questions,
    expiresAtMs: 0,
    phase: { kind: "registering" },
    waiters: new Set(),
  };
  Object.assign(state, { sessionKey, questions: params.questions });
  state.expiresAtMs = Date.now() + params.timeoutSeconds * 1_000;
  transitionAskUserQuestion(state, { kind: "registering" });
  askUserQuestions.set(questionId, state);
  return {
    questionId,
    hasSubscriber: reserved !== undefined || params.deliverPrompt !== undefined,
    markReady() {
      if (reserved) {
        markAskUserPromptReady(questionId, params.questions);
        return;
      }
      if (params.deliverPrompt) {
        // Nothing reserved this prompt, so this run publishes it and settles its own wait.
        markAskUserPromptReady(questionId, params.questions);
        settleAfterOwnPromptDelivery(questionId, params.deliverPrompt(questionId));
        return;
      }
      transitionAskUserQuestion(state, { kind: "answerable" });
    },
    waitForDelivery(signal?: AbortSignal) {
      return waitForPromptDelivery(state, signal);
    },
    release() {
      if (askUserQuestions.get(questionId) === state) {
        releaseAskUserQuestion(questionId);
      }
    },
  };
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
  gatewayCall?: AgentHarnessQuestionGatewayCall | AgentQuestionDispatcher;
  /** How this run shows a prompt when its harness does not reserve one. */
  questionPrompt?: QuestionPromptDelivery;
}): AnyAgentTool {
  // Tool callbacks may run outside their creation scope; never borrow the invoker's owner.
  const questionAuthority = resolveAgentQuestionAnswerAuthority();
  const gatewayCall = resolveAgentQuestionGatewayCall(params.gatewayCall);
  return {
    label: "Ask User",
    name: "ask_user",
    displaySummary: ASK_USER_TOOL_DISPLAY_SUMMARY,
    description: describeAskUserTool(),
    parameters: AskUserToolSchema,
    execute: async (toolCallId, args, signal) => {
      const questionId = buildAskUserQuestionId(
        toolCallId,
        params.sessionKey,
        params.runId,
        params.agentId,
      );
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
      // A harness that runs tools through the embedded tool lifecycle reserves the
      // prompt before this call. One that dispatches tools itself reserves nothing,
      // so the tool publishes its own prompt rather than blocking on a silent wait.
      const publishOwnPrompt = reserved ? undefined : params.questionPrompt?.send;
      const deliverPrompt = reserved?.phase.kind === "reserved" || publishOwnPrompt !== undefined;
      const state: AskUserQuestionState =
        reserved ??
        ({
          questionId,
          sessionKey,
          questions: normalized.questions,
          expiresAtMs: Date.now() + timeoutMs,
          phase: { kind: "registering" },
          waiters: new Set(),
        } satisfies AskUserQuestionState);
      Object.assign(state, { sessionKey, questions: normalized.questions });
      state.expiresAtMs = Date.now() + timeoutMs;
      transitionAskUserQuestion(state, { kind: "registering" });
      askUserQuestions.set(questionId, state);
      let registered = false;
      const cancelPendingQuestion = createGatewayQuestionCanceller({ gatewayCall, questionId });
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
        state.claim = withAgentQuestionAnswerAuthority(questionAuthority, () =>
          registerPendingAgentQuestion({
            questionId,
            sessionKey,
            questions: normalized.questions.map(({ questionId: id, ...question }) => ({
              ...question,
              id,
            })),
            gatewayCall: params.gatewayCall,
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
          }),
        );
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
                ...(params.runId ? { runId: params.runId } : {}),
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
          { id: questionId, timeoutMs, includeResolutionId: true },
          signal ? { signal } : undefined,
        ) as Promise<QuestionWaitAnswerResult>;
        state.answer = answerPromise;
        state.claim.setAnswer(answerPromise);
        // A refused registration-time claim releases prompt delivery, not the question.
        let consumed: boolean;
        do {
          consumed = await Promise.race([
            state.claim.waitForResolution(),
            answerPromise.then(() => true),
          ]);
        } while (!consumed && state.claim.isResolving());
        if (deliverPrompt && !consumed) {
          // Tool-start reserves the prompt, but only a committed Gateway record opens delivery.
          // This prevents channels from exposing a question ID that cannot accept an answer.
          // A consumed registration-time claim must not expose a stale prompt.
          markAskUserPromptReady(questionId, normalized.questions);
          if (publishOwnPrompt) {
            settleAfterOwnPromptDelivery(
              questionId,
              sendQuestionToolPrompt({
                toolName: "ask_user",
                questionId,
                questions: normalized.questions,
                send: publishOwnPrompt,
              }),
            );
          }
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
            if (
              isReplyDispatchDeliveryError(deliveryResult.error) &&
              deliveryResult.error.outcome === "failed-deliver"
            ) {
              const details = { status: "delivery_failed" as const };
              return {
                ...textResult(
                  `The prompt became visible, but its controls failed to deliver. The question was cancelled; no retry/fallback should be sent.\n\n${JSON.stringify(details, null, 2)}`,
                  details,
                ),
                terminate: true,
              };
            }
            throw new Error("ask_user prompt delivery failed", { cause: deliveryResult.error });
          }
        } else if (!consumed) {
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
