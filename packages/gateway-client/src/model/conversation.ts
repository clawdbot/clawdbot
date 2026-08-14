import {
  createSessionProjection,
  isLocallyOptimisticSessionMessage,
  readSessionMessageSequence,
  reduceSessionProjection,
  reduceSessionProjectionRunEvent,
  releaseGatewaySessionMessageSubscription,
  type GatewaySessionMessageSubscription,
  type GatewaySessionMessageSubscriptionCoordinator,
  type SessionProjectionGatewayRunEvent,
  type SessionProjectionState,
} from "../browser.js";
import type { EventFrame } from "@openclaw/gateway-protocol";
import type {
  ControlModelConnectionSnapshot,
  ControlModelError,
  ControlModelGatewayBinding,
  ControlModelRequestOptions,
  DeepReadonly,
} from "./model.js";

export type ControlModelConversationStatus =
  | "idle"
  | "loading"
  | "ready"
  | "partial"
  | "stale"
  | "error"
  | "disposed";
export type ControlModelCommandCategory =
  | "disconnected"
  | "disposed"
  | "unsupported"
  | "invalid-input"
  | "stale"
  | "forbidden"
  | "conflict"
  | "not-found"
  | "timeout"
  | "aborted"
  | "retryable"
  | "malformed";

export class ControlModelCommandError extends Error {
  readonly category: ControlModelCommandCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly command: string;
  constructor(options: {
    category: ControlModelCommandCategory;
    code: string;
    message: string;
    command: string;
    retryable?: boolean;
    retryAfterMs?: number;
  }) {
    super(options.message);
    this.name = "ControlModelCommandError";
    this.category = options.category;
    this.code = options.code;
    this.retryable = options.retryable === true;
    this.retryAfterMs = options.retryAfterMs;
    this.command = options.command;
  }
}

export type ControlModelConversationMessage = Readonly<{
  key: string;
  role: string;
  sequence: number | null;
  runId: string | null;
  pending: boolean;
  live: boolean;
  provisional: boolean;
  raw: DeepReadonly<unknown>;
}>;
export type ControlModelConversationRun = Readonly<{
  runId: string;
  status: string;
  message?: DeepReadonly<unknown>;
  stopReason?: string;
  errorKind?: string;
  errorMessage?: string;
}>;
export type ControlModelToolStatus = "running" | "succeeded" | "failed" | "cancelled" | "unknown";
export type ControlModelConversationTool = Readonly<{
  key: string;
  runId: string;
  toolCallId: string;
  name: string | null;
  status: ControlModelToolStatus;
  phase: string;
  input: DeepReadonly<unknown> | null;
  output: DeepReadonly<unknown> | null;
  truncated: boolean;
  progress: Readonly<{ updates: number; bytes: number; truncated: boolean }>;
}>;
export type ControlModelConversationApproval = DeepReadonly<Record<string, unknown>> &
  Readonly<{
    id: string;
    status: string;
    presentation?: DeepReadonly<Record<string, unknown>>;
  }>;
export type ControlModelConversationQuestion = DeepReadonly<Record<string, unknown>> &
  Readonly<{ id: string; status: string }>;
export type ControlModelConversationBounds = Readonly<{
  maxSubscribers: number;
  maxMessages: number;
  maxRuns: number;
  maxTools: number;
  maxApprovals: number;
  maxQuestions: number;
  maxProgressUpdates: number;
  maxProgressBytes: number;
}>;
export type ControlModelConversationHistory = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  hasMore: boolean;
  nextOffset: number | null;
  totalMessages: number | null;
  completeSnapshot: boolean;
  window: "newest" | "older";
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  revision: number;
  error: ControlModelError | null;
}>;

export type ControlModelConversationSnapshot = Readonly<{
  sessionKey: string;
  status: ControlModelConversationStatus;
  revision: number;
  historyRevision: number;
  connection: ControlModelConnectionSnapshot;
  history: ControlModelConversationHistory;
  messages: readonly ControlModelConversationMessage[];
  runs: readonly ControlModelConversationRun[];
  activeRun: ControlModelConversationRun | null;
  tools: readonly ControlModelConversationTool[];
  approvals: readonly ControlModelConversationApproval[];
  questions: readonly ControlModelConversationQuestion[];
  partialReasons: readonly string[];
  stale: boolean;
  hasTransportGap: boolean;
  commandAvailability: Readonly<{
    send: boolean;
    abort: boolean;
    resolveApproval: boolean;
    answerQuestion: boolean;
    cancelQuestion: boolean;
  }>;
  bounds: Readonly<{
    messagesTruncated: boolean;
    runsTruncated: boolean;
    toolsTruncated: boolean;
    approvalsTruncated: boolean;
    questionsTruncated: boolean;
  }>;
}>;

export type ControlModelSendInput =
  | string
  | Readonly<{
      message?: string;
      content?: string;
      attachments?: readonly unknown[];
      idempotencyKey?: string;
      thinking?: string;
      fastMode?: boolean | "auto";
      fastAutoOnSeconds?: number;
      queueMode?: string;
      replyToId?: string;
      toolBindings?: Readonly<Record<string, unknown>>;
      timeoutMs?: number;
      expectedLeafEntryId?: string | null;
      expectedRunId?: string;
      suppressCommandInterpretation?: boolean;
    }>;
export type ControlModelSendResult = Readonly<{
  runId: string | null;
  status: string;
  idempotencyKey: string;
}>;
export type ControlModelConversationSubscriber = () => void | Promise<void>;

export type ControlModelGatewayEventFrame = Readonly<
  EventFrame & {
  connectionEpoch: number;
  gap?: boolean | Readonly<Record<string, unknown>>;
  }
>;
export type ControlModelConversationHost = Readonly<{
  gateway: ControlModelGatewayBinding;
  agentId?: string;
  getConnectionSnapshot(): ControlModelConnectionSnapshot;
  isRunning(): boolean;
  getMessageSubscriptionCoordinator(): GatewaySessionMessageSubscriptionCoordinator;
  onConversationReleased(conversation: ControlModelConversation): Promise<void>;
  now(): number;
  generateId(prefix: string): string;
  reportSubscriberError(error: unknown): void;
  reportBackgroundError(error: unknown): void;
  bounds: ControlModelConversationBounds;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
function safeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
function stableStringify(value: unknown, seen = new WeakSet<object>()): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item, seen)).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key], seen)}`,
    )
    .join(",")}}`;
}
function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}
function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing as T;
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) clone.push(cloneAndFreeze(item, seen));
    return Object.freeze(clone) as T;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) clone[key] = cloneAndFreeze(item, seen);
  return Object.freeze(clone) as T;
}
function normalizeGatewayError(error: unknown, command: string): ControlModelCommandError {
  if (error instanceof ControlModelCommandError) return error;
  const source = record(error);
  const details = record(source?.details);
  const rawCode = text(source?.code) ?? text(source?.gatewayCode) ?? "CONTROL_MODEL_REQUEST_FAILED";
  const code = rawCode.slice(0, 80);
  const lower = `${rawCode} ${text(details?.reason) ?? ""}`.toLowerCase();
  const message = (
    text(error instanceof Error ? error.message : source?.message) ?? "Gateway request failed"
  ).slice(0, 240);
  let category: ControlModelCommandCategory = "malformed";
  const isAbortException =
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError";
  if (
    isAbortException ||
    (error instanceof Error && error.name === "AbortError") ||
    lower === "aborterror"
  )
    category = "aborted";
  else if (lower.includes("forbidden") || lower === "unauthorized") category = "forbidden";
  else if (lower.includes("invalid")) category = "invalid-input";
  else if (lower.includes("not_found") || lower.includes("not-found")) category = "not-found";
  else if (lower.includes("timeout") || lower === "deadline_exceeded") category = "timeout";
  else if (lower.includes("abort") || lower.includes("cancel")) category = "aborted";
  else if (
    lower.includes("conflict") ||
    lower.includes("already_resolved") ||
    lower.includes("stale")
  )
    category = "conflict";
  else if (lower.includes("disconnected")) category = "disconnected";
  else if (lower === "unavailable") category = "retryable";
  else if (source?.retryable === true) category = "retryable";
  const retryAfterMs = safeInteger(source?.retryAfterMs ?? details?.retryAfterMs);
  return new ControlModelCommandError({
    category,
    code,
    message,
    command,
    retryable:
      source?.retryable === true ||
      category === "timeout" ||
      category === "retryable" ||
      category === "disconnected",
    ...(retryAfterMs !== null && retryAfterMs >= 0 ? { retryAfterMs } : {}),
  });
}
function localError(
  category: ControlModelCommandCategory,
  command: string,
  message: string,
  code = category.toUpperCase(),
): ControlModelCommandError {
  return new ControlModelCommandError({ category, command, code, message });
}
function connectionError(
  command: string,
  connection: ControlModelConnectionSnapshot,
): ControlModelCommandError {
  return new ControlModelCommandError({
    category: "disconnected",
    command,
    code:
      connection.status === "connecting" || connection.status === "reconnecting"
        ? "NOT_READY"
        : "UNAVAILABLE",
    message: "Gateway connection is not ready",
    retryable: true,
  });
}
const TOOL_VALUE_TRUNCATION_MARKER = Object.freeze({
  kind: "truncated",
  reason: "max-progress-bytes",
});

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
function truncateStringToSerializedBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 2) return "";
  let result = "";
  let bytes = 2;
  for (const character of value) {
    const encodedCharacter = JSON.stringify(character).slice(1, -1);
    const characterBytes = byteLength(encodedCharacter);
    if (bytes + characterBytes > maxBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}
function boundedValue(
  value: unknown,
  maxBytes: number,
): { value: unknown; bytes: number; truncated: boolean } {
  const limit = Math.max(0, maxBytes);
  const encoded = stableStringify(value);
  const bytes = byteLength(encoded);
  if (bytes <= limit) return { value, bytes, truncated: false };
  if (typeof value === "string") {
    const truncated = truncateStringToSerializedBytes(value, limit);
    return {
      value: truncated,
      bytes: Math.min(limit, byteLength(JSON.stringify(truncated))),
      truncated: true,
    };
  }
  return {
    value: TOOL_VALUE_TRUNCATION_MARKER,
    bytes: Math.min(limit, byteLength(stableStringify(TOOL_VALUE_TRUNCATION_MARKER))),
    truncated: true,
  };
}
function normalizeStatus(value: unknown): string {
  return text(value)?.toLowerCase() ?? "unknown";
}

export class ControlModelConversation {
  readonly #host: ControlModelConversationHost;
  readonly #sessionKey: string;
  #canonicalSessionKey: string;
  readonly #subscribers = new Set<ControlModelConversationSubscriber>();
  readonly #tools = new Map<
    string,
    {
      runId: string;
      toolCallId: string;
      name: string | null;
      status: ControlModelToolStatus;
      phase: string;
      input: unknown;
      output: unknown;
      truncated: boolean;
      inputTruncated: boolean;
      outputTruncated: boolean;
      inputBytes: number;
      outputBytes: number;
      updates: number;
      bytes: number;
      progressTruncated: boolean;
    }
  >();
  readonly #approvals = new Map<string, Record<string, unknown>>();
  readonly #questions = new Map<string, Record<string, unknown>>();
  #projection: SessionProjectionState;
  #snapshot: ControlModelConversationSnapshot;
  #connection: ControlModelConnectionSnapshot;
  #status: ControlModelConversationStatus = "idle";
  #historyStatus: ControlModelConversationHistory["status"] = "idle";
  #historyError: ControlModelError | null = null;
  #historyMessages: unknown[] = [];
  #historyNextOffset: number | null = null;
  #historyHasMore = false;
  #historyTotalMessages: number | null = null;
  #historyCompleteSnapshot = false;
  #historyWindow: "newest" | "older" = "newest";
  #historyTruncatedBefore = false;
  #historyTruncatedAfter = false;
  #historyRevision = 0;
  #revision = 0;
  #partialReasons = new Set<string>();
  #leases: {
    plain: GatewaySessionMessageSubscription | null;
    approvals: GatewaySessionMessageSubscription | null;
  } = { plain: null, approvals: null };
  #activationEpoch: number | null = null;
  #activationGeneration = 0;
  #activation: Promise<void> | null = null;
  #historyLoop: Promise<void> | null = null;
  #historyRequested = false;
  #historyOffsetRequested = 0;
  #historyOptions: ControlModelRequestOptions | undefined;
  #questionHydration: Promise<void> | null = null;
  #activeOperations = 0;
  #disposed = false;
  #notificationScheduled = false;
  #lastUsed = 0;
  #boundsTruncated = {
    messages: false,
    runs: false,
    tools: false,
    approvals: false,
    questions: false,
  };

  constructor(host: ControlModelConversationHost, sessionKey: string) {
    this.#host = host;
    this.#sessionKey = sessionKey;
    this.#canonicalSessionKey = sessionKey;
    this.#connection = host.getConnectionSnapshot();
    this.#projection = createSessionProjection({
      sessionKey,
      ...(host.agentId ? { agentId: host.agentId } : {}),
    });
    this.#lastUsed = host.now();
    this.#snapshot = this.#buildSnapshot();
  }

  get sessionKey(): string {
    return this.#sessionKey;
  }
  get lastUsed(): number {
    return this.#lastUsed;
  }
  get hasSubscribers(): boolean {
    return this.#subscribers.size > 0;
  }
  get hasActiveOperations(): boolean {
    return this.#activeOperations > 0 || this.#activation !== null || this.#historyLoop !== null;
  }
  get isEvictable(): boolean {
    return !this.#disposed && !this.hasSubscribers && !this.hasActiveOperations;
  }

  getSnapshot(): ControlModelConversationSnapshot {
    this.#lastUsed = this.#host.now();
    return this.#snapshot;
  }

  subscribe(subscriber: ControlModelConversationSubscriber): () => void {
    this.#assertNotDisposed();
    if (this.#subscribers.size >= this.#host.bounds.maxSubscribers)
      throw localError(
        "conflict",
        "subscribe",
        "Conversation subscriber limit reached",
        "SUBSCRIBER_LIMIT",
      );
    this.#subscribers.add(subscriber);
    this.#lastUsed = this.#host.now();
    return () => this.#subscribers.delete(subscriber);
  }

  startIfNeeded(): void {
    if (this.#disposed || !this.#host.isRunning()) return;
    const connection = this.#host.getConnectionSnapshot();
    this.#connection = connection;
    if (connection.status !== "connected") {
      this.#status = this.#status === "idle" ? "idle" : "stale";
      this.#publish();
      return;
    }
    this.onConnection(connection, this.#host.getMessageSubscriptionCoordinator());
  }

  onConnection(
    connection: ControlModelConnectionSnapshot,
    coordinator: GatewaySessionMessageSubscriptionCoordinator,
  ): void {
    if (this.#disposed) return;
    this.#connection = connection;
    if (this.#activationEpoch === connection.epoch) return;
    this.#releaseLeases();
    this.#canonicalSessionKey = this.#sessionKey;
    this.#activationGeneration += 1;
    const generation = this.#activationGeneration;
    this.#activationEpoch = connection.epoch;
    this.#projection = { ...this.#projection, runs: {} };
    this.#tools.clear();
    this.#status = this.#projection.entries.length > 0 ? "stale" : "loading";
    this.#partialReasons.add("reconnect-awaiting-authoritative-history");
    this.#publish();
    this.#activation = (async () => {
      try {
        const plain = await coordinator.acquire(
          this.#sessionKey,
          this.#host.agentId ? { agentId: this.#host.agentId } : {},
        );
        if (generation !== this.#activationGeneration || this.#disposed) {
          void releaseGatewaySessionMessageSubscription(plain);
          return;
        }
        this.#leases.plain = plain;
        this.#canonicalSessionKey = plain.key;
        try {
          const approvals = await coordinator.acquire(this.#sessionKey, {
            ...(this.#host.agentId ? { agentId: this.#host.agentId } : {}),
            includeApprovals: true,
          });
          if (generation !== this.#activationGeneration || this.#disposed) {
            void releaseGatewaySessionMessageSubscription(approvals);
            return;
          }
          this.#leases.approvals = approvals;
          this.#partialReasons.delete("approvals-unavailable");
          this.#applyApprovalReplay(approvals.approvalReplay);
        } catch (error) {
          this.#partialReasons.add("approvals-unavailable");
          this.#host.reportBackgroundError(
            normalizeGatewayError(error, "sessions.messages.subscribe"),
          );
          this.#publish();
        }
        await Promise.allSettled([this.refreshHistory(), this.#hydrateQuestions(connection.epoch)]);
      } catch (error) {
        if (generation === this.#activationGeneration && !this.#disposed) {
          this.#activationEpoch = null;
          this.#status = "error";
          this.#historyError = normalizeGatewayError(error, "sessions.messages.subscribe");
          this.#publish();
          this.#host.reportBackgroundError(error);
        }
      } finally {
        if (generation === this.#activationGeneration) this.#activation = null;
      }
    })();
    void this.#activation.catch(() => undefined);
  }

  handleEvent(frame: ControlModelGatewayEventFrame): void {
    if (this.#disposed) return;
    const connection = this.#host.getConnectionSnapshot();
    this.#connection = connection;
    if (connection.status !== "connected" || frame.connectionEpoch !== connection.epoch) return;
    const payload = record(frame.payload);
    const hasGap =
      (frame.gap !== undefined && frame.gap !== false) ||
      (payload?.gap !== undefined && payload.gap !== false);
    if (hasGap) {
      this.#partialReasons.add("transport-gap");
      this.#status = "partial";
      this.#applyProjection({ type: "transportGap", scope: { sessionKey: this.#sessionKey } });
      this.#scheduleHistoryRefresh();
      void this.#hydrateQuestions(frame.connectionEpoch);
    }
    if (!payload || !this.#eventMatches(payload, frame.event)) return;
    switch (frame.event) {
      case "chat":
        this.#handleChat(payload);
        break;
      case "session.message":
        if (payload.message !== undefined)
          this.#applyProjection({
            type: "messagePersisted",
            message: payload.message,
            envelope: payload,
            scope: { sessionKey: this.#sessionKey },
          });
        else this.#scheduleHistoryRefresh();
        break;
      case "sessions.changed":
        if (
          payload.reason !== "reset" &&
          payload.phase !== "reset" &&
          payload.change !== "reset" &&
          payload.reset !== true
        )
          break;
        this.#applyProjection({ type: "sessionReset", scope: { sessionKey: this.#sessionKey } });
        this.#partialReasons.add("session-reset-awaiting-history");
        this.#status = "partial";
        this.#scheduleHistoryRefresh();
        break;
      case "agent":
        this.#handleAgent(payload);
        break;
      case "session.approval":
        this.#upsertApproval(payload.approval ?? payload);
        break;
      case "question.requested":
        this.#upsertQuestion(payload.question ?? payload);
        break;
      case "question.resolved":
        this.#resolveQuestionEvent(payload);
        break;
      default:
        break;
    }
  }

  onDisconnected(connection: ControlModelConnectionSnapshot): void {
    if (this.#disposed) return;
    this.#connection = connection;
    this.#activationGeneration += 1;
    this.#activationEpoch = null;
    this.#activation = null;
    this.#releaseLeases();
    this.#status = "stale";
    this.#partialReasons.add("disconnected");
    this.#publish();
  }

  async refreshHistory(options?: ControlModelRequestOptions): Promise<void> {
    this.#assertCommandReady("chat.history");
    this.#historyRequested = true;
    this.#historyOffsetRequested = 0;
    if (options !== undefined || this.#historyOptions === undefined) {
      this.#historyOptions = options;
    }
    if (!this.#historyLoop) {
      const loop = this.#drainHistory().finally(() => {
        if (this.#historyLoop === loop) this.#historyLoop = null;
      });
      this.#historyLoop = loop;
    }
    return this.#historyLoop;
  }

  async loadMoreHistory(options?: ControlModelRequestOptions): Promise<void> {
    this.#assertCommandReady("chat.history");
    if (!this.#historyHasMore || this.#historyNextOffset === null)
      throw localError(
        "conflict",
        "chat.history",
        "No older history is available",
        "NO_MORE_HISTORY",
      );
    if (this.#historyLoop)
      throw localError(
        "conflict",
        "chat.history",
        "A history operation is already in progress",
        "HISTORY_BUSY",
      );
    this.#historyRequested = true;
    this.#historyOffsetRequested = this.#historyNextOffset;
    this.#historyOptions = options;
    const loop = this.#drainHistory().finally(() => {
      if (this.#historyLoop === loop) this.#historyLoop = null;
    });
    this.#historyLoop = loop;
    return loop;
  }

  async send(
    input: ControlModelSendInput,
    options?: ControlModelRequestOptions,
  ): Promise<ControlModelSendResult> {
    this.#assertCommandReady("chat.send");
    const normalized = this.#normalizeSendInput(input);
    const idempotencyKey =
      text(normalized.idempotencyKey) ??
      text(this.#host.generateId("send")) ??
      this.#host.generateId("send");
    const message = {
      role: "user",
      content: normalized.message,
      ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
      __openclaw: { idempotencyKey },
    };
    this.#applyProjection({
      type: "sendPending",
      message,
      idempotencyKey,
      scope: { sessionKey: this.#sessionKey },
    });
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#captureEpoch("chat.send");
      const response = await this.#host.gateway.request<Record<string, unknown>>(
        "chat.send",
        {
          sessionKey: this.#sessionKey,
          ...(this.#host.agentId ? { agentId: this.#host.agentId } : {}),
          message: normalized.message,
          deliver: false,
          idempotencyKey,
          ...(normalized.attachments ? { attachments: normalized.attachments } : {}),
          ...this.#sendOptions(normalized),
        },
        options,
      );
      this.#assertEpoch(epoch, "chat.send");
      const runId = text(response?.runId) ?? null;
      this.#applyProjection({
        type: "sendAcknowledged",
        idempotencyKey: runId ?? idempotencyKey,
        previousRunId: idempotencyKey,
        scope: { sessionKey: this.#sessionKey },
      });
      return Object.freeze({ runId, status: text(response?.status) ?? "accepted", idempotencyKey });
    } catch (error) {
      const normalized = this.#asCommandErrorForEpoch(error, "chat.send", epoch);
      if (normalized.category !== "stale")
        this.#applyProjection({
          type: "sendFailed",
          runId: idempotencyKey,
          scope: { sessionKey: this.#sessionKey },
        });
      throw normalized;
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async abort(
    runId?: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#assertCommandReady("chat.abort");
    const target = text(runId) ?? this.#activeRunId();
    if (!target)
      throw localError("conflict", "chat.abort", "No active run is available", "NO_ACTIVE_RUN");
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#captureEpoch("chat.abort");
      const result = await this.#host.gateway.request<Record<string, unknown>>(
        "chat.abort",
        {
          sessionKey: this.#sessionKey,
          ...(this.#host.agentId ? { agentId: this.#host.agentId } : {}),
          runId: target,
        },
        options,
      );
      this.#assertEpoch(epoch, "chat.abort");
      const abortedRunIds = Array.isArray(result?.runIds)
        ? result.runIds.filter((value): value is string => typeof value === "string")
        : [];
      if (result?.aborted === true || abortedRunIds.includes(target))
        this.#applyProjection({
          type: "runTerminal",
          runId: target,
          status: "aborted",
          scope: { sessionKey: this.#sessionKey },
        });
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
    this.#assertCommandReady("approval.resolve");
    const approvalId = text(id);
    const requestedDecision = text(decision);
    if (!approvalId || !requestedDecision)
      throw localError(
        "invalid-input",
        "approval.resolve",
        "Approval id and decision are required",
        "INVALID_APPROVAL_INPUT",
      );
    const approval = this.#approvals.get(approvalId);
    if (!approval)
      throw localError(
        "not-found",
        "approval.resolve",
        "Approval was not found",
        "APPROVAL_NOT_FOUND",
      );
    if (normalizeStatus(approval.status) !== "pending")
      throw localError(
        "conflict",
        "approval.resolve",
        "Approval is no longer pending",
        "APPROVAL_ALREADY_RESOLVED",
      );
    const presentation = record(approval.presentation);
    const allowed = Array.isArray(presentation?.allowedDecisions)
      ? presentation.allowedDecisions
      : [];
    if (!allowed.includes(requestedDecision))
      throw localError("forbidden", "approval.resolve", "Decision is not allowed", "FORBIDDEN");
    const kind = text(presentation?.kind);
    if (!kind)
      throw localError(
        "malformed",
        "approval.resolve",
        "Approval presentation is malformed",
        "MALFORMED_APPROVAL",
      );
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#captureEpoch("approval.resolve");
      const result = await this.#host.gateway.request<Record<string, unknown>>(
        "approval.resolve",
        { id: approvalId, kind, decision: requestedDecision },
        options,
      );
      this.#assertEpoch(epoch, "approval.resolve");
      if (record(result)?.approval) this.#upsertApproval(record(result)?.approval);
      else
        this.#upsertApproval({
          ...approval,
          status: requestedDecision === "deny" ? "denied" : "allowed",
          decision: requestedDecision,
        });
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

  async release(): Promise<void> {
    await this.#host.onConversationReleased(this);
  }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activationGeneration += 1;
    this.#status = "disposed";
    this.#releaseLeases();
    this.#subscribers.clear();
    this.#publish();
  }

  #normalizeSendInput(input: ControlModelSendInput): Record<string, unknown> & {
    message: string;
    attachments?: readonly unknown[];
    idempotencyKey?: string;
  } {
    const value =
      typeof input === "string"
        ? { message: input }
        : (record(input) ?? ({} as Record<string, unknown>));
    const message = text(value.message) ?? text(value.content) ?? "";
    const attachments = Array.isArray(value.attachments) ? value.attachments : undefined;
    if (!message && (!attachments || attachments.length === 0))
      throw localError(
        "invalid-input",
        "chat.send",
        "Message or attachment is required",
        "EMPTY_MESSAGE",
      );
    return { ...value, message, ...(attachments ? { attachments } : {}) };
  }
  #sendOptions(input: Record<string, unknown>): Record<string, unknown> {
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
      if (input[key] !== undefined) result[key] = input[key];
    }
    return result;
  }

  async #drainHistory(): Promise<void> {
    let firstError: unknown;
    while (this.#historyRequested && !this.#disposed) {
      this.#historyRequested = false;
      const options = this.#historyOptions;
      this.#historyOptions = undefined;
      try {
        await this.#refreshHistoryOnce(this.#historyOffsetRequested, options);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  async #refreshHistoryOnce(offset: number, options?: ControlModelRequestOptions): Promise<void> {
    if (this.#disposed) return;
    const epoch = this.#captureEpoch("chat.history");
    this.#historyStatus = "loading";
    this.#historyError = null;
    this.#status = "loading";
    this.#publish();
    try {
      const response = await this.#host.gateway.request<Record<string, unknown>>(
        "chat.history",
        {
          sessionKey: this.#sessionKey,
          ...(this.#host.agentId ? { agentId: this.#host.agentId } : {}),
          limit: this.#host.bounds.maxMessages,
          ...(offset > 0 ? { offset } : {}),
        },
        options,
      );
      this.#assertEpoch(epoch, "chat.history");
      const page = Array.isArray(response?.messages) ? response.messages : [];
      const mergedHistory = this.#mergeHistory(
        offset > 0 ? [...page, ...this.#historyMessages] : page,
      );
      const maxMessages = this.#host.bounds.maxMessages;
      const locallyTruncated = mergedHistory.length > maxMessages;
      this.#historyWindow = offset > 0 ? "older" : "newest";
      this.#historyMessages = locallyTruncated
        ? this.#historyWindow === "older"
          ? mergedHistory.slice(0, maxMessages)
          : mergedHistory.slice(-maxMessages)
        : mergedHistory;
      this.#projection = reduceSessionProjection(this.#projection, {
        type: "snapshotLoaded",
        messages: this.#historyMessages,
        scope: { sessionKey: this.#sessionKey },
      });
      this.#restoreInFlightRun(response?.inFlightRun);
      this.#boundProjectionEntries();
      const nextOffset = safeInteger(response?.nextOffset);
      this.#historyHasMore =
        response?.hasMore === true && nextOffset !== null && nextOffset > offset;
      this.#historyNextOffset = this.#historyHasMore ? nextOffset : null;
      const total = safeInteger(response?.totalMessages);
      if (total !== null && total >= 0) this.#historyTotalMessages = total;
      const projectionOverflow = this.#projection.entries.length > maxMessages;
      this.#historyTruncatedBefore =
        this.#historyHasMore || (this.#historyWindow === "newest" && projectionOverflow);
      this.#historyTruncatedAfter =
        this.#historyWindow === "older" && (locallyTruncated || projectionOverflow);
      const sourceComplete = response?.completeSnapshot === true || !this.#historyHasMore;
      this.#historyCompleteSnapshot =
        sourceComplete && !this.#historyTruncatedBefore && !this.#historyTruncatedAfter;
      this.#historyRevision += 1;
      this.#historyStatus = "ready";
      this.#historyError = null;
      this.#partialReasons.delete("reconnect-awaiting-authoritative-history");
      this.#partialReasons.delete("session-reset-awaiting-history");
      this.#partialReasons.delete("transport-gap");
      this.#partialReasons.delete("disconnected");
      if (this.#historyTruncatedBefore || this.#historyTruncatedAfter) {
        this.#boundsTruncated.messages = true;
        this.#partialReasons.add("messages-truncated");
      } else {
        this.#boundsTruncated.messages = false;
        this.#partialReasons.delete("messages-truncated");
      }
      this.#status = this.#partialReasons.size > 0 ? "partial" : "ready";
      this.#publish();
    } catch (error) {
      const normalized = this.#asCommandErrorForEpoch(error, "chat.history", epoch);
      if (normalized.category === "stale") throw normalized;
      this.#historyStatus = "error";
      this.#historyError = {
        code: normalized.code,
        message: normalized.message,
        retryable: normalized.retryable,
      };
      this.#status = "error";
      this.#publish();
      throw normalized;
    }
  }

  #mergeHistory(messages: readonly unknown[]): unknown[] {
    const seen = new Set<string>();
    const merged: unknown[] = [];
    for (const message of messages) {
      const value = record(message);
      const metadata = record(value?.__openclaw);
      const role = text(value?.role) ?? "unknown";
      const id = text(metadata?.id) ?? text(value?.id);
      const sequence = readSessionMessageSequence(message);
      const idempotencyKey = text(metadata?.idempotencyKey);
      const key = id
        ? `id:${role}:${id}`
        : sequence !== null
          ? `seq:${role}:${sequence}`
          : idempotencyKey
            ? `idempotency:${role}:${idempotencyKey}`
            : `content:${hash(stableStringify(message))}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(message);
    }
    const sequences = merged.map((message) => readSessionMessageSequence(message));
    return sequences.every((sequence) => sequence !== null)
      ? merged
          .map((message, index) => ({ message, sequence: sequences[index] ?? 0 }))
          .sort((left, right) => left.sequence - right.sequence)
          .map(({ message }) => message)
      : merged;
  }

  #captureEpoch(command: string): number {
    this.#assertNotDisposed();
    const connection = this.#host.getConnectionSnapshot();
    if (connection.status !== "connected") throw connectionError(command, connection);
    this.#connection = connection;
    return connection.epoch;
  }
  #assertEpoch(epoch: number, command: string): void {
    const current = this.#host.getConnectionSnapshot();
    this.#connection = current;
    if (this.#disposed || current.status !== "connected" || current.epoch !== epoch)
      throw localError(
        "stale",
        command,
        "Gateway response belongs to a retired connection",
        "STALE_EPOCH",
      );
  }
  #assertCommandReady(command: string): void {
    this.#assertNotDisposed();
    const connection = this.#host.getConnectionSnapshot();
    this.#connection = connection;
    if (!this.#host.isRunning())
      throw localError("disconnected", command, "Control Model is not running", "NOT_READY");
    if (connection.status !== "connected") throw connectionError(command, connection);
  }
  #assertNotDisposed(): void {
    if (this.#disposed)
      throw localError("disposed", "conversation", "Conversation has been disposed", "DISPOSED");
  }
  #asCommandErrorForEpoch(
    error: unknown,
    command: string,
    epoch: number | null,
  ): ControlModelCommandError {
    if (epoch !== null) {
      const current = this.#host.getConnectionSnapshot();
      this.#connection = current;
      if (current.status !== "connected" || current.epoch !== epoch)
        return localError(
          "stale",
          command,
          "Gateway request belongs to a retired connection",
          "STALE_EPOCH",
        );
    }
    return this.#asCommandError(error, command);
  }
  #asCommandError(error: unknown, command: string): ControlModelCommandError {
    return error instanceof ControlModelCommandError
      ? error
      : normalizeGatewayError(error, command);
  }

  async #resolveQuestion(
    id: string,
    body: Record<string, unknown>,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    this.#assertCommandReady("question.resolve");
    const questionId = text(id);
    if (!questionId)
      throw localError(
        "invalid-input",
        "question.resolve",
        "Question id is required",
        "INVALID_QUESTION_INPUT",
      );
    const question = this.#questions.get(questionId);
    if (!question)
      throw localError(
        "not-found",
        "question.resolve",
        "Question was not found",
        "QUESTION_NOT_FOUND",
      );
    if (normalizeStatus(question.status) !== "pending")
      throw localError(
        "conflict",
        "question.resolve",
        "Question is no longer pending",
        "QUESTION_ALREADY_RESOLVED",
      );
    this.#activeOperations += 1;
    let epoch: number | null = null;
    try {
      epoch = this.#captureEpoch("question.resolve");
      const result = await this.#host.gateway.request<Record<string, unknown>>(
        "question.resolve",
        { id: questionId, ...body },
        options,
      );
      this.#assertEpoch(epoch, "question.resolve");
      const status = text(result?.status) ?? ("cancel" in body ? "cancelled" : "answered");
      this.#upsertQuestion({ ...question, ...result, status });
      return cloneAndFreeze(result ?? { status });
    } catch (error) {
      throw this.#asCommandErrorForEpoch(error, "question.resolve", epoch);
    } finally {
      this.#activeOperations -= 1;
    }
  }

  async #hydrateQuestions(epoch: number): Promise<void> {
    if (this.#disposed || this.#questionHydration)
      return this.#questionHydration ?? Promise.resolve();
    const promise = (async () => {
      try {
        const result = await this.#host.gateway.request<Record<string, unknown>>(
          "question.list",
          {},
          undefined,
        );
        const current = this.#host.getConnectionSnapshot();
        if (this.#disposed || current.epoch !== epoch || current.status !== "connected") return;
        this.#partialReasons.delete("questions-unavailable");
        const questions = Array.isArray(result?.questions) ? result.questions : [];
        const pendingIds = new Set<string>();
        for (const question of questions)
          if (this.#eventMatches(record(question) ?? {}, "question.requested")) {
            const id = text(record(question)?.id);
            if (id) pendingIds.add(id);
            this.#upsertQuestion(question);
          }
        for (const [id, question] of this.#questions)
          if (normalizeStatus(question.status) === "pending" && !pendingIds.has(id))
            this.#questions.delete(id);
        this.#publish();
      } catch (error) {
        const current = this.#host.getConnectionSnapshot();
        if (!this.#disposed && current.status === "connected" && current.epoch === epoch) {
          this.#partialReasons.add("questions-unavailable");
          this.#host.reportBackgroundError(this.#asCommandError(error, "question.list"));
          this.#publish();
        }
      }
    })();
    const tracked = promise.finally(() => {
      if (this.#questionHydration === tracked) this.#questionHydration = null;
    });
    this.#questionHydration = tracked;
    return tracked;
  }
  #scheduleHistoryRefresh(): void {
    if (this.#disposed || this.#connection.status !== "connected") return;
    this.#historyRequested = true;
    this.#historyOffsetRequested = 0;
    if (this.#historyLoop) return;
    queueMicrotask(() => {
      if (this.#disposed || !this.#historyRequested || this.#historyLoop) return;
      void this.refreshHistory().catch((error) => {
        if (!(error instanceof ControlModelCommandError && error.category === "stale"))
          this.#host.reportBackgroundError(error);
      });
    });
  }
  #eventSessionKey(payload: Record<string, unknown>): string | null {
    for (const value of [
      payload,
      record(payload.data),
      record(payload.presentation),
      record(payload.approval),
      record(record(payload.approval)?.presentation),
      record(payload.question),
      record(payload.message),
    ]) {
      const key = text(value?.sessionKey) ?? text(value?.key) ?? text(value?.sourceSessionKey);
      if (key) return key;
    }
    return null;
  }
  #eventMatches(payload: Record<string, unknown>, event?: string): boolean {
    const eventAgentId = this.#eventAgentId(payload);
    if (
      this.#host.agentId &&
      eventAgentId &&
      eventAgentId.toLowerCase() !== this.#host.agentId.toLowerCase()
    )
      return false;
    const key = this.#eventSessionKey(payload);
    if (key) return key === this.#sessionKey || key === this.#canonicalSessionKey;
    const data = record(payload.data);
    const runId = text(payload.runId) ?? text(data?.runId);
    if (event === "agent") return Boolean(runId && this.#projection.runs[runId]);
    if (
      event === "question.resolved" &&
      payload.id !== undefined &&
      this.#questions.has(text(payload.id) ?? "")
    )
      return true;
    return Boolean(runId && this.#projection.runs[runId]);
  }

  #handleChat(payload: Record<string, unknown>): void {
    const state = text(payload.state);
    const runId = text(payload.runId);
    if (!runId) return;
    if (state === "status") {
      this.#applyProjection({ type: "runDelta", runId, scope: { sessionKey: this.#sessionKey } });
      return;
    }
    const transition = reduceSessionProjectionRunEvent(
      this.#projection,
      payload as SessionProjectionGatewayRunEvent,
      { sessionKey: this.#sessionKey },
    );
    if (!transition) return;
    this.#projection = transition.projection;
    this.#boundProjectionEntries();
    this.#publish();
  }

  #handleAgent(payload: Record<string, unknown>): void {
    const stream = text(payload.stream);
    const data = record(payload.data) ?? payload;
    if (stream !== "tool" && stream !== "item" && stream !== "command_output") return;
    const runId = text(payload.runId) ?? text(data.runId);
    if (!runId) return;
    if (!this.#eventSessionKey(payload) && !this.#projection.runs[runId]) return;
    const toolCallId =
      text(data.toolCallId) ?? text(data.tool_call_id) ?? text(data.id) ?? "unknown";
    const key = `${runId}:${toolCallId}`;
    const phase = text(data.phase) ?? "update";
    const statusValue = normalizeStatus(data.status);
    const current = this.#tools.get(key) ?? {
      runId,
      toolCallId,
      name: text(data.name) ?? text(data.toolName),
      status: "unknown" as ControlModelToolStatus,
      phase,
      input: null,
      output: null,
      truncated: false,
      inputTruncated: false,
      outputTruncated: false,
      inputBytes: 0,
      outputBytes: 0,
      updates: 0,
      bytes: 0,
      progressTruncated: false,
    };
    const next = {
      ...current,
      name: current.name ?? text(data.name) ?? text(data.toolName),
      phase,
      updates: current.updates + 1,
    };
    if (
      statusValue === "cancelled" ||
      statusValue === "canceled" ||
      statusValue === "aborted" ||
      phase === "cancel"
    )
      next.status = "cancelled";
    else if (
      data.isError === true ||
      data.error !== undefined ||
      statusValue === "failed" ||
      statusValue === "blocked" ||
      phase === "error"
    )
      next.status = "failed";
    else if (
      phase === "result" ||
      phase === "end" ||
      statusValue === "completed" ||
      statusValue === "succeeded" ||
      statusValue === "success"
    )
      next.status = "succeeded";
    else if (
      phase === "start" ||
      phase === "input_delta" ||
      phase === "update" ||
      statusValue === "running"
    )
      next.status = "running";
    else next.status = "unknown";
    if (
      (current.status === "succeeded" ||
        current.status === "failed" ||
        current.status === "cancelled") &&
      next.status === "running"
    )
      next.status = current.status;

    const inputIsDelta = data.input_delta !== undefined;
    const input = data.input_delta ?? data.input ?? data.arguments ?? data.args;
    if (input !== undefined && !(inputIsDelta && current.inputTruncated)) {
      const value =
        inputIsDelta && typeof next.input === "string" && typeof input === "string"
          ? `${next.input}${input}`
          : input;
      const bounded = boundedValue(value, this.#host.bounds.maxProgressBytes);
      next.input = bounded.value;
      next.inputBytes = bounded.bytes;
      next.inputTruncated = bounded.truncated;
    }

    const outputIsDelta = data.output_delta !== undefined;
    const output =
      data.output_delta ?? data.output ?? data.result ?? data.partialResult ?? data.content;
    const remainingBytes = Math.max(0, this.#host.bounds.maxProgressBytes - next.inputBytes);
    if (output !== undefined && !(outputIsDelta && current.outputTruncated)) {
      const value =
        outputIsDelta && typeof next.output === "string" && typeof output === "string"
          ? `${next.output}${output}`
          : output;
      const bounded = boundedValue(value, remainingBytes);
      next.output = bounded.value;
      next.outputBytes = bounded.bytes;
      next.outputTruncated = bounded.truncated;
    } else if (next.output !== null && next.outputBytes > remainingBytes) {
      const bounded = boundedValue(next.output, remainingBytes);
      next.output = bounded.value;
      next.outputBytes = bounded.bytes;
      next.outputTruncated ||= bounded.truncated;
    }
    next.bytes = next.inputBytes + next.outputBytes;
    if (next.updates > this.#host.bounds.maxProgressUpdates) {
      next.progressTruncated = true;
      next.updates = this.#host.bounds.maxProgressUpdates;
    }
    next.progressTruncated ||= next.inputTruncated || next.outputTruncated;
    next.truncated = next.inputTruncated || next.outputTruncated || next.progressTruncated;
    this.#tools.set(key, next);
    while (this.#tools.size > this.#host.bounds.maxTools) {
      const first = this.#tools.keys().next().value;
      if (first) this.#tools.delete(first);
      else break;
      this.#boundsTruncated.tools = true;
    }
    this.#publish();
  }

  #applyApprovalReplay(replay: unknown): void {
    const value = record(replay);
    if (!value || !Array.isArray(value.approvals)) return;
    if (value.truncated !== true)
      for (const [id, approval] of this.#approvals)
        if (normalizeStatus(approval.status) === "pending") this.#approvals.delete(id);
    for (const approval of value.approvals) this.#upsertApproval(approval);
    if (value.truncated === true) this.#partialReasons.add("approval-replay-truncated");
    else this.#partialReasons.delete("approval-replay-truncated");
    this.#publish();
  }
  #upsertApproval(value: unknown): void {
    const approval = record(value);
    const id = text(approval?.id);
    if (!approval || !id) return;
    const sessionKey = text(approval.sessionKey) ?? text(approval.sourceSessionKey);
    if (sessionKey && sessionKey !== this.#sessionKey) return;
    this.#approvals.set(id, { ...approval });
    while (this.#approvals.size > this.#host.bounds.maxApprovals) {
      const first = this.#approvals.keys().next().value;
      if (first) this.#approvals.delete(first);
      else break;
      this.#boundsTruncated.approvals = true;
    }
    this.#publish();
  }
  #upsertQuestion(value: unknown): void {
    const question = record(value);
    const id = text(question?.id);
    if (!question || !id) return;
    const sessionKey = text(question.sessionKey);
    if (sessionKey && sessionKey !== this.#sessionKey) return;
    this.#questions.set(id, { ...question, sessionKey: this.#sessionKey });
    while (this.#questions.size > this.#host.bounds.maxQuestions) {
      const first = this.#questions.keys().next().value;
      if (first) this.#questions.delete(first);
      else break;
      this.#boundsTruncated.questions = true;
    }
    this.#publish();
  }
  #resolveQuestionEvent(payload: Record<string, unknown>): void {
    const id = text(payload.id) ?? text(record(payload.question)?.id);
    if (!id) return;
    const existing = this.#questions.get(id);
    this.#upsertQuestion({ ...(existing ?? {}), ...payload, id, sessionKey: this.#sessionKey });
  }
  #activeRunId(): string | null {
    return (
      Object.values(this.#projection.runs).find((candidate) => candidate.status === "streaming")
        ?.runId ?? null
    );
  }
  #releaseLeases(): void {
    const leases = this.#leases;
    this.#leases = { plain: null, approvals: null };
    if (leases.approvals)
      void releaseGatewaySessionMessageSubscription(leases.approvals).catch((error) =>
        this.#host.reportBackgroundError(error),
      );
    if (leases.plain)
      void releaseGatewaySessionMessageSubscription(leases.plain).catch((error) =>
        this.#host.reportBackgroundError(error),
      );
  }

  #applyProjection(event: Parameters<typeof reduceSessionProjection>[1]): void {
    const next = reduceSessionProjection(this.#projection, event);
    if (next === this.#projection) return;
    this.#projection = next;
    this.#boundProjectionEntries();
    this.#publish();
  }

  #eventAgentId(payload: Record<string, unknown>): string | null {
    for (const value of [
      payload,
      record(payload.data),
      record(payload.presentation),
      record(payload.approval),
      record(record(payload.approval)?.presentation),
      record(payload.question),
      record(payload.message),
    ]) {
      const agentId = text(value?.agentId);
      if (agentId) return agentId;
    }
    return null;
  }

  #restoreInFlightRun(value: unknown): void {
    const inFlight = record(value);
    const runId = text(inFlight?.runId);
    if (!runId) return;
    this.#projection = reduceSessionProjection(this.#projection, {
      type: "runDelta",
      runId,
      ...(inFlight?.message !== undefined
        ? { message: inFlight.message }
        : typeof inFlight?.text === "string"
          ? { message: { role: "assistant", content: inFlight.text } }
          : {}),
      scope: { sessionKey: this.#sessionKey },
    });
    for (const event of Array.isArray(inFlight?.events) ? inFlight.events : []) {
      const payload = record(event);
      if (payload) this.#handleAgent({ ...payload, sessionKey: this.#sessionKey });
    }
  }

  #boundProjectionEntries(): void {
    const maxMessages = this.#host.bounds.maxMessages;
    if (this.#projection.entries.length <= maxMessages) return;
    const entries =
      this.#historyWindow === "older"
        ? this.#projection.entries.slice(0, maxMessages)
        : this.#projection.entries.slice(-maxMessages);
    this.#projection = {
      ...this.#projection,
      entries,
      messages: entries.map((entry) => entry.message),
    };
    this.#boundsTruncated.messages = true;
    this.#partialReasons.add("messages-truncated");
    this.#historyCompleteSnapshot = false;
    if (this.#historyWindow === "older") this.#historyTruncatedAfter = true;
    else this.#historyTruncatedBefore = true;
  }

  #buildSnapshot(): ControlModelConversationSnapshot {
    const occurrence = new Map<string, number>();
    const messages = this.#projection.entries.map((entry) => {
      const identity = entry.identity;
      const base = identity?.id
        ? `id:${identity.role}:${identity.id}`
        : identity?.externalSource
          ? `external:${identity.role}:${identity.externalSource}`
          : identity?.sequence !== null && identity?.sequence !== undefined
            ? `seq:${identity.role}:${identity.sequence}`
            : identity?.idempotencyKey
              ? `idem:${identity.role}:${identity.idempotencyKey}`
              : `content:${hash(stableStringify(entry.message))}`;
      const count = (occurrence.get(base) ?? 0) + 1;
      occurrence.set(base, count);
      return {
        key: `${base}:${count}`,
        role: identity?.role ?? text(record(entry.message)?.role) ?? "unknown",
        sequence: identity?.sequence ?? readSessionMessageSequence(entry.message),
        runId: entry.pending ? entry.pendingRunId : (identity?.runId ?? entry.pendingRunId),
        pending: entry.pending,
        live: entry.live,
        provisional: entry.pending || isLocallyOptimisticSessionMessage(entry.message),
        raw: cloneAndFreeze(entry.message),
      };
    });
    const visibleMessages =
      messages.length > this.#host.bounds.maxMessages
        ? this.#historyWindow === "older"
          ? messages.slice(0, this.#host.bounds.maxMessages)
          : messages.slice(-this.#host.bounds.maxMessages)
        : messages;
    if (messages.length > this.#host.bounds.maxMessages) this.#boundsTruncated.messages = true;
    const runs = Object.values(this.#projection.runs).map((run) => ({
      runId: run.runId,
      status: run.status,
      ...(run.message !== undefined ? { message: cloneAndFreeze(run.message) } : {}),
      ...(run.stopReason ? { stopReason: run.stopReason } : {}),
      ...(run.errorKind ? { errorKind: run.errorKind } : {}),
      ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    }));
    const visibleRuns =
      runs.length > this.#host.bounds.maxRuns ? runs.slice(-this.#host.bounds.maxRuns) : runs;
    if (runs.length > this.#host.bounds.maxRuns) this.#boundsTruncated.runs = true;
    const tools = [...this.#tools.values()].map((tool) => ({
      key: `${tool.runId}:${tool.toolCallId}`,
      runId: tool.runId,
      toolCallId: tool.toolCallId,
      name: tool.name,
      status: tool.status,
      phase: tool.phase,
      input: tool.input === null ? null : cloneAndFreeze(tool.input),
      output: tool.output === null ? null : cloneAndFreeze(tool.output),
      truncated: tool.truncated,
      progress: { updates: tool.updates, bytes: tool.bytes, truncated: tool.progressTruncated },
    }));
    const approvals = [...this.#approvals.values()].map(
      (approval) => cloneAndFreeze(approval) as ControlModelConversationApproval,
    );
    const questions = [...this.#questions.values()].map(
      (question) => cloneAndFreeze(question) as ControlModelConversationQuestion,
    );
    const activeRun = visibleRuns.find((run) => run.status === "streaming") ?? null;
    const stale = this.#status === "stale" || this.#connection.status !== "connected";
    return cloneAndFreeze({
      sessionKey: this.#sessionKey,
      status: this.#status,
      revision: this.#revision,
      historyRevision: this.#historyRevision,
      connection: this.#connection,
      history: {
        status: this.#historyStatus,
        hasMore: this.#historyHasMore,
        nextOffset: this.#historyNextOffset,
        totalMessages: this.#historyTotalMessages,
        completeSnapshot: this.#historyCompleteSnapshot,
        window: this.#historyWindow,
        truncatedBefore: this.#historyTruncatedBefore,
        truncatedAfter: this.#historyTruncatedAfter,
        revision: this.#historyRevision,
        error: this.#historyError,
      },
      messages: visibleMessages,
      runs: visibleRuns,
      activeRun,
      tools,
      approvals,
      questions,
      partialReasons: [...this.#partialReasons],
      stale,
      hasTransportGap: this.#projection.hasTransportGap,
      commandAvailability: {
        send: !stale && !this.#disposed,
        abort: !stale && activeRun !== null,
        resolveApproval: !stale && approvals.some((approval) => approval.status === "pending"),
        answerQuestion: !stale && questions.some((question) => question.status === "pending"),
        cancelQuestion: !stale && questions.some((question) => question.status === "pending"),
      },
      bounds: {
        messagesTruncated: this.#boundsTruncated.messages,
        runsTruncated: this.#boundsTruncated.runs,
        toolsTruncated: this.#boundsTruncated.tools,
        approvalsTruncated: this.#boundsTruncated.approvals,
        questionsTruncated: this.#boundsTruncated.questions,
      },
    });
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    this.#scheduleNotification();
  }
  #scheduleNotification(): void {
    if (this.#notificationScheduled || this.#disposed) return;
    this.#notificationScheduled = true;
    queueMicrotask(() => {
      this.#notificationScheduled = false;
      if (this.#disposed) return;
      for (const subscriber of [...this.#subscribers]) {
        if (this.#disposed) break;
        try {
          const result = subscriber();
          if (result && typeof result.then === "function")
            void result.catch((error) => this.#host.reportSubscriberError(error));
        } catch (error) {
          this.#host.reportSubscriberError(error);
        }
      }
    });
  }
}
