import type {
  SessionCompanionExchange,
  SessionsCompanionAskResult,
  SessionsCompanionResetResult,
  SessionsCompanionStateResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

const COMPANION_BUSY_DETAIL_CODE = "SESSION_COMPANION_BUSY";
const MAX_COMPANION_EXCHANGES = 24;

export type ChatSessionCompanionThread = {
  exchanges: SessionCompanionExchange[];
  pendingQuestion: string | null;
  failedQuestion: string | null;
  hint:
    | "busy"
    | "history-unavailable"
    | "missing"
    | "model-unavailable"
    | "rate-limited"
    | "unavailable"
    | null;
  retryable?: boolean;
  phase?: "answering" | "reading" | null;
  draft: string;
};

type MutableCompanionThread = ChatSessionCompanionThread & {
  revision: number;
};

function errorDetailCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function errorDetailReason(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

function errorIsRetryable(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { retryable?: unknown }).retryable,
  );
}

function createThread(): MutableCompanionThread {
  return {
    exchanges: [],
    pendingQuestion: null,
    failedQuestion: null,
    hint: null,
    retryable: false,
    phase: null,
    draft: "",
    revision: 0,
  };
}

/** Pane-owned ephemeral companion threads, keyed by the exact selected session. */
export class ChatSessionCompanionThreads {
  private readonly threads = new Map<string, MutableCompanionThread>();
  private readonly hydrationTokens = new Map<string, symbol>();
  private readonly submissionTokens = new Map<string, symbol>();

  constructor(private readonly notify: () => void = () => {}) {}

  view(sessionKey: string): ChatSessionCompanionThread {
    return this.get(sessionKey);
  }

  setDraft(sessionKey: string, draft: string): void {
    const thread = this.get(sessionKey);
    if (thread.draft === draft) {
      return;
    }
    thread.draft = draft;
    thread.revision += 1;
    this.notify();
  }

  async hydrate(
    sessionKey: string,
    load: (sessionKey: string) => Promise<SessionsCompanionStateResult>,
  ): Promise<void> {
    const key = sessionKey.trim();
    if (!key) {
      return;
    }
    const thread = this.get(key);
    const revision = thread.revision;
    const token = Symbol(key);
    this.hydrationTokens.set(key, token);
    try {
      const result = await load(key);
      if (this.hydrationTokens.get(key) !== token || thread.revision !== revision) {
        return;
      }
      thread.exchanges = result.exchanges.map(({ question, answer, ts }) => ({
        question,
        answer,
        ts,
      }));
      if (
        thread.failedQuestion &&
        thread.exchanges.some((exchange) => exchange.question === thread.failedQuestion)
      ) {
        thread.failedQuestion = null;
        thread.hint = null;
        thread.retryable = false;
      }
      thread.revision += 1;
      this.notify();
    } catch {
      // A disconnected or older Gateway should not erase a thread already
      // visible in this pane. Ask failures surface an actionable inline hint.
    } finally {
      if (this.hydrationTokens.get(key) === token) {
        this.hydrationTokens.delete(key);
      }
    }
  }

  async submit(
    sessionKey: string,
    question: string,
    ask: (
      sessionKey: string,
      question: string,
      onPrepared: () => void,
    ) => Promise<SessionsCompanionAskResult>,
    isCurrent: () => boolean = () => true,
    reload?: (sessionKey: string) => Promise<SessionsCompanionStateResult>,
  ): Promise<void> {
    const key = sessionKey.trim();
    const normalized = question.trim();
    if (!key || !normalized) {
      return;
    }
    const thread = this.get(key);
    if (thread.pendingQuestion) {
      return;
    }
    thread.pendingQuestion = normalized;
    thread.failedQuestion = null;
    thread.hint = null;
    thread.retryable = false;
    thread.phase = "reading";
    thread.draft = "";
    thread.revision += 1;
    const token = Symbol(key);
    this.submissionTokens.set(key, token);
    this.notify();
    const knownExchanges = new Set(
      thread.exchanges.map(({ question: priorQuestion, answer, ts }) =>
        JSON.stringify([priorQuestion, answer, ts]),
      ),
    );
    const reconcileStale = async (
      expectedAnswer?: string,
    ): Promise<"committed" | "missing" | "superseded" | "unavailable"> => {
      if (!reload) {
        return "unavailable";
      }
      try {
        const result = await reload(key);
        if (this.submissionTokens.get(key) !== token) {
          return "superseded";
        }
        thread.exchanges = result.exchanges.map(({ question: nextQuestion, answer, ts }) => ({
          question: nextQuestion,
          answer,
          ts,
        }));
        const committed = thread.exchanges.some(
          (exchange) =>
            exchange.question === normalized &&
            (expectedAnswer === undefined || exchange.answer === expectedAnswer) &&
            !knownExchanges.has(JSON.stringify([exchange.question, exchange.answer, exchange.ts])),
        );
        return committed ? "committed" : "missing";
      } catch {
        return "unavailable";
      }
    };
    try {
      const result = await ask(key, normalized, () => {
        if (this.submissionTokens.get(key) !== token || !isCurrent()) {
          return;
        }
        thread.phase = "answering";
        thread.revision += 1;
        this.notify();
      });
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      if (!isCurrent()) {
        const reconciliation = await reconcileStale(result.answer);
        if (reconciliation === "committed" || reconciliation === "superseded") {
          return;
        }
        thread.failedQuestion = normalized;
        thread.hint = "unavailable";
        thread.retryable = false;
        return;
      }
      thread.exchanges = [
        ...thread.exchanges,
        { question: normalized, answer: result.answer, ts: result.ts },
      ].slice(-MAX_COMPANION_EXCHANGES);
    } catch (error) {
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      if (!isCurrent()) {
        const reconciliation = await reconcileStale();
        if (reconciliation === "committed" || reconciliation === "superseded") {
          return;
        }
        thread.failedQuestion = normalized;
        thread.hint = reconciliation === "missing" ? "history-unavailable" : "unavailable";
        thread.retryable = reconciliation === "missing";
        return;
      }
      thread.failedQuestion = normalized;
      const reason = errorDetailReason(error);
      thread.hint =
        errorDetailCode(error) === COMPANION_BUSY_DETAIL_CODE
          ? "busy"
          : reason === "context-unavailable"
            ? "history-unavailable"
            : reason === "session-missing"
              ? "missing"
              : reason === "rate-limited"
                ? "rate-limited"
                : reason === "utility-model-unavailable"
                  ? "model-unavailable"
                  : "unavailable";
      thread.retryable = errorIsRetryable(error);
    } finally {
      if (this.submissionTokens.get(key) === token) {
        this.submissionTokens.delete(key);
        thread.pendingQuestion = null;
        thread.phase = null;
        thread.revision += 1;
        this.notify();
      }
    }
  }

  async reset(
    sessionKey: string,
    clear: (sessionKey: string) => Promise<SessionsCompanionResetResult>,
  ): Promise<void> {
    const key = sessionKey.trim();
    if (!key) {
      return;
    }
    await clear(key);
    this.hydrationTokens.delete(key);
    this.submissionTokens.delete(key);
    this.threads.set(key, createThread());
    this.notify();
  }

  private get(sessionKey: string): MutableCompanionThread {
    const key = sessionKey.trim();
    let thread = this.threads.get(key);
    if (!thread) {
      thread = createThread();
      this.threads.set(key, thread);
    }
    return thread;
  }
}

export function requestSessionCompanionAnswer(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  question: string,
  onPrepared: () => void,
): Promise<SessionsCompanionAskResult> {
  return client.request<SessionsCompanionAskResult>(
    "sessions.companion.ask",
    { sessionKey, question },
    { expectFinal: true, onAccepted: onPrepared },
  );
}

export function requestSessionCompanionState(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
): Promise<SessionsCompanionStateResult> {
  return client.request<SessionsCompanionStateResult>("sessions.companion.state", { sessionKey });
}

export function resetSessionCompanion(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
): Promise<SessionsCompanionResetResult> {
  return client.request<SessionsCompanionResetResult>("sessions.companion.reset", { sessionKey });
}
