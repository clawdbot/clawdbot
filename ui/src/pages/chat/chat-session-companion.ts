import type {
  SessionCompanionExchange,
  SessionsCompanionAskResult,
  SessionsCompanionResetResult,
  SessionsCompanionStateResult,
} from "../../../../packages/gateway-protocol/src/schema/sessions.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";

const COMPANION_BUSY_DETAIL_CODE = "SESSION_COMPANION_BUSY";
const MAX_COMPANION_EXCHANGES = 24;
const COMPANION_ASK_TIMEOUT_MS = 70_000;

export type ChatSessionCompanionThread = {
  exchanges: SessionCompanionExchange[];
  loading: boolean;
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
  draft: string;
};

type MutableCompanionThread = ChatSessionCompanionThread & {
  failedQuestionKnownExchanges: ReadonlySet<string> | null;
  revision: number;
};

function exchangeKey(exchange: SessionCompanionExchange): string {
  return JSON.stringify([exchange.question, exchange.answer, exchange.ts]);
}

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
    loading: false,
    pendingQuestion: null,
    failedQuestion: null,
    failedQuestionKnownExchanges: null,
    hint: null,
    retryable: false,
    draft: "",
    revision: 0,
  };
}

function companionThreadKey(sessionKey: string, agentId?: string | null): string {
  return `${agentId?.trim() ?? ""}\0${sessionKey.trim()}`;
}

/** Pane-owned ephemeral companion threads, keyed by the exact selected session. */
export class ChatSessionCompanionThreads {
  private readonly threads = new Map<string, MutableCompanionThread>();
  private readonly hydrationTokens = new Map<string, symbol>();
  private readonly submissionTokens = new Map<string, symbol>();

  constructor(private readonly notify: () => void = () => {}) {}

  view(sessionKey: string, agentId?: string | null): ChatSessionCompanionThread {
    return this.get(sessionKey, agentId);
  }

  setDraft(sessionKey: string, draft: string, agentId?: string | null): void {
    const thread = this.get(sessionKey, agentId);
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
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    if (!targetSessionKey) {
      return;
    }
    const key = companionThreadKey(targetSessionKey, agentId);
    const thread = this.get(targetSessionKey, agentId);
    const revision = thread.revision;
    const token = Symbol(key);
    this.hydrationTokens.set(key, token);
    thread.loading = true;
    this.notify();
    try {
      const result = await load(targetSessionKey);
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
        thread.exchanges.some(
          (exchange) =>
            exchange.question === thread.failedQuestion &&
            !thread.failedQuestionKnownExchanges?.has(exchangeKey(exchange)),
        )
      ) {
        thread.failedQuestion = null;
        thread.failedQuestionKnownExchanges = null;
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
        thread.loading = false;
        this.notify();
      }
    }
  }

  async submit(
    sessionKey: string,
    question: string,
    ask: (sessionKey: string, question: string) => Promise<SessionsCompanionAskResult>,
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    const normalized = question.trim();
    if (!targetSessionKey || !normalized) {
      return;
    }
    const key = companionThreadKey(targetSessionKey, agentId);
    const thread = this.get(targetSessionKey, agentId);
    if (thread.pendingQuestion) {
      return;
    }
    thread.pendingQuestion = normalized;
    thread.failedQuestion = null;
    thread.failedQuestionKnownExchanges = null;
    thread.hint = null;
    thread.retryable = false;
    thread.draft = "";
    thread.revision += 1;
    const token = Symbol(key);
    const knownExchanges = new Set(thread.exchanges.map(exchangeKey));
    this.submissionTokens.set(key, token);
    this.notify();
    try {
      const result = await ask(targetSessionKey, normalized);
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      thread.exchanges = [
        ...thread.exchanges,
        { question: normalized, answer: result.answer, ts: result.ts },
      ].slice(-MAX_COMPANION_EXCHANGES);
      thread.failedQuestionKnownExchanges = null;
    } catch (error) {
      if (this.submissionTokens.get(key) !== token) {
        return;
      }
      thread.failedQuestion = normalized;
      thread.failedQuestionKnownExchanges = knownExchanges;
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
      thread.retryable = errorIsRetryable(error) || reason === null;
    } finally {
      if (this.submissionTokens.get(key) === token) {
        this.submissionTokens.delete(key);
        thread.pendingQuestion = null;
        thread.revision += 1;
        this.notify();
      }
    }
  }

  async reset(
    sessionKey: string,
    clear: (sessionKey: string) => Promise<SessionsCompanionResetResult>,
    agentId?: string | null,
  ): Promise<void> {
    const targetSessionKey = sessionKey.trim();
    if (!targetSessionKey) {
      return;
    }
    await clear(targetSessionKey);
    this.retire(targetSessionKey, agentId);
  }

  retire(sessionKey?: string, agentId?: string | null): void {
    const key = sessionKey ? companionThreadKey(sessionKey, agentId) : null;
    for (const store of [this.threads, this.hydrationTokens, this.submissionTokens]) {
      void (key ? store.delete(key) : store.clear());
    }
    this.notify();
  }

  private get(sessionKey: string, agentId?: string | null): MutableCompanionThread {
    const key = companionThreadKey(sessionKey, agentId);
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
  agentId?: string | null,
): Promise<SessionsCompanionAskResult> {
  return client.request<SessionsCompanionAskResult>(
    "sessions.companion.ask",
    { sessionKey, ...(agentId ? { agentId } : {}), question },
    { timeoutMs: COMPANION_ASK_TIMEOUT_MS },
  );
}

export function requestSessionCompanionState(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  agentId?: string | null,
): Promise<SessionsCompanionStateResult> {
  return client.request<SessionsCompanionStateResult>("sessions.companion.state", {
    sessionKey,
    ...(agentId ? { agentId } : {}),
  });
}

export function resetSessionCompanion(
  client: Pick<GatewayBrowserClient, "request">,
  sessionKey: string,
  agentId?: string | null,
): Promise<SessionsCompanionResetResult> {
  return client.request<SessionsCompanionResetResult>("sessions.companion.reset", {
    sessionKey,
    ...(agentId ? { agentId } : {}),
  });
}
