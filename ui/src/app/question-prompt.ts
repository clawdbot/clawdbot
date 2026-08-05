// Control UI module owns transient operator question state.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  Question,
  QuestionAnswers,
  QuestionRecord,
  QuestionResolveResult,
  QuestionResolvedEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayEventFrame } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import {
  publishQuestionClientResolution,
  registerQuestionClientOwner,
  requestQuestionGateway,
  unregisterQuestionClientOwner,
  type QuestionClient,
  type QuestionClientResolutionOwner,
} from "./question-prompt-client.ts";

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
  runId?: string;
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

type QuestionPromptState = QuestionClientResolutionOwner & {
  ownerClient: QuestionClient | null;
  prompts: Map<string, QuestionPrompt>;
  unmatchedResolutions: Map<string, QuestionResolvedEvent>;
  revision: number;
  tickTimer: ReturnType<typeof globalThis.setTimeout> | null;
  refreshRetryTimer: ReturnType<typeof globalThis.setTimeout> | null;
  onChange: () => void;
};

type QuestionAnswerValues = Record<string, string[]>;

const REFRESH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

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
  const runId = payload.runId === undefined ? undefined : readNonEmptyString(payload.runId);
  if (
    (payload.agentId !== undefined && !agentId) ||
    (payload.sessionKey !== undefined && !sessionKey) ||
    (payload.runId !== undefined && !runId)
  ) {
    return null;
  }
  const base = {
    id,
    questions: questions as Question[],
    ...(agentId ? { agentId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
    ...(runId ? { runId } : {}),
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

function parseQuestionResolveResult(payload: unknown): QuestionResolveResult | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (payload.status === "cancelled") {
    return { status: "cancelled" };
  }
  const answers = parseQuestionAnswers(payload.answers);
  return payload.status === "answered" && answers ? { status: "answered", answers } : null;
}

export function createQuestionPromptState(onChange: () => void): QuestionPromptState {
  const state: QuestionPromptState = {
    client: null,
    ownerClient: null,
    clientGeneration: 0,
    prompts: new Map(),
    unmatchedResolutions: new Map(),
    revision: 0,
    tickTimer: null,
    refreshRetryTimer: null,
    onChange,
    onQuestionResolution: (resolution) => recordQuestionResolution(state, resolution),
  };
  return state;
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
    ...(record.runId ? { runId: record.runId } : {}),
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

function recordQuestionResolution(
  state: QuestionPromptState,
  resolved: QuestionResolvedEvent,
): void {
  const prompt = state.prompts.get(resolved.id);
  if (prompt) {
    applyQuestionResolution(state, prompt, resolved);
  } else {
    // Broadcasts and same-client results own one fact. Gateway list/resolve are
    // synchronous; WebSocket FIFO delivers it before any later empty list response,
    // so existing hydration consumes this tombstone without a parallel recovery.
    state.unmatchedResolutions.set(resolved.id, resolved);
    state.revision += 1;
  }
  state.onChange();
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
  if (!resolved) {
    return false;
  }
  recordQuestionResolution(state, resolved);
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
    error instanceof GatewayRequestError &&
    isRecord(error.details) &&
    error.details.reason === "QUESTION_NOT_FOUND"
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
  const listResult = await requestQuestionGateway(client, "question.list", {});
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
  const recovered = await Promise.all(
    missing.map(async (candidate) => {
      const result = await requestQuestionGateway(client, "question.get", {
        id: candidate.id,
      }).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      if (!isCurrentClient()) {
        return false;
      }
      const current = state.prompts.get(candidate.id);
      if (candidate.prompt && current !== candidate.prompt) {
        return Boolean(current && current.status !== "pending" && !current.locallyExpired);
      }
      if (
        candidate.prompt &&
        current?.revision !== candidate.revision &&
        !current?.locallyExpired
      ) {
        return current?.status !== "pending";
      }
      if (!candidate.prompt && !state.unmatchedResolutions.has(candidate.id)) {
        return true;
      }
      if (!result.ok) {
        if (!isQuestionNotFoundError(result.error)) {
          return false;
        }
        if (current) {
          markRecoveryUnavailable(state, current);
        }
        // An aged-out tombstone cannot hydrate an unmatched resolution;
        // retaining it would retry an already-final reconnect forever.
        state.unmatchedResolutions.delete(candidate.id);
        state.onChange();
        return true;
      }
      const record = parseQuestionGetResult(result.value);
      if (!record) {
        return false;
      }
      const prompt = promptFromRecord(state, record, current);
      const unmatched = state.unmatchedResolutions.get(candidate.id);
      if (unmatched) {
        state.unmatchedResolutions.delete(candidate.id);
        applyQuestionResolution(state, prompt, unmatched);
      }
      state.prompts.set(candidate.id, prompt);
      scheduleTick(state);
      // Publish each settled recovery immediately; a hung sibling must never
      // withhold an already-authoritative answer until its own deadline.
      state.onChange();
      return true;
    }),
  );
  return isCurrentClient() && recovered.every(Boolean);
}

export function refreshPendingQuestionsWithRetry(
  state: QuestionPromptState,
  client: QuestionClient,
  isCurrentClient: () => boolean = () => state.client === client,
): void {
  const clientGeneration = state.clientGeneration;
  const refreshIsCurrent = () =>
    state.client === client && state.clientGeneration === clientGeneration && isCurrentClient();
  let retryIndex = 0;
  const run = async () => {
    if (!refreshIsCurrent()) {
      return;
    }
    let complete: boolean;
    try {
      complete = await refreshPendingQuestions(state, client, refreshIsCurrent);
    } catch {
      complete = false;
    }
    if (complete || !refreshIsCurrent()) {
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
  if (state.client === client) {
    return;
  }

  if (state.client) {
    unregisterQuestionClientOwner(state.client, state);
  }
  state.clientGeneration += 1;
  const ownerChanged =
    client !== null && state.ownerClient !== null && state.ownerClient !== client;
  state.client = client;
  if (client !== null) {
    state.ownerClient = client;
    registerQuestionClientOwner(client, state);
  }

  if (ownerChanged) {
    const changed = state.prompts.size > 0 || state.unmatchedResolutions.size > 0;
    if (state.tickTimer) {
      globalThis.clearTimeout(state.tickTimer);
      state.tickTimer = null;
    }
    state.prompts.clear();
    state.unmatchedResolutions.clear();
    if (changed) {
      state.revision += 1;
      state.onChange();
    }
    return;
  }

  if (client) {
    // Disposal stops the projection clock; same-owner remount must restart it
    // before async hydration so an expired question cannot strand the surface.
    scheduleTick(state);
  }
  let changed = false;
  for (const prompt of state.prompts.values()) {
    if (!prompt.submitting) {
      continue;
    }
    // The transport owns this submission. Reconnect must release its spinner
    // without discarding answers needed for authoritative recovery.
    prompt.submitting = false;
    prompt.revision = ++state.revision;
    changed = true;
  }
  if (changed) {
    state.onChange();
  }
}

export function disposeQuestionPromptState(state: QuestionPromptState): void {
  if (state.client) {
    unregisterQuestionClientOwner(state.client, state);
  }
  if (state.tickTimer) {
    globalThis.clearTimeout(state.tickTimer);
    state.tickTimer = null;
  }
  if (state.refreshRetryTimer) {
    globalThis.clearTimeout(state.refreshRetryTimer);
    state.refreshRetryTimer = null;
  }
  state.clientGeneration += 1;
  // Retained records belong to the previous client: remount on it may recover
  // them, while a different Gateway must still recognize and purge its state.
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
  const clientGeneration = state.clientGeneration;
  if (!prompt || prompt.status !== "pending" || prompt.submitting) {
    return;
  }
  if (!client) {
    prompt.error = t("chat.questions.disconnected");
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
    const result = await requestQuestionGateway(
      client,
      "question.resolve",
      submittedAnswers ? { id, answers: submittedAnswers } : { id, cancel: true },
      prompt.expiresAtMs,
    );
    const resolved = parseQuestionResolveResult(result);
    if (!resolved || resolved.status !== (submittedAnswers ? "answered" : "cancelled")) {
      throw new Error("invalid question.resolve response");
    }
    if (state.client === client && state.clientGeneration === clientGeneration) {
      const current = state.prompts.get(id);
      if (current) {
        current.localResolutionConfirmed = true;
      }
    }
    // The committed RPC result owns every same-client projection even when
    // fanout fails or its submitting pane unmounts before the response.
    publishQuestionClientResolution(client, { ...resolved, id });
  } catch (error) {
    if (state.client !== client || state.clientGeneration !== clientGeneration) {
      return;
    }
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
