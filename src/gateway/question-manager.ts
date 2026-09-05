// Gateway question manager.
// Tracks transient operator questions and short-lived terminal records in memory.
import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolvedEvent,
  QuestionResolveResult,
  QuestionWaitAnswerResult,
} from "../../packages/gateway-protocol/src/index.js";
import {
  retainGatewayRootWorkAdmissionContinuationScope,
  type GatewayRootWorkAdmissionContinuationScope,
} from "../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";

/** Grace period for late question.waitAnswer and question.get calls. */
const QUESTION_RESOLVED_ENTRY_GRACE_MS = 15_000;

export const QuestionManagerErrorCodes = {
  NOT_FOUND: "QUESTION_NOT_FOUND",
  ALREADY_TERMINAL: "QUESTION_ALREADY_TERMINAL",
  ID_IN_USE: "QUESTION_ID_IN_USE",
  INVALID_ANSWER: "QUESTION_INVALID_ANSWER",
  REQUESTER_INACTIVE: "QUESTION_REQUESTER_INACTIVE",
} as const;

type QuestionManagerErrorCode =
  (typeof QuestionManagerErrorCodes)[keyof typeof QuestionManagerErrorCodes];

export class QuestionManagerError extends Error {
  constructor(
    readonly code: QuestionManagerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "QuestionManagerError";
  }
}

type QuestionManagerRequest = {
  id?: string;
  questions: Question[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  timeoutMs: number;
  onResolved?: (event: QuestionResolvedEvent) => void;
  isRequesterActive?: () => boolean;
  /** Trusted handler binds the run; the manager owns expiry and terminal release. */
  registerHumanInputWait?: (isPending: () => boolean) => ((resolved: boolean) => void) | undefined;
};

type Waiter = () => void;

type QuestionEntry = {
  record: QuestionRecord;
  resolutionId?: string;
  expiryTimer: ReturnType<typeof setTimeout>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  waiters: Set<Waiter>;
  onResolved?: (event: QuestionResolvedEvent) => void;
  isRequesterActive?: () => boolean;
  admissionContinuation: GatewayRootWorkAdmissionContinuationScope | null;
  releaseHumanInputWait?: (resolved: boolean) => void;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function waitResult(entry: QuestionEntry, includeResolutionId: boolean): QuestionWaitAnswerResult {
  const { record, resolutionId } = entry;
  switch (record.status) {
    case "pending":
      return { status: "pending" };
    case "answered":
      // Legacy native decoders reject extra fields. Correlation is opt-in per
      // waiter, never exposed on records/events or used as resolution authority.
      return {
        status: "answered",
        answers: record.answers ?? { answers: {} },
        ...(includeResolutionId && resolutionId ? { resolutionId } : {}),
      };
    case "cancelled":
      return { status: "cancelled" };
    case "expired":
      return { status: "expired" };
  }
  return record.status satisfies never;
}

function resolvedEvent(record: QuestionRecord): QuestionResolvedEvent | null {
  if (record.status === "pending") {
    return null;
  }
  return record.status === "answered"
    ? { id: record.id, status: record.status, answers: record.answers ?? { answers: {} } }
    : { id: record.id, status: record.status };
}

/** Process-local lifecycle owner for pending questions. */
export class QuestionManager {
  private readonly entries = new Map<string, QuestionEntry>();
  private closed = false;

  request(params: QuestionManagerRequest): QuestionRecord {
    if (this.closed) {
      throw new Error("Question manager is closed");
    }
    if (params.isRequesterActive && !params.isRequesterActive()) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.REQUESTER_INACTIVE,
        "the agent run that requested this question is no longer active",
      );
    }
    const createdAtMs = Date.now();
    const timeoutMs = resolveTimerTimeoutMs(params.timeoutMs, 1);
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(timeoutMs, { nowMs: createdAtMs });
    if (expiresAtMs === undefined) {
      throw new Error("question expiry is unavailable");
    }
    const id = params.id ?? randomUUID();
    if (this.entries.has(id)) {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ID_IN_USE,
        `question '${id}' already exists`,
      );
    }
    const record: QuestionRecord = {
      id,
      questions: params.questions,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
      createdAtMs,
      expiresAtMs,
      status: "pending",
    };
    const expiryTimer = setTimeout(() => this.expire(record.id), timeoutMs);
    const entry: QuestionEntry = {
      record,
      expiryTimer,
      cleanupTimer: null,
      waiters: new Set(),
      onResolved: params.onResolved,
      isRequesterActive: params.isRequesterActive,
      admissionContinuation: retainGatewayRootWorkAdmissionContinuationScope(),
    };
    this.entries.set(record.id, entry);
    entry.releaseHumanInputWait = params.registerHumanInputWait?.(
      () => this.get(id)?.status === "pending" && this.entries.get(id) === entry,
    );
    unrefTimer(entry.expiryTimer);
    return record;
  }

  get(id: string): QuestionRecord | null {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }
    if (entry.record.status === "pending" && entry.record.expiresAtMs <= Date.now()) {
      this.expire(id);
    }
    if (entry.record.status === "pending" && entry.isRequesterActive?.() === false) {
      this.cancelEntry(entry, "requester-inactive");
    }
    return this.entries.get(id)?.record ?? null;
  }

  /** Called by the Gateway's existing authority-close observer. */
  cancelClosedAuthorities(): void {
    for (const id of this.entries.keys()) {
      this.get(id);
    }
  }

  list(): QuestionRecord[] {
    const records: QuestionRecord[] = [];
    for (const id of this.entries.keys()) {
      const record = this.get(id);
      if (record?.status === "pending") {
        records.push(record);
      }
    }
    return records.toSorted(
      (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
    );
  }

  /** Re-enters only the still-pending question's original admitted root. */
  runPendingContinuation<T>(id: string, run: () => Promise<T>): Promise<T> | null {
    this.get(id);
    const entry = this.entries.get(id);
    if (
      !entry?.admissionContinuation ||
      entry.record.status !== "pending" ||
      entry.record.expiresAtMs <= Date.now()
    ) {
      return null;
    }
    return entry.admissionContinuation.run(run);
  }

  waitAnswer(
    id: string,
    timeoutMs?: number,
    includeResolutionId = false,
  ): Promise<QuestionWaitAnswerResult> {
    const entry = this.requireEntry(id);
    if (entry.record.status !== "pending") {
      return Promise.resolve(waitResult(entry, includeResolutionId));
    }
    const signal = getAsyncWorkSignal();
    return new Promise<QuestionWaitAnswerResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = () => {
        if (!entry.waiters.delete(waiter)) {
          return;
        }
        clearTimeout(timer);
        signal?.removeEventListener("abort", waiter);
        // finish() may close this observer after recording an answer. Read that
        // fact directly; get() could expire/cancel the question during retirement.
        resolve(waitResult(entry, includeResolutionId));
      };
      entry.waiters.add(waiter);
      if (signal?.aborted) {
        waiter();
        return;
      }
      signal?.addEventListener("abort", waiter, { once: true });
      if (timeoutMs !== undefined) {
        timer = setTimeout(waiter, resolveTimerTimeoutMs(timeoutMs, 1));
        unrefTimer(timer);
      }
    });
  }

  resolve(
    id: string,
    answers: QuestionAnswers,
    resolvedBy?: string,
    options?: { commit?: () => void; resolutionId?: string },
  ): QuestionResolveResult {
    const entry = this.requirePendingEntry(id);
    const canonical = this.validateAnswers(entry.record.questions, answers);
    // The commit, receipt, and answered transition are synchronous. Failed
    // validation/writes must not publish a receipt; lost ACKs must not erase it.
    options?.commit?.();
    entry.resolutionId = options?.resolutionId;
    entry.record = {
      ...entry.record,
      status: "answered",
      answers: canonical,
      ...(resolvedBy ? { resolvedBy } : {}),
    };
    this.finish(entry);
    return { status: "answered", answers: canonical };
  }

  cancel(id: string, resolvedBy?: string): QuestionResolveResult {
    const entry = this.requirePendingEntry(id);
    return this.cancelEntry(entry, resolvedBy);
  }

  private cancelEntry(entry: QuestionEntry, resolvedBy?: string): QuestionResolveResult {
    entry.record = {
      ...entry.record,
      status: "cancelled",
      ...(resolvedBy ? { resolvedBy } : {}),
    };
    this.finish(entry);
    return { status: "cancelled" };
  }

  /** Retires this Gateway's owner only after received mutations have joined. */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.reset();
  }

  /** Reusable on open owners (v2026.8.1 SDK context); never reopens a closed owner. */
  reset(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.expiryTimer);
      const releaseHumanInputWait = entry.releaseHumanInputWait;
      entry.releaseHumanInputWait = undefined;
      releaseHumanInputWait?.(false);
      entry.admissionContinuation?.release();
      entry.admissionContinuation = null;
      if (entry.cleanupTimer) {
        clearTimeout(entry.cleanupTimer);
      }
      for (const waiter of entry.waiters) {
        waiter();
      }
    }
    this.entries.clear();
  }

  private requireEntry(id: string): QuestionEntry {
    // get() settles expiry/requester loss; its callbacks can replace the entry.
    this.get(id);
    const entry = this.entries.get(id);
    if (!entry) {
      throw this.notFound(id);
    }
    return entry;
  }

  private requirePendingEntry(id: string): QuestionEntry {
    const entry = this.requireEntry(id);
    if (entry.record.status !== "pending") {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ALREADY_TERMINAL,
        `question '${id}' is already ${entry.record.status}`,
      );
    }
    return entry;
  }

  /** Validates answers against stored questions and returns them in canonical form. */
  private validateAnswers(questions: Question[], answers: QuestionAnswers): QuestionAnswers {
    const submittedIds = Object.keys(answers.answers);
    const questionsById = new Map(questions.map((question) => [question.questionId, question]));
    const unknownId = submittedIds.find((id) => !questionsById.has(id));
    if (unknownId) {
      throw this.invalidAnswer(unknownId, "is not part of this request");
    }
    // Canonical rebuilds every key as an own property, so downstream readers of
    // resolved answers can index the record directly without prototype checks.
    const canonical: QuestionAnswers = { answers: {} };
    for (const question of questions) {
      // Object.hasOwn: the id grammar admits "constructor"; a plain index read
      // would return the inherited prototype member instead of undefined.
      const values = Object.hasOwn(answers.answers, question.questionId)
        ? answers.answers[question.questionId]
        : undefined;
      if (!values || values.length === 0) {
        throw this.invalidAnswer(question.questionId, "requires an answer");
      }
      if (values.some((value) => !value.trim())) {
        throw this.invalidAnswer(question.questionId, "contains an empty answer");
      }
      if (!question.multiSelect && values.length > 1) {
        throw this.invalidAnswer(question.questionId, "does not allow multiple answers");
      }
      // Store the declared option label when a value matches trim-insensitively;
      // downstream renderers compare answers to option labels exactly.
      const canonicalValues = values.map((value) => {
        const matched = question.options.find((option) => option.label.trim() === value.trim());
        return matched ? matched.label : value.trim();
      });
      if (
        question.options.length > 0 &&
        !question.isOther &&
        canonicalValues.some((value) => !question.options.some((option) => option.label === value))
      ) {
        throw this.invalidAnswer(question.questionId, "contains an unknown option");
      }
      canonical.answers[question.questionId] = canonicalValues;
    }
    return canonical;
  }

  private invalidAnswer(id: string, reason: string): QuestionManagerError {
    return new QuestionManagerError(
      QuestionManagerErrorCodes.INVALID_ANSWER,
      `question '${id}' ${reason}`,
    );
  }

  private notFound(id: string): QuestionManagerError {
    return new QuestionManagerError(
      QuestionManagerErrorCodes.NOT_FOUND,
      `question '${id}' was not found`,
    );
  }

  private expire(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.record.status !== "pending") {
      return;
    }
    entry.record = { ...entry.record, status: "expired" };
    this.finish(entry);
  }

  private finish(entry: QuestionEntry): void {
    clearTimeout(entry.expiryTimer);
    // Requester-scope loss must not refresh the still-live run's recovery clock.
    const releaseHumanInputWait = entry.releaseHumanInputWait;
    entry.releaseHumanInputWait = undefined;
    releaseHumanInputWait?.(entry.isRequesterActive?.() !== false);
    entry.isRequesterActive = undefined;
    entry.admissionContinuation?.release();
    entry.admissionContinuation = null;
    for (const waiter of entry.waiters) {
      waiter();
    }
    const event = resolvedEvent(entry.record);
    if (event) {
      try {
        entry.onResolved?.(event);
      } catch {
        // Broadcast fanout is observational and must not change question truth.
      }
    }
    // A resolution callback can reset/close the owner synchronously; it must
    // not recreate a retention timer after that entry has been retired.
    if (this.entries.get(entry.record.id) !== entry) {
      return;
    }
    const cleanupTimer = setTimeout(() => {
      if (entry.cleanupTimer === cleanupTimer && this.entries.get(entry.record.id) === entry) {
        this.entries.delete(entry.record.id);
      }
    }, QUESTION_RESOLVED_ENTRY_GRACE_MS);
    entry.cleanupTimer = cleanupTimer;
    unrefTimer(cleanupTimer);
  }
}
