/**
 * Bridges Codex item/tool user-input requests to OpenClaw messaging prompts and
 * turns replies into app-server answer payloads.
 */
import {
  buildAgentHarnessUserInputAnswers,
  deliverAgentHarnessUserInputPrompt,
  embeddedAgentLog,
  emptyAgentHarnessUserInputAnswers,
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

type PendingUserInput = {
  requestId: number | string;
  threadId: string;
  turnId: string;
  itemId: string;
  questions: AgentHarnessUserInputQuestion[];
  claimed: boolean;
  resolve: (value: JsonValue) => void;
  cleanup: () => void;
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
  handleQueuedMessage: (text: string) => boolean;
  handleNotification: (notification: CodexServerNotification) => void;
  cancelPending: () => void;
};

/** Creates a per-turn bridge for pending Codex user-input requests. */
export function createCodexUserInputBridge(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): CodexUserInputBridge {
  let pending: PendingUserInput | undefined;

  const resolvePending = (value: JsonValue) => {
    const current = pending;
    if (!current) {
      return;
    }
    pending = undefined;
    current.cleanup();
    current.resolve(value);
  };

  const resolvePendingIfCurrent = (current: PendingUserInput, value: JsonValue): boolean => {
    if (pending !== current) {
      return false;
    }
    resolvePending(value);
    return true;
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

      resolvePending(emptyUserInputResponse());

      return new Promise<JsonValue>((resolve) => {
        const abortListener = () => resolvePending(emptyUserInputResponse());
        const cleanup = () => params.signal?.removeEventListener("abort", abortListener);
        pending = {
          requestId: request.id,
          threadId: requestParams.threadId,
          turnId: requestParams.turnId,
          itemId: requestParams.itemId,
          questions: requestParams.questions,
          claimed: false,
          resolve,
          cleanup,
        };
        params.signal?.addEventListener("abort", abortListener, { once: true });
        if (params.signal?.aborted) {
          resolvePending(emptyUserInputResponse());
          return;
        }
        void deliverUserInputPrompt(params.paramsForRun, requestParams.questions).catch(
          (error: unknown) => {
            embeddedAgentLog.warn("failed to deliver codex user input prompt", { error });
          },
        );
      });
    },
    claimPendingRequest() {
      const current = pending;
      if (!current || current.claimed) {
        return undefined;
      }
      current.claimed = true;
      return {
        answer: (text) =>
          resolvePendingIfCurrent(current, buildUserInputResponse(current.questions, text)),
        cancel: () => resolvePendingIfCurrent(current, emptyUserInputResponse()),
      };
    },
    handleQueuedMessage(text) {
      const current = pending;
      if (!current || current.claimed) {
        return false;
      }
      resolvePending(buildUserInputResponse(current.questions, text));
      return true;
    },
    handleNotification(notification) {
      if (notification.method !== "serverRequest/resolved" || !pending) {
        return;
      }
      const notificationParams = isJsonObject(notification.params)
        ? notification.params
        : undefined;
      const requestId = notificationParams ? readRequestId(notificationParams) : undefined;
      if (
        notificationParams &&
        readString(notificationParams, "threadId") === pending.threadId &&
        requestId !== undefined &&
        String(requestId) === String(pending.requestId)
      ) {
        resolvePending(emptyUserInputResponse());
      }
    },
    cancelPending() {
      resolvePending(emptyUserInputResponse());
    },
  };
}

function readUserInputParams(value: JsonValue | undefined):
  | {
      threadId: string;
      turnId: string;
      itemId: string;
      questions: AgentHarnessUserInputQuestion[];
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
    .map(readQuestion)
    .filter((question): question is AgentHarnessUserInputQuestion => Boolean(question));
  return { threadId, turnId, itemId, questions };
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

async function deliverUserInputPrompt(
  params: EmbeddedRunAttemptParams,
  questions: AgentHarnessUserInputQuestion[],
): Promise<void> {
  await deliverAgentHarnessUserInputPrompt(params, questions, {
    formatText: formatCodexDisplayText,
    intro: "Codex needs input:",
  });
}

function buildUserInputResponse(
  questions: AgentHarnessUserInputQuestion[],
  inputText: string,
): JsonObject {
  // Multi-question replies may use "header: answer" or numbered lines. Keep the
  // parser permissive so chat-channel replies remain ergonomic.
  return buildAgentHarnessUserInputAnswers(questions, inputText) as unknown as JsonObject;
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
