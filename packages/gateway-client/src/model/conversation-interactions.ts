import type {
  ControlModelConversationApproval,
  ControlModelConversationHost,
  ControlModelConversationQuestion,
} from "./conversation-types.js";
import {
  cloneAndFreeze,
  normalizeGatewayError,
  normalizeStatus,
  record,
  text,
} from "./conversation-utils.js";

type ConversationInteractionStoreOptions = {
  host: ControlModelConversationHost;
  sessionKey: string;
  partialReasons: Set<string>;
  matchesSessionKey(key: string): boolean;
  matchesQuestionEvent(question: Record<string, unknown>): boolean;
  isDisposed(): boolean;
  publish(): void;
};

export class ConversationInteractionStore {
  readonly #options: ConversationInteractionStoreOptions;
  readonly #approvals = new Map<string, Record<string, unknown>>();
  readonly #questions = new Map<string, Record<string, unknown>>();
  readonly #questionHydrations = new Map<number, Promise<void>>();
  #approvalsTruncated = false;
  #questionsTruncated = false;

  constructor(options: ConversationInteractionStoreOptions) {
    this.#options = options;
  }

  get approvalsTruncated(): boolean {
    return this.#approvalsTruncated;
  }

  get questionsTruncated(): boolean {
    return this.#questionsTruncated;
  }

  getApproval(id: string): Record<string, unknown> | undefined {
    return this.#approvals.get(id);
  }

  getQuestion(id: string): Record<string, unknown> | undefined {
    return this.#questions.get(id);
  }

  hasQuestion(id: string): boolean {
    return this.#questions.has(id);
  }

  approvalsSnapshot(): ControlModelConversationApproval[] {
    return [...this.#approvals.values()].map((approval) => {
      // SAFETY: upsertApproval validates and stores a non-empty string id before insertion.
      return cloneAndFreeze(approval) as ControlModelConversationApproval;
    });
  }

  questionsSnapshot(): ControlModelConversationQuestion[] {
    return [...this.#questions.values()].map((question) => {
      // SAFETY: upsertQuestion validates id and supplies the normalized session key.
      return cloneAndFreeze(question) as ControlModelConversationQuestion;
    });
  }

  applyApprovalReplay(replay: unknown): void {
    const value = record(replay);
    if (!value || !Array.isArray(value.approvals)) {
      return;
    }
    if (value.truncated !== true) {
      for (const [id, approval] of this.#approvals) {
        if (normalizeStatus(approval.status) === "pending") {
          this.#approvals.delete(id);
        }
      }
    }
    for (const approval of value.approvals) {
      this.upsertApproval(approval);
    }
    if (value.truncated === true) {
      this.#options.partialReasons.add("approval-replay-truncated");
    } else {
      this.#options.partialReasons.delete("approval-replay-truncated");
    }
    this.#options.publish();
  }

  upsertApproval(value: unknown): void {
    const approval = record(value);
    const id = text(approval?.id);
    if (!approval || !id) {
      return;
    }
    const sessionKey = text(approval.sessionKey) ?? text(approval.sourceSessionKey);
    if (sessionKey && !this.#options.matchesSessionKey(sessionKey)) {
      return;
    }
    this.#approvals.set(id, { ...approval });
    while (this.#approvals.size > this.#options.host.bounds.maxApprovals) {
      const first = this.#approvals.keys().next().value;
      if (first) {
        this.#approvals.delete(first);
      } else {
        break;
      }
      this.#approvalsTruncated = true;
    }
    this.#options.publish();
  }

  upsertQuestion(value: unknown): void {
    const question = record(value);
    const id = text(question?.id);
    if (!question || !id) {
      return;
    }
    const sessionKey = text(question.sessionKey);
    if (sessionKey && !this.#options.matchesSessionKey(sessionKey)) {
      return;
    }
    this.#questions.set(id, { ...question, sessionKey: this.#options.sessionKey });
    while (this.#questions.size > this.#options.host.bounds.maxQuestions) {
      const first = this.#questions.keys().next().value;
      if (first) {
        this.#questions.delete(first);
      } else {
        break;
      }
      this.#questionsTruncated = true;
    }
    this.#options.publish();
  }

  resolveQuestionEvent(payload: Record<string, unknown>): void {
    const id = text(payload.id) ?? text(record(payload.question)?.id);
    if (!id) {
      return;
    }
    const existing = this.#questions.get(id);
    this.upsertQuestion({ ...existing, ...payload, id, sessionKey: this.#options.sessionKey });
  }

  async hydrateQuestions(epoch: number): Promise<void> {
    if (this.#options.isDisposed()) {
      return;
    }
    const existing = this.#questionHydrations.get(epoch);
    if (existing) {
      return existing;
    }
    const promise = (async () => {
      try {
        const result = await this.#options.host.gateway.request<Record<string, unknown>>(
          "question.list",
          {},
          undefined,
        );
        const current = this.#options.host.getConnectionSnapshot();
        if (
          this.#options.isDisposed() ||
          current.epoch !== epoch ||
          current.status !== "connected"
        ) {
          return;
        }
        this.#options.partialReasons.delete("questions-unavailable");
        const questions = Array.isArray(result?.questions) ? result.questions : [];
        const pendingIds = new Set<string>();
        for (const question of questions) {
          const value = record(question);
          if (value && this.#options.matchesQuestionEvent(value)) {
            const id = text(value.id);
            if (id) {
              pendingIds.add(id);
            }
            this.upsertQuestion(question);
          }
        }
        for (const [id, question] of this.#questions) {
          if (normalizeStatus(question.status) === "pending" && !pendingIds.has(id)) {
            this.#questions.delete(id);
          }
        }
        this.#options.publish();
      } catch (error) {
        const current = this.#options.host.getConnectionSnapshot();
        if (
          !this.#options.isDisposed() &&
          current.status === "connected" &&
          current.epoch === epoch
        ) {
          this.#options.partialReasons.add("questions-unavailable");
          this.#options.host.reportBackgroundError(normalizeGatewayError(error, "question.list"));
          this.#options.publish();
        }
      }
    })();
    const tracked = promise.finally(() => {
      if (this.#questionHydrations.get(epoch) === tracked) {
        this.#questionHydrations.delete(epoch);
      }
    });
    this.#questionHydrations.set(epoch, tracked);
    return tracked;
  }
}
