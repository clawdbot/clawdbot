import type { reduceSessionProjection } from "../browser.js";
import type { ConversationInteractionStore } from "./conversation-interactions.js";
import type {
  ControlModelConversationHost,
  ControlModelSendInput,
  ControlModelSendResult,
} from "./conversation-types.js";
import {
  cloneAndFreeze,
  localError,
  normalizeGatewayError,
  normalizeStatus,
  record,
  text,
} from "./conversation-utils.js";
import type { ControlModelRequestOptions } from "./model.js";

type ProjectionEvent = Parameters<typeof reduceSessionProjection>[1];

type ConversationCommandControllerOptions = {
  host: ControlModelConversationHost;
  sessionKey: string;
  interactions: ConversationInteractionStore;
  assertCommandReady(command: string): void;
  captureEpoch(command: string): number;
  assertEpoch(epoch: number, command: string): void;
  activeRunId(): string | null;
  applyProjection(event: ProjectionEvent): void;
};

export class ConversationCommandController {
  readonly #options: ConversationCommandControllerOptions;
  #activeOperations = 0;

  constructor(options: ConversationCommandControllerOptions) {
    this.#options = options;
  }

  get hasActiveOperations(): boolean {
    return this.#activeOperations > 0;
  }

  async send(
    input: ControlModelSendInput,
    options?: ControlModelRequestOptions,
  ): Promise<ControlModelSendResult> {
    this.#options.assertCommandReady("chat.send");
    const normalized = normalizeSendInput(input);
    const idempotencyKey =
      text(normalized.idempotencyKey) ??
      text(this.#options.host.generateId("send")) ??
      this.#options.host.generateId("send");
    const message = {
      role: "user",
      content: normalized.message,
      ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
      __openclaw: { idempotencyKey },
    };
    this.#options.applyProjection({
      type: "sendPending",
      message,
      idempotencyKey,
      scope: { sessionKey: this.#options.sessionKey },
    });
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#options.captureEpoch("chat.send");
      const response = await this.#options.host.gateway.request<Record<string, unknown>>(
        "chat.send",
        {
          sessionKey: this.#options.sessionKey,
          ...(this.#options.host.agentId ? { agentId: this.#options.host.agentId } : {}),
          message: normalized.message,
          deliver: false,
          idempotencyKey,
          ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
          ...sendOptions(normalized),
        },
        options,
      );
      this.#options.assertEpoch(epoch, "chat.send");
      const runId = text(response?.runId) ?? null;
      this.#options.applyProjection({
        type: "sendAcknowledged",
        idempotencyKey: runId ?? idempotencyKey,
        previousRunId: idempotencyKey,
        scope: { sessionKey: this.#options.sessionKey },
      });
      return Object.freeze({ runId, status: text(response?.status) ?? "accepted", idempotencyKey });
    } catch (error) {
      const commandError = this.#asCommandErrorForEpoch(error, "chat.send", epoch);
      if (commandError.category !== "stale") {
        this.#options.applyProjection({
          type: "sendFailed",
          runId: idempotencyKey,
          scope: { sessionKey: this.#options.sessionKey },
        });
      }
      throw commandError;
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async abort(
    runId?: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#options.assertCommandReady("chat.abort");
    const target = text(runId) ?? this.#options.activeRunId();
    if (!target) {
      throw localError("conflict", "chat.abort", "No active run is available", "NO_ACTIVE_RUN");
    }
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#options.captureEpoch("chat.abort");
      const result = await this.#options.host.gateway.request<Record<string, unknown>>(
        "chat.abort",
        {
          sessionKey: this.#options.sessionKey,
          ...(this.#options.host.agentId ? { agentId: this.#options.host.agentId } : {}),
          runId: target,
        },
        options,
      );
      this.#options.assertEpoch(epoch, "chat.abort");
      const abortedRunIds = Array.isArray(result?.runIds)
        ? result.runIds.filter((value): value is string => typeof value === "string")
        : [];
      if (result?.aborted === true || abortedRunIds.includes(target)) {
        this.#options.applyProjection({
          type: "runTerminal",
          runId: target,
          status: "aborted",
          scope: { sessionKey: this.#options.sessionKey },
        });
      }
      return cloneAndFreeze(result ?? { runId: target, status: "aborted" });
    } catch (error) {
      throw this.#asCommandErrorForEpoch(error, "chat.abort", epoch);
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async resolveApproval(
    id: string,
    decision: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#options.assertCommandReady("approval.resolve");
    const approvalId = text(id);
    const requestedDecision = text(decision);
    if (!approvalId || !requestedDecision) {
      throw localError(
        "invalid-input",
        "approval.resolve",
        "Approval id and decision are required",
        "INVALID_APPROVAL_INPUT",
      );
    }
    const approval = this.#options.interactions.getApproval(approvalId);
    if (!approval) {
      throw localError(
        "not-found",
        "approval.resolve",
        "Approval was not found",
        "APPROVAL_NOT_FOUND",
      );
    }
    if (normalizeStatus(approval.status) !== "pending") {
      throw localError(
        "conflict",
        "approval.resolve",
        "Approval is no longer pending",
        "APPROVAL_ALREADY_RESOLVED",
      );
    }
    const presentation = record(approval.presentation);
    const allowed = Array.isArray(presentation?.allowedDecisions)
      ? presentation.allowedDecisions
      : [];
    if (!allowed.includes(requestedDecision)) {
      throw localError("forbidden", "approval.resolve", "Decision is not allowed", "FORBIDDEN");
    }
    const kind = text(presentation?.kind);
    if (!kind) {
      throw localError(
        "malformed",
        "approval.resolve",
        "Approval presentation is malformed",
        "MALFORMED_APPROVAL",
      );
    }
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#options.captureEpoch("approval.resolve");
      const result = await this.#options.host.gateway.request<Record<string, unknown>>(
        "approval.resolve",
        { id: approvalId, kind, decision: requestedDecision },
        options,
      );
      this.#options.assertEpoch(epoch, "approval.resolve");
      if (record(result)?.approval) {
        this.#options.interactions.upsertApproval(record(result)?.approval);
      } else {
        this.#options.interactions.upsertApproval({
          ...approval,
          status: requestedDecision === "deny" ? "denied" : "allowed",
          decision: requestedDecision,
        });
      }
      return cloneAndFreeze(result ?? { applied: true });
    } catch (error) {
      throw this.#asCommandErrorForEpoch(error, "approval.resolve", epoch);
    } finally {
      this.#activeOperations -= 1;
    }
  }

  answerQuestion(
    id: string,
    answers: Readonly<Record<string, readonly string[]>>,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#resolveQuestion(id, { answers: { answers } }, options);
  }

  cancelQuestion(
    id: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#resolveQuestion(id, { cancel: true }, options);
  }

  async #resolveQuestion(
    id: string,
    body: Record<string, unknown>,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#options.assertCommandReady("question.resolve");
    const questionId = text(id);
    if (!questionId) {
      throw localError(
        "invalid-input",
        "question.resolve",
        "Question id is required",
        "INVALID_QUESTION_INPUT",
      );
    }
    const question = this.#options.interactions.getQuestion(questionId);
    if (!question) {
      throw localError(
        "not-found",
        "question.resolve",
        "Question was not found",
        "QUESTION_NOT_FOUND",
      );
    }
    if (normalizeStatus(question.status) !== "pending") {
      throw localError(
        "conflict",
        "question.resolve",
        "Question is no longer pending",
        "QUESTION_ALREADY_RESOLVED",
      );
    }
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#options.captureEpoch("question.resolve");
      const result = await this.#options.host.gateway.request<Record<string, unknown>>(
        "question.resolve",
        { id: questionId, ...body },
        options,
      );
      this.#options.assertEpoch(epoch, "question.resolve");
      const status = text(result?.status) ?? ("cancel" in body ? "cancelled" : "answered");
      this.#options.interactions.upsertQuestion({ ...question, ...result, status });
      return cloneAndFreeze(result ?? { status });
    } catch (error) {
      throw this.#asCommandErrorForEpoch(error, "question.resolve", epoch);
    } finally {
      this.#activeOperations -= 1;
    }
  }

  #asCommandErrorForEpoch(error: unknown, command: string, epoch: number | null) {
    if (epoch !== null) {
      this.#options.assertEpoch(epoch, command);
    }
    return normalizeGatewayError(error, command);
  }
}

function normalizeSendInput(input: ControlModelSendInput): Record<string, unknown> & {
  message: string;
  attachments?: readonly unknown[];
  idempotencyKey?: string;
} {
  const value = typeof input === "string" ? { message: input } : (record(input) ?? {});
  const message = text(value.message) ?? text(value.content) ?? "";
  const attachments = Array.isArray(value.attachments) ? value.attachments : undefined;
  if (!message && (!attachments || attachments.length === 0)) {
    throw localError(
      "invalid-input",
      "chat.send",
      "Message or attachment is required",
      "EMPTY_MESSAGE",
    );
  }
  return { ...value, message, ...(attachments ? { attachments } : {}) };
}

function sendOptions(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    "thinking",
    "fastMode",
    "fastAutoOnSeconds",
    "queueMode",
    "replyToId",
    "toolBindings",
    "timeoutMs",
    "expectedLeafEntryId",
    "expectedRunId",
    "suppressCommandInterpretation",
  ]) {
    if (input[key] !== undefined) {
      result[key] = input[key];
    }
  }
  return result;
}
