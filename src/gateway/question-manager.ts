// Gateway question manager.
// Tracks transient operator questions and short-lived terminal records in memory.
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolvedEvent,
  QuestionResolveResult,
  QuestionWaitAnswerResult,
} from "../../packages/gateway-protocol/src/index.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";

/** Grace period for late question.waitAnswer and question.get calls. */
const QUESTION_RESOLVED_ENTRY_GRACE_MS = 15_000;

export const QuestionManagerErrorCodes = {
  NOT_FOUND: "QUESTION_NOT_FOUND",
  ALREADY_TERMINAL: "QUESTION_ALREADY_TERMINAL",
  ID_IN_USE: "QUESTION_ID_IN_USE",
  INVALID_ANSWER: "QUESTION_INVALID_ANSWER",
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
  timeoutMs: number;
  onResolved?: (event: QuestionResolvedEvent) => void;
};

type Waiter = {
  resolve: (result: QuestionWaitAnswerResult) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type QuestionEntry = {
  record: QuestionRecord;
  expiryTimer: ReturnType<typeof setTimeout>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  waiters: Set<Waiter>;
  onResolved?: (event: QuestionResolvedEvent) => void;
};

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.();
}

function waitResult(record: QuestionRecord): QuestionWaitAnswerResult {
  switch (record.status) {
    case "pending":
      return { status: "pending" };
    case "answered":
      // The manager only sets status "answered" together with validated answers.
      return { status: "answered", answers: record.answers ?? { answers: {} } };
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

  request(params: QuestionManagerRequest): QuestionRecord {
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
      createdAtMs,
      expiresAtMs,
      status: "pending",
    };
    const entry: QuestionEntry = {
      record,
      expiryTimer: null as unknown as ReturnType<typeof setTimeout>,
      cleanupTimer: null,
      waiters: new Set(),
      onResolved: params.onResolved,
    };
    this.entries.set(record.id, entry);
    entry.expiryTimer = setTimeout(() => this.expire(record.id), timeoutMs);
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
    return this.entries.get(id)?.record ?? null;
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

  waitAnswer(id: string, timeoutMs?: number): Promise<QuestionWaitAnswerResult> {
    const record = this.requireRecord(id);
    if (record.status !== "pending") {
      return Promise.resolve(waitResult(record));
    }
    const entry = this.entries.get(id);
    if (!entry) {
      throw this.notFound(id);
    }
    return new Promise<QuestionWaitAnswerResult>((resolve) => {
      const waiter: Waiter = { resolve, timer: null };
      entry.waiters.add(waiter);
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(
          () => {
            entry.waiters.delete(waiter);
            resolve({ status: "pending" });
          },
          resolveTimerTimeoutMs(timeoutMs, 1),
        );
        unrefTimer(waiter.timer);
      }
    });
  }

  resolve(id: string, answers: QuestionAnswers, resolvedBy?: string): QuestionResolveResult {
    const entry = this.requirePendingEntry(id);
    const canonical = this.validateAnswers(entry.record.questions, answers);
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
    entry.record = {
      ...entry.record,
      status: "cancelled",
      ...(resolvedBy ? { resolvedBy } : {}),
    };
    this.finish(entry);
    return { status: "cancelled" };
  }

  /** Clears all manager-owned timers and releases waiters. */
  reset(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.expiryTimer);
      if (entry.cleanupTimer) {
        clearTimeout(entry.cleanupTimer);
      }
      for (const waiter of entry.waiters) {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve(waitResult(entry.record));
      }
      entry.waiters.clear();
    }
    this.entries.clear();
  }

  private requireRecord(id: string): QuestionRecord {
    const record = this.get(id);
    if (!record) {
      throw this.notFound(id);
    }
    return record;
  }

  private requirePendingEntry(id: string): QuestionEntry {
    const record = this.requireRecord(id);
    if (record.status !== "pending") {
      throw new QuestionManagerError(
        QuestionManagerErrorCodes.ALREADY_TERMINAL,
        `question '${id}' is already ${record.status}`,
      );
    }
    const entry = this.entries.get(id);
    if (!entry) {
      throw this.notFound(id);
    }
    return entry;
  }

  /** Validates answers against stored questions and returns them in canonical form. */
  private validateAnswers(questions: Question[], answers: QuestionAnswers): QuestionAnswers {
    const submittedIds = Object.keys(answers.answers);
    const questionsById = new Map(questions.map((question) => [question.id, question]));
    const unknownId = submittedIds.find((id) => !questionsById.has(id));
    if (unknownId) {
      throw this.invalidAnswer(unknownId, "is not part of this request");
    }
    const canonical: QuestionAnswers = { answers: {} };
    for (const question of questions) {
      const values = answers.answers[question.id]?.answers;
      if (!values || values.length === 0) {
        throw this.invalidAnswer(question.id, "requires an answer");
      }
      if (values.some((value) => !value.trim())) {
        throw this.invalidAnswer(question.id, "contains an empty answer");
      }
      if (!question.multiSelect && values.length > 1) {
        throw this.invalidAnswer(question.id, "does not allow multiple answers");
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
        throw this.invalidAnswer(question.id, "contains an unknown option");
      }
      canonical.answers[question.id] = { answers: canonicalValues };
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
    const result = waitResult(entry.record);
    for (const waiter of entry.waiters) {
      if (waiter.timer) {
        clearTimeout(waiter.timer);
      }
      waiter.resolve(result);
    }
    entry.waiters.clear();
    const event = resolvedEvent(entry.record);
    if (event) {
      try {
        entry.onResolved?.(event);
      } catch {
        // Broadcast fanout is observational and must not change question truth.
      }
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
