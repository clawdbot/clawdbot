/** Bridges Codex request_user_input calls to gateway questions and secret text prompts. */
import {
  buildAgentHarnessUserInputAnswers,
  callGatewayTool,
  deliverAgentHarnessUserInputPrompt,
  embeddedAgentLog,
  emptyAgentHarnessUserInputAnswers,
  runAgentHarnessGatewayQuestion,
  type AgentHarnessQuestionGatewayCall,
  type AgentHarnessUserInputOption,
  type AgentHarnessUserInputQuestion,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import {
  isJsonObject,
  type CodexServerNotification,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";

const DEFAULT_USER_INPUT_TIMEOUT_MS = 15 * 60_000;

type PendingSecretUserInput = {
  requestId: number | string;
  threadId: string;
  questions: AgentHarnessUserInputQuestion[];
  claimed: boolean;
  resolve: (value: JsonValue) => void;
  cleanup: () => void;
};

type PendingGatewayUserInput = {
  requestId: number | string;
  threadId: string;
  abort: AbortController;
};

type CodexUserInputBridge = {
  handleRequest: (request: {
    id: number | string;
    params?: JsonValue;
  }) => Promise<JsonValue | undefined>;
  claimPendingRequest: () =>
    | {
        answer: (text: string) => boolean;
        cancel: () => boolean;
      }
    | undefined;
  handleNotification: (notification: CodexServerNotification) => void;
  cancelPending: () => void;
};

/** Creates a per-turn bridge for pending Codex user-input requests. */
export function createCodexUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
  gatewayCall?: AgentHarnessQuestionGatewayCall;
}): CodexUserInputBridge {
  let sensitiveInput: PendingSecretUserInput | undefined;
  let pendingGateway: PendingGatewayUserInput | undefined;
  const gatewayCall = params.gatewayCall ?? callGatewayTool;

  const resolveSecret = (value: JsonValue) => {
    const current = sensitiveInput;
    if (!current) {
      return;
    }
    sensitiveInput = undefined;
    current.cleanup();
    current.resolve(value);
  };

  const resolveSecretIfCurrent = (current: PendingSecretUserInput, value: JsonValue): boolean => {
    if (sensitiveInput !== current) {
      return false;
    }
    resolveSecret(value);
    return true;
  };

  const cancelGateway = () => {
    pendingGateway?.abort.abort(new Error("Codex user input request cancelled"));
  };

  return {
    async handleRequest(request) {
      const requestParams = readUserInputParams(request.params);
      if (!requestParams) {
        return undefined;
      }
      if (requestParams.threadId !== params.threadId || requestParams.turnId !== params.turnId) {
        return undefined;
      }
      if (requestParams.questions.length === 0) {
        return emptyUserInputResponse();
      }

      resolveSecret(emptyUserInputResponse());
      cancelGateway();

      if (requestParams.questions.some((question) => question.isSecret)) {
        return new Promise<JsonValue>((resolve) => {
          const abortListener = () => resolveSecret(emptyUserInputResponse());
          const cleanup = () => params.signal?.removeEventListener("abort", abortListener);
          const current: PendingSecretUserInput = {
            requestId: request.id,
            threadId: requestParams.threadId,
            questions: requestParams.questions,
            claimed: false,
            resolve,
            cleanup,
          };
          sensitiveInput = current;
          params.signal?.addEventListener("abort", abortListener, { once: true });
          if (params.signal?.aborted) {
            resolveSecret(emptyUserInputResponse());
            return;
          }
          void deliverAgentHarnessUserInputPrompt(params.paramsForRun, requestParams.questions, {
            formatText: formatCodexDisplayText,
            intro: "Codex needs input:",
          }).catch((error: unknown) => {
            embeddedAgentLog.warn("failed to deliver secret codex user input prompt", { error });
          });
        });
      }

      const abort = new AbortController();
      const abortFromRun = () => abort.abort(params.signal?.reason);
      params.signal?.addEventListener("abort", abortFromRun, { once: true });
      if (params.signal?.aborted) {
        abortFromRun();
      }
      pendingGateway = { requestId: request.id, threadId: requestParams.threadId, abort };
      try {
        const result = await runAgentHarnessGatewayQuestion({
          questions: requestParams.questions,
          sessionKey: params.paramsForRun.sessionKey ?? params.paramsForRun.sessionId,
          agentId: params.paramsForRun.agentId,
          timeoutMs:
            requestParams.autoResolutionMs ??
            params.paramsForRun.timeoutMs ??
            DEFAULT_USER_INPUT_TIMEOUT_MS,
          gatewayCall,
          delivery: params.paramsForRun,
          promptOptions: {
            formatText: formatCodexDisplayText,
            intro: "Codex needs input:",
          },
          signal: abort.signal,
        });
        return result.status === "answered"
          ? gatewayAnswersToCodexResponse(result.answers.answers)
          : emptyUserInputResponse();
      } catch (error) {
        embeddedAgentLog.warn("failed to bridge codex user input through gateway", { error });
        return emptyUserInputResponse();
      } finally {
        params.signal?.removeEventListener("abort", abortFromRun);
        if (pendingGateway?.abort === abort) {
          pendingGateway = undefined;
        }
      }
    },
    claimPendingRequest() {
      const current = sensitiveInput;
      if (!current || current.claimed) {
        return undefined;
      }
      current.claimed = true;
      return {
        answer: (text) =>
          resolveSecretIfCurrent(current, buildUserInputResponse(current.questions, text)),
        cancel: () => resolveSecretIfCurrent(current, emptyUserInputResponse()),
      };
    },
    handleNotification(notification) {
      if (notification.method !== "serverRequest/resolved") {
        return;
      }
      const notificationParams = isJsonObject(notification.params)
        ? notification.params
        : undefined;
      const requestId = notificationParams ? readRequestId(notificationParams) : undefined;
      if (!notificationParams || requestId === undefined) {
        return;
      }
      if (
        sensitiveInput &&
        readString(notificationParams, "threadId") === sensitiveInput.threadId &&
        String(requestId) === String(sensitiveInput.requestId)
      ) {
        resolveSecret(emptyUserInputResponse());
      }
      if (
        pendingGateway &&
        readString(notificationParams, "threadId") === pendingGateway.threadId &&
        String(requestId) === String(pendingGateway.requestId)
      ) {
        pendingGateway.abort.abort(new Error("Codex server request resolved"));
      }
    },
    cancelPending() {
      resolveSecret(emptyUserInputResponse());
      cancelGateway();
    },
  };
}

function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: AgentHarnessUserInputQuestion[];
      autoResolutionMs?: number;
    }
  | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const threadId = readString(value, "threadId");
  const turnId = readString(value, "turnId");
  const itemId = readString(value, "itemId");
  const questionsRaw = value.questions;
  if (!threadId || !turnId || !itemId || !Array.isArray(questionsRaw)) {
    return undefined;
  }
  const questions = questionsRaw
    .map((rawQuestion) => {
      const question = readQuestion(rawQuestion);
      if (question && isJsonObject(rawQuestion) && rawQuestion.multiSelect === true) {
        question.multiSelect = true;
      }
      return question;
    })
    .filter((question): question is AgentHarnessUserInputQuestion => Boolean(question));
  const autoResolutionMs =
    typeof value.autoResolutionMs === "number" && value.autoResolutionMs > 0
      ? value.autoResolutionMs
      : undefined;
  return { threadId, turnId, itemId, questions, autoResolutionMs };
}

function readQuestion(value: JsonValue): AgentHarnessUserInputQuestion | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const id = readString(value, "id");
  const header = readString(value, "header");
  const question = readString(value, "question");
  if (!id || !header || !question) {
    return undefined;
  }
  return {
    id,
    header,
    question,
    isOther: value.isOther === true,
    isSecret: value.isSecret === true,
    options: readOptions(value.options),
  };
}

function readOptions(value: JsonValue | undefined): AgentHarnessUserInputOption[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const options = value
    .map(readOption)
    .filter((option): option is AgentHarnessUserInputOption => Boolean(option));
  return options.length > 0 ? options : null;
}

function readOption(value: JsonValue): AgentHarnessUserInputOption | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const label = readString(value, "label");
  const description = readString(value, "description") ?? "";
  return label ? { label, description } : undefined;
}

function buildUserInputResponse(
  questions: AgentHarnessUserInputQuestion[],
  inputText: string,
): JsonObject {
  return buildAgentHarnessUserInputAnswers(questions, inputText) as unknown as JsonObject;
}

function gatewayAnswersToCodexResponse(answers: Record<string, string[]>): JsonObject {
  return {
    answers: Object.fromEntries(
      Object.entries(answers).map(([questionId, values]) => [questionId, { answers: values }]),
    ),
  };
}

function emptyUserInputResponse(): JsonObject {
  return emptyAgentHarnessUserInputAnswers() as unknown as JsonObject;
}

function readString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readRequestId(record: JsonObject): string | number | undefined {
  const value = record.requestId;
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}
