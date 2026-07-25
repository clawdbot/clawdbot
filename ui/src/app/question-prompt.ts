// Control UI module owns transient operator question state.
import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolvedEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayEventFrame } from "../api/gateway.ts";

type QuestionClient = {
  request: (method: string, params?: unknown) => Promise<unknown>;
};

type QuestionDraft = {
  selected: Set<string>;
  freeText: string;
};

type QuestionPromptStatus = QuestionRecord["status"] | "unavailable";

export type QuestionPrompt = {
  id: string;
  questions: Question[];
  agentId?: string;
  sessionKey?: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: QuestionPromptStatus;
  answers?: QuestionAnswers;
  submittedAnswers?: QuestionAnswers;
  answeredElsewhere: boolean;
  localResolutionConfirmed: boolean;
  locallyExpired: boolean;
  submitting: boolean;
  error: string | null;
  drafts: Map<string, QuestionDraft>;
  revision: number;
};

type QuestionPromptState = {
  client: QuestionClient | null;
  prompts: Map<string, QuestionPrompt>;
  unmatchedResolutions: Map<string, QuestionResolvedEvent>;
  revision: number;
  tickTimer: ReturnType<typeof globalThis.setTimeout> | null;
  refreshRetryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  onChange: () => void;
};

type QuestionAnswerValues = Record<string, string[]>;

const REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const MAX_HEADER_GRAPHEMES = 12;

function clampHeaderGraphemes(header: string): string {
  const segments = [...new Intl.Segmenter().segment(header)];
  if (segments.length <= MAX_HEADER_GRAPHEMES) {
    return header;
  }
  return segments
    .slice(0, MAX_HEADER_GRAPHEMES)
    .map((part) => part.segment)
    .join("");
}

function parseQuestion(value: unknown): Question | null {
  if (!isRecord(value)) {
    return null;
  }
  const questionId = readNonEmptyString(value.questionId);
  const header = typeof value.header === "string" ? value.header : null;
  const question = readNonEmptyString(value.question);
  if (!questionId || !/^[a-z][a-z0-9_]*$/.test(questionId) || header === null || !question) {
    return null;
  }
  // Clamp instead of reject: the gateway enforces the 12-cap with grapheme
  // semantics, and any re-count here (UTF-16, code points, or a second grapheme
  // impl) can disagree at the boundary and silently drop the whole prompt.
  const clampedHeader = clampHeaderGraphemes(header);
  if (!Array.isArray(value.options) || value.options.length > 4) {
    return null;
  }
  const options = value.options.flatMap((option) => {
    if (!isRecord(option)) {
      return [];
    }
    const label = readNonEmptyString(option.label);
    if (!label || (option.description !== undefined && typeof option.description !== "string")) {
      return [];
    }
    return [
      {
        label,
        ...(typeof option.description === "string" ? { description: option.description } : {}),
      },
    ];
  });
  if (options.length !== value.options.length) {
    return null;
  }
  for (const field of ["multiSelect", "isOther"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "boolean") {
      return null;
    }
  }
  return {
    questionId,
    header: clampedHeader,
    question,
    options,
    ...(value.multiSelect === true ? { multiSelect: true } : {}),
    ...(typeof value.isOther === "boolean" ? { isOther: value.isOther } : {}),
  };
}

function parseQuestionAnswers(value: unknown): QuestionAnswers | null {
  if (!isRecord(value) || !isRecord(value.answers)) {
    return null;
  }
  const answers: QuestionAnswers["answers"] = {};
  for (const [questionId, answerValue] of Object.entries(value.answers)) {
    if (!/^[a-z][a-z0-9_]*$/.test(questionId) || !Array.isArray(answerValue)) {
      return null;
    }
    if (!answerValue.every((answer) => typeof answer === "string")) {
      return null;
    }
    answers[questionId] = [...answerValue];
  }
  return { answers };
}

function questionAnswersEqual(
  left: QuestionAnswers | undefined,
  right: QuestionAnswers | undefined,
): boolean {
  if (!left || !right) {
    return false;
  }
  const leftIds = Object.keys(left.answers).toSorted();
  const rightIds = Object.keys(right.answers).toSorted();
  return (
    leftIds.length === rightIds.length &&
    leftIds.every(
      (id, index) =>
        id === rightIds[index] &&
        left.answers[id]?.length === right.answers[id]?.length &&
        left.answers[id]?.every((answer, answerIndex) =>
          Object.is(answer, right.answers[id]?.[answerIndex]),
        ),
    )
  );
}

function parseQuestionRecord(payload: unknown): QuestionRecord | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = readNonEmptyString(payload.id);
  const createdAtMs = readTimestamp(payload.createdAtMs);
  const expiresAtMs = readTimestamp(payload.expiresAtMs);
  if (!id || createdAtMs === null || expiresAtMs === null || !Array.isArray(payload.questions)) {
    return null;
  }
  if (payload.questions.length < 1 || payload.questions.length > 3) {
    return null;
  }
  const questions = payload.questions.map(parseQuestion);
  if (questions.some((question) => question === null)) {
    return null;
  }
  const questionIds = new Set(questions.map((question) => question?.questionId));
  if (questionIds.size !== questions.length) {
    return null;
  }
  const agentId = payload.agentId === undefined ? undefined : readNonEmptyString(payload.agentId);
  const sessionKey =
    payload.sessionKey === undefined ? undefined : readNonEmptyString(payload.sessionKey);
  if (
    (payload.agentId !== undefined && !agentId) ||
    (payload.sessionKey !== undefined && !sessionKey)
  ) {
    return null;
  }
  const base = {
    id,
    questions: questions as Question[],
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    createdAtMs,
    expiresAtMs,
  };
  if (payload.status === "pending") {
    return { ...base, status: "pending" };
  }
  if (payload.status === "answered") {
    const answers = parseQuestionAnswers(payload.answers);
    return answers ? { ...base, status: "answered", answers } : null;
  }
  if (payload.status === "cancelled") {
    return { ...base, status: "cancelled" };
  }
  return payload.status === "expired" ? { ...base, status: "expired" } : null;
}

function parseQuestionRequestedEvent(payload: unknown): QuestionRecord | null {
  const record = parseQuestionRecord(payload);
  return record?.status === "pending" ? record : null;
}

function parseQuestionResolvedEvent(payload: unknown): QuestionResolvedEvent | null {
  if (!isRecord(payload)) {
    return null;
  }
  const id = readNonEmptyString(payload.id);
  if (!id) {
    return null;
  }
  if (payload.status === "answered") {
    const answers = parseQuestionAnswers(payload.answers);
    return answers ? { id, status: "answered", answers } : null;
  }
  if (payload.status === "cancelled" || payload.status === "expired") {
    return { id, status: payload.status };
  }
  return null;
}

export function createQuestionPromptState(onChange: () => void): QuestionPromptState {
  return {
    client: null,
    prompts: new Map(),
    unmatchedResolutions: new Map(),
    revision: 0,
    tickTimer: null,
    refreshRetryTimer: null,
    onChange,
  };
}

function scheduleTick(state: QuestionPromptState): void {
  if (
    state.tickTimer ||
    ![...state.prompts.values()].some((prompt) => prompt.status === "pending")
  ) {
    return;
  }
  state.tickTimer = globalThis.setTimeout(() => {
    state.tickTimer = null;
    const now = Date.now();
    let changed = false;
    for (const prompt of state.prompts.values()) {
      if (prompt.status === "pending" && prompt.expiresAtMs <= now) {
        prompt.status = "expired";
        prompt.locallyExpired = true;
        prompt.submitting = false;
        prompt.error = null;
        prompt.revision = ++state.revision;
        changed = true;
      }
    }
    state.onChange();
    if (changed || [...state.prompts.values()].some((prompt) => prompt.status === "pending")) {
      scheduleTick(state);
    }
  }, 1_000);
}

function promptFromRecord(
  state: QuestionPromptState,
  record: QuestionRecord,
  previous?: QuestionPrompt,
): QuestionPrompt {
  const revision = ++state.revision;
  return {
    id: record.id,
    questions: record.questions,
    ...(record.agentId ? { agentId: record.agentId } : {}),
    ...(record.sessionKey ? { sessionKey: record.sessionKey } : {}),
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    status: record.status,
    ...(record.status === "answered" ? { answers: record.answers } : {}),
    ...(previous?.submittedAnswers ? { submittedAnswers: previous.submittedAnswers } : {}),
    answeredElsewhere:
      record.status === "answered"
        ? !(previous?.localResolutionConfirmed ?? false) && !(previous?.submitting ?? false)
        : false,
    localResolutionConfirmed: previous?.localResolutionConfirmed ?? false,
    locallyExpired: false,
    submitting:
      record.status === "pending" ||
      (record.status === "answered" && !(previous?.localResolutionConfirmed ?? false))
        ? (previous?.submitting ?? false)
        : false,
    error: record.status === "pending" ? (previous?.error ?? null) : null,
    drafts: previous?.drafts ?? new Map(),
    revision,
  };
}

function applyQuestionResolution(
  state: QuestionPromptState,
  prompt: QuestionPrompt,
  resolved: QuestionResolvedEvent,
): void {
  prompt.status = resolved.status;
  prompt.answers = resolved.status === "answered" ? resolved.answers : undefined;
  const matchesSubmittedAnswer =
    resolved.status === "answered" &&
    questionAnswersEqual(prompt.submittedAnswers, resolved.answers);
  prompt.answeredElsewhere =
    resolved.status === "answered" &&
    !prompt.localResolutionConfirmed &&
    !matchesSubmittedAnswer &&
    !prompt.submitting;
  prompt.locallyExpired = false;
  if (resolved.status !== "answered" || prompt.localResolutionConfirmed) {
    prompt.submitting = false;
  }
  prompt.error = null;
  prompt.revision = ++state.revision;
}

export function handleQuestionPromptEvent(
  state: QuestionPromptState,
  event: Pick<GatewayEventFrame, "event" | "payload">,
): boolean {
  if (event.event === "question.requested") {
    const record = parseQuestionRequestedEvent(event.payload);
    if (!record) {
      return false;
    }
    const previous = state.prompts.get(record.id);
    if (previous && previous.status !== "pending") {
      return true;
    }
    const prompt = promptFromRecord(state, record, previous);
    const unmatched = state.unmatchedResolutions.get(record.id);
    if (unmatched) {
      state.unmatchedResolutions.delete(record.id);
      applyQuestionResolution(state, prompt, unmatched);
    }
    state.prompts.set(record.id, prompt);
    scheduleTick(state);
    state.onChange();
    return true;
  }
  if (event.event !== "question.resolved") {
    return false;
  }
  const resolved = parseQuestionResolvedEvent(event.payload);
  const prompt = resolved ? state.prompts.get(resolved.id) : undefined;
  if (!resolved) {
    return false;
  }
  if (!prompt) {
    state.unmatchedResolutions.set(resolved.id, resolved);
    state.revision += 1;
    state.onChange();
    return true;
  }
  applyQuestionResolution(state, prompt, resolved);
  state.onChange();
  return true;
}

function parseQuestionListResult(value: unknown): QuestionRecord[] | null {
  if (!isRecord(value) || !Array.isArray(value.questions)) {
    return null;
  }
  const questions = value.questions.map(parseQuestionRequestedEvent);
  return questions.some((question) => question === null) ? null : (questions as QuestionRecord[]);
}

function parseQuestionGetResult(value: unknown): QuestionRecord | null {
  return isRecord(value) ? parseQuestionRecord(value.question) : null;
}

function isQuestionNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "GatewayClientRequestError" &&
    isRecord((error as Error & { details?: unknown }).details) &&
    (error as Error & { details: Record<string, unknown> }).details.reason === "QUESTION_NOT_FOUND"
  );
}

function markRecoveryUnavailable(state: QuestionPromptState, prompt: QuestionPrompt): void {
  // QUESTION_NOT_FOUND means the gateway tombstone aged out. It proves the prompt is
  // no longer actionable, but not whether it was answered, cancelled, or expired.
  prompt.status = "unavailable";
  prompt.answers = undefined;
  prompt.answeredElsewhere = false;
  prompt.localResolutionConfirmed = false;
  prompt.locallyExpired = false;
  prompt.submitting = false;
  prompt.error = null;
  prompt.revision = ++state.revision;
}

async function refreshPendingQuestions(
  state: QuestionPromptState,
  client: QuestionClient,
  isCurrentClient: () => boolean = () => state.client === client,
): Promise<boolean> {
  const startedAtRevision = state.revision;
  const listResult = await client.request("question.list", {});
  const records = parseQuestionListResult(listResult);
  if (!records || !isCurrentClient()) {
    return false;
  }
  const refreshedIds = new Set(records.map((record) => record.id));
  for (const record of records) {
    const previous = state.prompts.get(record.id);
    if (!previous || previous.revision <= startedAtRevision || previous.locallyExpired) {
      const prompt = promptFromRecord(state, record, previous);
      const unmatched = state.unmatchedResolutions.get(record.id);
      if (unmatched) {
        state.unmatchedResolutions.delete(record.id);
        applyQuestionResolution(state, prompt, unmatched);
      }
      state.prompts.set(record.id, prompt);
    }
  }
  scheduleTick(state);
  state.onChange();
  const missing: Array<{
    id: string;
    prompt: QuestionPrompt | undefined;
    revision: number;
  }> = [...state.prompts.values()]
    .filter(
      (prompt) =>
        (prompt.locallyExpired ||
          (prompt.status === "pending" && prompt.revision <= startedAtRevision)) &&
        !refreshedIds.has(prompt.id),
    )
    .map((prompt) => ({ id: prompt.id, prompt, revision: prompt.revision }));
  const missingIds = new Set(missing.map((candidate) => candidate.id));
  for (const id of state.unmatchedResolutions.keys()) {
    if (!refreshedIds.has(id) && !missingIds.has(id)) {
      missing.push({ id, prompt: undefined, revision: state.revision });
      missingIds.add(id);
    }
  }
  const missingResults = await Promise.allSettled(
    missing.map((candidate) => client.request("question.get", { id: candidate.id })),
  );
  if (!isCurrentClient()) {
    return false;
  }
  let complete = true;
  for (const [index, candidate] of missing.entries()) {
    const current = state.prompts.get(candidate.id);
    if (candidate.prompt && current !== candidate.prompt) {
      if (!current || current.status === "pending" || current.locallyExpired) {
        complete = false;
      }
      continue;
    }
    if (candidate.prompt && current?.revision !== candidate.revision && !current?.locallyExpired) {
      if (current?.status === "pending") {
        complete = false;
      }
      continue;
    }
    if (!candidate.prompt && !state.unmatchedResolutions.has(candidate.id)) {
      continue;
    }
    const missingResult = missingResults[index];
    if (
      current &&
      missingResult?.status === "rejected" &&
      isQuestionNotFoundError(missingResult.reason)
    ) {
      markRecoveryUnavailable(state, current);
      continue;
    }
    const record =
      missingResult?.status === "fulfilled" ? parseQuestionGetResult(missingResult.value) : null;
    if (record) {
      const prompt = promptFromRecord(state, record, current);
      const unmatched = state.unmatchedResolutions.get(candidate.id);
      if (unmatched) {
        state.unmatchedResolutions.delete(candidate.id);
        applyQuestionResolution(state, prompt, unmatched);
      }
      state.prompts.set(candidate.id, prompt);
      continue;
    }
    complete = false;
  }
  scheduleTick(state);
  state.onChange();
  return complete;
}

export function refreshPendingQuestionsWithRetry(
  state: QuestionPromptState,
  client: QuestionClient,
  isCurrentClient: () => boolean = () => state.client === client,
): void {
  let retryIndex = 0;
  const run = async () => {
    if (!isCurrentClient()) {
      return;
    }
    let complete: boolean;
    try {
      complete = await refreshPendingQuestions(state, client, isCurrentClient);
    } catch {
      complete = false;
    }
    if (complete || !isCurrentClient()) {
      return;
    }
    const delayMs = REFRESH_RETRY_DELAYS_MS[retryIndex];
    retryIndex = Math.min(retryIndex + 1, REFRESH_RETRY_DELAYS_MS.length - 1);
    state.refreshRetryTimer = globalThis.setTimeout(() => {
      state.refreshRetryTimer = null;
      void run();
    }, delayMs);
  };
  void run();
}

export function setQuestionPromptClient(
  state: QuestionPromptState,
  client: QuestionClient | null,
): void {
  if (state.refreshRetryTimer) {
    globalThis.clearTimeout(state.refreshRetryTimer);
    state.refreshRetryTimer = null;
  }
  state.client = client;
}

export function disposeQuestionPromptState(state: QuestionPromptState): void {
  if (state.tickTimer) {
    globalThis.clearTimeout(state.tickTimer);
    state.tickTimer = null;
  }
  if (state.refreshRetryTimer) {
    globalThis.clearTimeout(state.refreshRetryTimer);
    state.refreshRetryTimer = null;
  }
  state.client = null;
}

function buildAnswers(values: QuestionAnswerValues): QuestionAnswers {
  return {
    answers: Object.fromEntries(Object.entries(values).map(([id, answers]) => [id, [...answers]])),
  };
}

async function resolveQuestionPrompt(
  state: QuestionPromptState,
  id: string,
  resolution: { answers: QuestionAnswerValues } | { cancel: true },
): Promise<void> {
  const prompt = state.prompts.get(id);
  const client = state.client;
  if (!prompt || prompt.status !== "pending" || prompt.submitting) {
    return;
  }
  if (!client) {
    prompt.error = "Not connected. Try again after reconnecting.";
    prompt.revision = ++state.revision;
    state.onChange();
    return;
  }
  prompt.submitting = true;
  const submittedAnswers = "answers" in resolution ? buildAnswers(resolution.answers) : undefined;
  prompt.submittedAnswers = submittedAnswers;
  prompt.error = null;
  prompt.revision = ++state.revision;
  state.onChange();
  try {
    await client.request(
      "question.resolve",
      submittedAnswers ? { id, answers: submittedAnswers } : { id, cancel: true },
    );
    const current = state.prompts.get(id);
    if (!current) {
      return;
    }
    current.localResolutionConfirmed = true;
    if (current.status !== "pending") {
      current.answeredElsewhere = false;
      current.submitting = false;
    }
    current.revision = ++state.revision;
    state.onChange();
  } catch (error) {
    const current = state.prompts.get(id);
    if (!current) {
      return;
    }
    current.submitting = false;
    if (current.status === "pending") {
      current.error = error instanceof Error ? error.message : String(error);
      current.revision = ++state.revision;
      state.onChange();
      return;
    }
    if (current.status === "answered" && !current.localResolutionConfirmed) {
      current.answeredElsewhere = !questionAnswersEqual(current.submittedAnswers, current.answers);
    }
    current.revision = ++state.revision;
    state.onChange();
  }
}

export async function submitQuestionPrompt(
  state: QuestionPromptState,
  id: string,
  answers: QuestionAnswerValues,
): Promise<void> {
  await resolveQuestionPrompt(state, id, { answers });
}

export async function cancelQuestionPrompt(state: QuestionPromptState, id: string): Promise<void> {
  await resolveQuestionPrompt(state, id, { cancel: true });
}

export function listQuestionPrompts(state: QuestionPromptState): QuestionPrompt[] {
  return [...state.prompts.values()].toSorted(
    (left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id),
  );
}
