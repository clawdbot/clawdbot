// Question gateway methods create, inspect, wait for, and resolve transient prompts.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type Question,
  type QuestionRequestParams,
  type QuestionResolveParams,
  validateQuestionGetParams,
  validateQuestionListParams,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../../infra/question-channel-runtime.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
} from "../question-manager.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const DEFAULT_QUESTION_TIMEOUT_MS = 15 * 60 * 1_000;

class QuestionRequestValidationError extends Error {}

function validationError(
  method: string,
  errors: Parameters<typeof formatValidationErrors>[0],
  respond: RespondFn,
): void {
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(errors)}`,
    ),
  );
}

function managerError(error: unknown, respond: RespondFn): boolean {
  if (!(error instanceof QuestionManagerError)) {
    return false;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, error.message, { details: { reason: error.code } }),
  );
  return true;
}

function normalizeQuestions(params: QuestionRequestParams): Question[] {
  const ids = new Set<string>();
  return params.questions.map((question) => {
    if (ids.has(question.id)) {
      throw new QuestionRequestValidationError(`duplicate question id '${question.id}'`);
    }
    ids.add(question.id);
    if (question.options.length === 1) {
      throw new QuestionRequestValidationError(
        `question '${question.id}' must have either no options or 2 to 4 options`,
      );
    }
    if (question.isSecret) {
      throw new QuestionRequestValidationError(
        `question '${question.id}': secret questions are not supported yet`,
      );
    }
    const optionLabels = new Set<string>();
    for (const option of question.options) {
      const normalizedLabel = option.label.trim().toLowerCase();
      if (optionLabels.has(normalizedLabel)) {
        throw new QuestionRequestValidationError(
          `question '${question.id}' has duplicate option label '${option.label}'`,
        );
      }
      optionLabels.add(normalizedLabel);
    }
    return {
      ...question,
      header: truncateUtf16Safe(question.header, 12),
    };
  });
}

/** Creates the lazily loaded question RPC surface for one Gateway lifetime. */
export function createQuestionHandlers(manager: QuestionManager): GatewayRequestHandlers {
  return {
    "question.request": ({ params, respond, context }) => {
      if (!validateQuestionRequestParams(params)) {
        validationError("question.request", validateQuestionRequestParams.errors, respond);
        return;
      }
      const request = params as QuestionRequestParams;
      try {
        const record = manager.request({
          ...(request.id ? { id: request.id } : {}),
          questions: normalizeQuestions(request),
          ...(request.agentId ? { agentId: request.agentId } : {}),
          ...(request.sessionKey ? { sessionKey: request.sessionKey } : {}),
          timeoutMs: request.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
          onResolved: (event) => {
            handleQuestionChannelResolved(event);
            context.broadcast("question.resolved", event);
          },
        });
        handleQuestionChannelRequested(record);
        context.broadcast("question.requested", record);
        respond(true, { id: record.id, expiresAtMs: record.expiresAtMs }, undefined);
      } catch (error) {
        if (error instanceof QuestionRequestValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.waitAnswer": async ({ params, respond }) => {
      if (!validateQuestionWaitAnswerParams(params)) {
        validationError("question.waitAnswer", validateQuestionWaitAnswerParams.errors, respond);
        return;
      }
      const request = params as { id: string; timeoutMs?: number };
      try {
        respond(true, await manager.waitAnswer(request.id, request.timeoutMs), undefined);
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.resolve": ({ params, respond }) => {
      if (!validateQuestionResolveParams(params)) {
        validationError("question.resolve", validateQuestionResolveParams.errors, respond);
        return;
      }
      const request = params as QuestionResolveParams;
      try {
        const result =
          "cancel" in request
            ? manager.cancel(request.id, request.resolvedBy)
            : manager.resolve(request.id, request.answers, request.resolvedBy);
        respond(true, result, undefined);
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.get": ({ params, respond }) => {
      if (!validateQuestionGetParams(params)) {
        validationError("question.get", validateQuestionGetParams.errors, respond);
        return;
      }
      const id = (params as { id: string }).id;
      const question = manager.get(id);
      if (!question) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `question '${id}' was not found`, {
            details: { reason: QuestionManagerErrorCodes.NOT_FOUND },
          }),
        );
        return;
      }
      respond(true, { question }, undefined);
    },
    "question.list": ({ params, respond }) => {
      if (!validateQuestionListParams(params)) {
        validationError("question.list", validateQuestionListParams.errors, respond);
        return;
      }
      respond(true, { questions: manager.list() }, undefined);
    },
  };
}
