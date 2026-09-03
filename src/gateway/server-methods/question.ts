// Question gateway methods create, inspect, wait for, and resolve transient prompts.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type Question,
  type QuestionRecord,
  type QuestionRequestParams,
  type QuestionResolveParams,
  validateQuestionGetParams,
  validateQuestionListParams,
  validateQuestionRequestParams,
  validateQuestionResolveParams,
  validateQuestionWaitAnswerParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { registerActiveEmbeddedRunHumanInputWait } from "../../agents/embedded-agent-runner/run-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ENV_SECRET_REF_ID_RE } from "../../config/types.secrets.js";
import {
  handleQuestionChannelRequested,
  handleQuestionChannelResolved,
} from "../../infra/question-channel-runtime.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  listSecretStoreEntries,
  SECRET_STORE_ALLOWED_HOSTS_MAX,
  SecretStoreValidationError,
} from "../../secrets/store/secret-store.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import {
  QuestionManager,
  QuestionManagerError,
  QuestionManagerErrorCodes,
} from "../question-manager.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeSessionSharing,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { SecretStoreWriteService } from "./secrets.js";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";

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

function questionNotFound(id: string) {
  return errorShape(ErrorCodes.INVALID_REQUEST, `question '${id}' was not found`, {
    details: { reason: QuestionManagerErrorCodes.NOT_FOUND },
  });
}

function authorizeQuestionRecord(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  question: QuestionRecord;
  access: "read" | "mutate";
}): ReturnType<typeof errorShape> | null {
  if (
    isGatewayAdmin(params.client) ||
    !hasOperatorBoundary(params.client, params.cfg) ||
    !params.question.sessionKey
  ) {
    return null;
  }
  const target = resolveSessionSharingTarget({
    cfg: params.cfg,
    sessionKey: params.question.sessionKey,
    agentId: params.question.agentId,
  });
  const canSeeSession =
    target &&
    (createSessionListEntryFilter({ cfg: params.cfg, client: params.client })?.(
      target.canonicalKey,
      target.entry,
    ) ??
      true);
  if (!target || !canSeeSession) {
    return questionNotFound(params.question.id);
  }
  return params.access === "mutate"
    ? authorizeSessionSharingTarget({ cfg: params.cfg, client: params.client, target })
    : null;
}

function normalizeQuestions(params: QuestionRequestParams): Question[] {
  const ids = new Set<string>();
  return params.questions.map((question) => {
    if (ids.has(question.questionId)) {
      throw new QuestionRequestValidationError(`duplicate question id '${question.questionId}'`);
    }
    ids.add(question.questionId);
    if (question.options.length === 1) {
      throw new QuestionRequestValidationError(
        `question '${question.questionId}' must have either no options or 2 to 4 options`,
      );
    }
    const binding = question.secretStore;
    if (question.isSecret && !binding) {
      throw new QuestionRequestValidationError(
        `question '${question.questionId}': secret questions are not supported yet`,
      );
    }
    if (binding) {
      if (!question.isSecret) {
        throw new QuestionRequestValidationError(
          `question '${question.questionId}': secret store binding requires a secret question`,
        );
      }
      if (params.questions.length !== 1 || question.options.length !== 0 || question.multiSelect) {
        throw new QuestionRequestValidationError(
          `question '${question.questionId}': secret store requests require one free-text, single-select question`,
        );
      }
      if (!ENV_SECRET_REF_ID_RE.test(binding.name)) {
        throw new QuestionRequestValidationError(
          `question '${question.questionId}': invalid secret store entry name`,
        );
      }
      if (binding.kind !== "secret") {
        throw new QuestionRequestValidationError(
          `question '${question.questionId}': masked requests require kind "secret"; set environment values in Settings or the CLI`,
        );
      }
      if ((binding.allowedHosts?.length ?? 0) > SECRET_STORE_ALLOWED_HOSTS_MAX) {
        throw new QuestionRequestValidationError(
          `question '${question.questionId}': secret store allowed hosts exceed the limit`,
        );
      }
      const existing = listSecretStoreEntries({ scope: { kind: "team" } }).find(
        (entry) => entry.name === binding.name,
      );
      return {
        ...question,
        // Save the policy shown for consent, never inherit unseen hosts at submission.
        secretStore: {
          ...binding,
          allowedHosts: binding.allowedHosts ?? existing?.allowedHosts ?? [],
        },
        ...(existing
          ? {
              secretStoreExisting: {
                updatedAtMs: existing.updatedAtMs,
                ...(existing.updatedBy ? { updatedBy: existing.updatedBy } : {}),
              },
            }
          : {}),
      };
    }
    const optionLabels = new Set<string>();
    for (const option of question.options) {
      const normalizedLabel = option.label.trim().toLowerCase();
      if (optionLabels.has(normalizedLabel)) {
        throw new QuestionRequestValidationError(
          `question '${question.questionId}' has duplicate option label '${option.label}'`,
        );
      }
      optionLabels.add(normalizedLabel);
    }
    return question;
  });
}

/** Creates the lazily loaded question RPC surface for one Gateway lifetime. */
export function createQuestionHandlers(
  manager: QuestionManager,
  storeWriteService: SecretStoreWriteService,
): GatewayRequestHandlers {
  return {
    "question.request": ({ params, respond, context, client }) => {
      if (!validateQuestionRequestParams(params)) {
        validationError("question.request", validateQuestionRequestParams.errors, respond);
        return;
      }
      let request = params as QuestionRequestParams;
      const storeBound = request.questions.some((question) => question.secretStore);
      // Store-bound questions end in a secret-store write on resolve. Without
      // this gate any operator.questions client could mint and self-answer one,
      // bypassing the operator.admin requirement on secrets.store.set.
      if (storeBound && !isGatewayAdmin(client)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "secret store questions require an operator.admin client",
          ),
        );
        return;
      }
      const identity = client?.internal?.agentRuntimeIdentity;
      const validateAuthority = context.validateAgentRuntimeApprovalAuthority;
      if (storeBound && (!identity || !validateAuthority)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "secret store questions require trusted agent runtime authority",
          ),
        );
        return;
      }
      // Capture the admitted identity privately, not the caller's correlation fields.
      // Revalidate this exact claim even if another execution reuses its runId.
      const requester = identity ? structuredClone(identity) : undefined;
      const isRequesterActive =
        requester && validateAuthority
          ? () => {
              try {
                return validateAuthority(requester);
              } catch {
                return false;
              }
            }
          : undefined;
      if (requester) {
        request = {
          ...request,
          agentId: requester.agentId,
          sessionKey: requester.sessionKey,
          runId: requester.operationalRunInstance.runId,
        };
      }
      try {
        const requestedSession = request.sessionKey
          ? resolveRequestedSessionAgentId(
              context.getRuntimeConfig(),
              request.sessionKey,
              request.agentId,
            )
          : undefined;
        if (requestedSession && !requestedSession.ok) {
          respond(false, undefined, requestedSession.error);
          return;
        }
        const sessionKey =
          request.sessionKey && requestedSession?.ok
            ? resolveStoredSessionKeyForAgentStore({
                cfg: context.getRuntimeConfig(),
                agentId: requestedSession.agentId,
                sessionKey: request.sessionKey,
              })
            : undefined;
        if (sessionKey && hasOperatorBoundary(client, context.getRuntimeConfig())) {
          const authorizationError = authorizeSessionSharing({
            cfg: context.getRuntimeConfig(),
            client,
            sessionKey,
            agentId: requestedSession?.ok ? requestedSession.agentId : undefined,
          });
          if (authorizationError) {
            respond(false, undefined, authorizationError);
            return;
          }
        }
        const record = manager.request({
          ...(request.id ? { id: request.id } : {}),
          questions: normalizeQuestions(request),
          ...(requestedSession?.ok
            ? { agentId: requestedSession.agentId }
            : request.agentId
              ? { agentId: request.agentId }
              : {}),
          ...(sessionKey ? { sessionKey } : {}),
          ...(request.runId ? { runId: request.runId } : {}),
          timeoutMs: request.timeoutMs ?? DEFAULT_QUESTION_TIMEOUT_MS,
          isRequesterActive,
          registerHumanInputWait:
            requester && isRequesterActive
              ? (isPending) =>
                  registerActiveEmbeddedRunHumanInputWait(requester.delegatedAuthority, isPending)
              : undefined,
          onResolved: (event) => {
            handleQuestionChannelResolved(event);
            if (sessionKey && context.getRuntimeConfig().gateway?.roles) {
              context.broadcast("question.resolved", event, {
                sessionKeys: [sessionKey],
                ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
              });
            } else {
              context.broadcast("question.resolved", event);
            }
          },
        });
        handleQuestionChannelRequested(record);
        if (sessionKey && context.getRuntimeConfig().gateway?.roles) {
          context.broadcast("question.requested", record, {
            sessionKeys: [sessionKey],
            ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
          });
        } else {
          context.broadcast("question.requested", record);
        }
        respond(true, { id: record.id, expiresAtMs: record.expiresAtMs }, undefined);
      } catch (error) {
        if (error instanceof QuestionRequestValidationError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return;
        }
        if (!managerError(error, respond)) {
          if (storeBound) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "Secret store entry metadata is unavailable."),
            );
            return;
          }
          throw error;
        }
      }
    },
    "question.waitAnswer": async ({ params, respond, client, context }) => {
      if (!validateQuestionWaitAnswerParams(params)) {
        validationError("question.waitAnswer", validateQuestionWaitAnswerParams.errors, respond);
        return;
      }
      const request = params as { id: string; timeoutMs?: number };
      try {
        const question = manager.get(request.id);
        if (question) {
          const authorizationError = authorizeQuestionRecord({
            cfg: context.getRuntimeConfig(),
            client,
            question,
            access: "read",
          });
          if (authorizationError) {
            respond(false, undefined, authorizationError);
            return;
          }
        }
        const answer = await manager.waitAnswer(request.id, request.timeoutMs);
        const resolvedQuestion = manager.get(request.id);
        if (resolvedQuestion) {
          const authorizationError = authorizeQuestionRecord({
            cfg: context.getRuntimeConfig(),
            client,
            question: resolvedQuestion,
            access: "read",
          });
          if (authorizationError) {
            respond(false, undefined, authorizationError);
            return;
          }
        }
        respond(true, answer, undefined);
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.resolve": async ({ params, respond, client, context }) => {
      if (!validateQuestionResolveParams(params)) {
        validationError("question.resolve", validateQuestionResolveParams.errors, respond);
        return;
      }
      const request = params as QuestionResolveParams;
      try {
        const question = manager.get(request.id);
        if (question) {
          const authorizationError = authorizeQuestionRecord({
            cfg: context.getRuntimeConfig(),
            client,
            question,
            access: "mutate",
          });
          if (authorizationError) {
            respond(false, undefined, authorizationError);
            return;
          }
        }
        if ("cancel" in request) {
          respond(true, manager.cancel(request.id, request.resolvedBy), undefined);
          return;
        }
        const secretQuestion = question?.questions[0];
        const binding = secretQuestion?.secretStore;
        if (!binding || !question) {
          if (request.secretStoreAllowedHosts !== undefined) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "Secret store allowed hosts require a store-bound question.",
              ),
            );
            return;
          }
          respond(
            true,
            manager.resolve(request.id, request.answers, request.resolvedBy),
            undefined,
          );
          return;
        }
        const submittedAnswers = request.answers.answers;
        const values = Object.hasOwn(submittedAnswers, secretQuestion.questionId)
          ? submittedAnswers[secretQuestion.questionId]
          : undefined;
        const value = values?.[0];
        if (
          Object.keys(submittedAnswers).length !== 1 ||
          values?.length !== 1 ||
          value === undefined
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `question '${secretQuestion.questionId}' requires exactly one secret value`,
            ),
          );
          return;
        }
        registerSecretValueForRedaction(value);
        const allowedHosts = request.secretStoreAllowedHosts ?? binding.allowedHosts;
        let saved = false;
        try {
          // Only the synthetic marker enters state, fanout, and waiting agents.
          // The manager validates liveness and settles before refresh can yield.
          const result = manager.resolve(
            request.id,
            { answers: { [secretQuestion.questionId]: ["stored"] } },
            request.resolvedBy,
            () => {
              storeWriteService.write({
                name: binding.name,
                value,
                kind: "secret",
                ...(allowedHosts !== undefined ? { allowedHosts } : {}),
                updatedBy: storeWriteService.resolveUpdatedBy(client),
              });
              saved = true;
            },
          );
          await storeWriteService.reloadReference(binding.name);
          respond(true, result, undefined);
        } catch (error) {
          if (managerError(error, respond)) {
            return;
          }
          respond(
            false,
            undefined,
            errorShape(
              !saved && error instanceof SecretStoreValidationError
                ? ErrorCodes.INVALID_REQUEST
                : ErrorCodes.UNAVAILABLE,
              saved
                ? "Secret store entry was saved, but runtime refresh failed. Resolve provider errors and retry secrets.reload; do not resubmit this answer."
                : error instanceof SecretStoreValidationError
                  ? error.message
                  : "Secret store entry could not be saved.",
            ),
          );
        }
      } catch (error) {
        if (!managerError(error, respond)) {
          throw error;
        }
      }
    },
    "question.get": ({ params, respond, client, context }) => {
      if (!validateQuestionGetParams(params)) {
        validationError("question.get", validateQuestionGetParams.errors, respond);
        return;
      }
      const id = (params as { id: string }).id;
      const question = manager.get(id);
      if (!question) {
        respond(false, undefined, questionNotFound(id));
        return;
      }
      const authorizationError = authorizeQuestionRecord({
        cfg: context.getRuntimeConfig(),
        client,
        question,
        access: "read",
      });
      if (authorizationError) {
        respond(false, undefined, authorizationError);
        return;
      }
      respond(true, { question }, undefined);
    },
    "question.list": ({ params, respond, client, context }) => {
      if (!validateQuestionListParams(params)) {
        validationError("question.list", validateQuestionListParams.errors, respond);
        return;
      }
      const cfg = context.getRuntimeConfig();
      const questions = manager
        .list()
        .filter((question) => !authorizeQuestionRecord({ cfg, client, question, access: "read" }));
      respond(true, { questions }, undefined);
    },
  };
}
