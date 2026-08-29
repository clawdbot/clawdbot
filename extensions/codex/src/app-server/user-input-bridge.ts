/** Owns per-turn Codex request_user_input and ordinary MCP elicitation lifecycles. */
import {
  callGatewayTool,
  agentHarnessStructuredInput as structuredInput,
  embeddedAgentLog,
  emptyAgentHarnessUserInputAnswers,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessUserInputOption,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import { createCodexElicitationResponse } from "./elicitation-response.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

const DEFAULT_USER_INPUT_TIMEOUT_MS = 15 * 60_000;
// Codex omits a deadline for nonblocking requests, so bound gateway and secret paths alike.
const NONBLOCKING_USER_INPUT_TIMEOUT_MS = 120_000;
const MAX_USER_INPUT_QUESTIONS = 3;
const MAX_USER_INPUT_OPTIONS = 4;
const MAX_USER_INPUT_ID = 256;
const MAX_USER_INPUT_HEADER = 64;
const MAX_USER_INPUT_TEXT = 4_096;
type StructuredInputCompileResult = ReturnType<typeof structuredInput.compileForm>;

type InteractiveJob = {
  requestId: number | string;
  abort: AbortController;
  cancelValue: JsonValue;
  failureValue: JsonValue;
  run: (signal: AbortSignal) => Promise<JsonValue | undefined>;
  resolve: (value: JsonValue) => void;
};

type CodexInputRequest = { id: number | string; params?: JsonValue };

/** Creates the single per-turn owner for Codex operator input. */
export function createCodexUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
  gatewayCall?: AgentHarnessQuestionGatewayCall;
}) {
  const gatewayCall = params.gatewayCall ?? callGatewayTool;
  const jobs: InteractiveJob[] = [];
  let activeCompletion: Promise<void> | undefined;
  const inputSessionKey = params.paramsForRun.sessionKey ?? params.paramsForRun.sessionId;

  const pump = () => {
    const job = jobs[0];
    if (activeCompletion || !job) {
      return;
    }
    activeCompletion = job
      .run(job.abort.signal)
      .catch((error: unknown) => {
        embeddedAgentLog.warn("failed to bridge codex operator input", { error });
        return job.abort.signal.aborted ? job.cancelValue : job.failureValue;
      })
      .then((value) => {
        // Lifecycle cancellation owns the request once observed, so a late
        // answer cannot cross into the queued replacement.
        job.resolve(job.abort.signal.aborted ? job.cancelValue : (value ?? job.failureValue));
      })
      .finally(() => {
        if (jobs[0] === job) {
          jobs.shift();
        }
        activeCompletion = undefined;
        pump();
      });
  };

  const enqueue = (definition: Omit<InteractiveJob, "resolve">) => {
    if (params.signal?.aborted) {
      return Promise.resolve(definition.cancelValue);
    }
    return new Promise<JsonValue>((resolve) => {
      jobs.push({ ...definition, resolve });
      pump();
    });
  };

  const cancelJob = (job: InteractiveJob) => {
    const index = jobs.indexOf(job);
    if (index < 0) {
      return;
    }
    if (index === 0) {
      job.abort.abort(new Error("Codex operator input request cancelled"));
      return;
    }
    jobs.splice(index, 1);
    job.resolve(job.cancelValue);
  };

  const cancelPending = async () => {
    const pendingCompletion = activeCompletion;
    const queuedJobs = jobs.splice(1);
    for (const job of queuedJobs) {
      job.resolve(job.cancelValue);
    }
    jobs[0]?.abort.abort(new Error("Codex operator input request cancelled"));
    await pendingCompletion;
  };

  const execute = (input: StructuredInputCompileResult, timeoutMs: number, signal: AbortSignal) =>
    structuredInput.run({
      input,
      sessionKey: inputSessionKey,
      agentId: params.paramsForRun.agentId,
      runId: params.paramsForRun.runId,
      timeoutMs,
      gatewayCall,
      delivery: params.paramsForRun,
      signal,
      promptOptions: {
        formatText: formatCodexDisplayText,
        unsupportedIntro: "Codex input request could not be shown:",
        urlIntro: "Codex needs confirmation:",
      },
    });

  params.signal?.addEventListener("abort", () => void cancelPending(), { once: true });

  return {
    async handleRequest(request: CodexInputRequest) {
      const requestParams = readUserInputParams(request.params);
      if (
        !requestParams ||
        requestParams.threadId !== params.threadId ||
        requestParams.turnId !== params.turnId
      ) {
        return undefined;
      }
      if (requestParams.questions.length === 0) {
        return emptyUserInputResponse();
      }
      const timeoutMs = requestParams.isBlocking
        ? (params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS)
        : NONBLOCKING_USER_INPUT_TIMEOUT_MS;
      const input = compileUserInputQuestions(requestParams.questions);
      const cancelValue = emptyUserInputResponse();
      return await enqueue({
        requestId: request.id,
        abort: new AbortController(),
        cancelValue,
        failureValue: cancelValue,
        run: async (signal) => {
          const result = await execute(input, timeoutMs, signal);
          return result.status === "answered"
            ? gatewayAnswersToCodexResponse(result.answers)
            : cancelValue;
        },
      });
    },
    async handleElicitationRequest(request: CodexInputRequest) {
      if (readRawOwnString(request.params, "threadId") !== params.threadId) {
        return undefined;
      }
      const requestSnapshot = structuredInput.snapshot(request.params);
      if (requestSnapshot === undefined) {
        const cancelValue = createCodexElicitationResponse("cancel");
        return await enqueue({
          requestId: request.id,
          abort: new AbortController(),
          cancelValue,
          failureValue: declineElicitation("OpenClaw could not handle this elicitation."),
          run: async (signal) => {
            const result = await execute(
              {
                kind: "unsupported",
                message: "OpenClaw declined a malformed or over-limit MCP elicitation request.",
              },
              params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS,
              signal,
            );
            return result.status === "unsupported"
              ? declineElicitation(result.message)
              : cancelValue;
          },
        });
      }
      const { compileCodexOrdinaryElicitation } = await import("./elicitation-input.js");
      const compiled = compileCodexOrdinaryElicitation({
        value: requestSnapshot,
        threadId: params.threadId,
        turnId: params.turnId,
      });
      if (compiled.kind === "ignored") {
        return undefined;
      }
      const cancelValue = createCodexElicitationResponse("cancel");
      const timeoutMs = params.paramsForRun.timeoutMs ?? DEFAULT_USER_INPUT_TIMEOUT_MS;
      return await enqueue({
        requestId: request.id,
        abort: new AbortController(),
        cancelValue,
        failureValue: declineElicitation("OpenClaw could not handle this elicitation."),
        run: async (signal) => {
          const result = await execute(compiled.input, timeoutMs, signal);
          if (result.status === "answered") {
            const content =
              compiled.input.kind === "ready" && compiled.input.plan.kind === "url"
                ? null
                : result.content;
            return createCodexElicitationResponse("accept", content);
          }
          if (result.status === "declined") {
            return declineElicitation(result.message);
          }
          if (result.status === "unsupported") {
            return declineElicitation(result.message);
          }
          return cancelValue;
        },
      });
    },
    handleNotification(notification: CodexServerNotification) {
      if (notification.method !== "serverRequest/resolved" || !isJsonObject(notification.params)) {
        return;
      }
      const requestId = readRequestId(notification.params);
      if (
        requestId === undefined ||
        readOwnString(notification.params, "threadId") !== params.threadId
      ) {
        return;
      }
      const job = jobs.find(
        (candidate) =>
          typeof candidate.requestId === typeof requestId && candidate.requestId === requestId,
      );
      if (job) {
        cancelJob(job);
      }
    },
    cancelPending,
  };
}

function compileUserInputQuestions(
  questions: readonly AgentHarnessUserInputQuestion[],
): StructuredInputCompileResult {
  return structuredInput.compileQuestions({ questions, intro: "Codex needs input:" });
}

function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      questions: AgentHarnessUserInputQuestion[];
      isBlocking: boolean;
    }
  | undefined {
  const snapshot = structuredInput.snapshot(value);
  if (!structuredInput.isRecord(snapshot)) {
    return undefined;
  }
  const threadId = readBoundedUserInputText(snapshot, "threadId", MAX_USER_INPUT_ID);
  const turnId = readBoundedUserInputText(snapshot, "turnId", MAX_USER_INPUT_ID);
  const itemId = readBoundedUserInputText(snapshot, "itemId", MAX_USER_INPUT_ID);
  const questions = readArray(snapshot, "questions", MAX_USER_INPUT_QUESTIONS);
  if (!threadId || !turnId || !itemId || !questions) {
    return undefined;
  }
  const parsed: AgentHarnessUserInputQuestion[] = [];
  for (const questionValue of questions) {
    const question = readQuestion(questionValue);
    if (!question) {
      return undefined;
    }
    parsed.push(question);
  }
  return {
    threadId,
    turnId,
    questions: parsed,
    isBlocking: readValue(snapshot, "isBlocking") !== false,
  };
}

function readQuestion(value: unknown): AgentHarnessUserInputQuestion | undefined {
  if (!structuredInput.isRecord(value)) {
    return undefined;
  }
  const id = readBoundedUserInputText(value, "id", MAX_USER_INPUT_ID);
  const header = readBoundedUserInputText(value, "header", MAX_USER_INPUT_HEADER);
  const question = readBoundedUserInputText(value, "question", MAX_USER_INPUT_TEXT);
  if (!id || !header || !question) {
    return undefined;
  }
  const options = readOptions(readValue(value, "options"));
  if (options === undefined) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    isOther: readValue(value, "isOther") === true,
    isSecret: readValue(value, "isSecret") === true,
    ...(readValue(value, "multiSelect") === true ? { multiSelect: true } : {}),
    options,
  };
}

function readOptions(value: unknown): AgentHarnessUserInputOption[] | null | undefined {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Array.isArray(value) || value.length > MAX_USER_INPUT_OPTIONS) {
    return undefined;
  }
  const options: AgentHarnessUserInputOption[] = [];
  for (const entry of value) {
    if (!structuredInput.isRecord(entry)) {
      return undefined;
    }
    const label = readBoundedUserInputText(entry, "label", MAX_USER_INPUT_ID);
    const description = readBoundedUserInputText(entry, "description", MAX_USER_INPUT_TEXT, true);
    if (!label) {
      return undefined;
    }
    options.push({ label, ...(description ? { description } : {}) });
  }
  return options;
}

function readValue(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function readBoundedUserInputText(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
  allowEmpty = false,
): string | undefined {
  const value = readValue(record, key);
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.length > 0)
    ? value
    : undefined;
}

function readArray(
  record: Record<string, unknown>,
  key: string,
  maximum: number,
): unknown[] | undefined {
  const value = readValue(record, key);
  return Array.isArray(value) && value.length <= maximum ? value : undefined;
}

function readOwnString(record: JsonObject, key: string): string | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function readRawOwnString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "string"
    ? descriptor.value
    : undefined;
}

function readRequestId(record: JsonObject): string | number | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(record, "requestId");
  const value = descriptor && "value" in descriptor ? descriptor.value : undefined;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function gatewayAnswersToCodexResponse(answers: Record<string, string[]>): JsonObject {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    ),
  };
}

function emptyUserInputResponse(): JsonObject {
  return { ...emptyAgentHarnessUserInputAnswers() };
}

function declineElicitation(message?: string) {
  return createCodexElicitationResponse("decline", null, message ? { message } : null);
}
