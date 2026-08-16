import type { SessionRow } from "@openclaw/gateway-protocol";
import type { GatewaySessionMessageRequestClient } from "../session-subscriptions.js";
import { CONTROL_MODEL_DEFAULT_BOUNDS } from "./defaults.js";
import { createSessionEventRefreshCoordinator } from "./session-event-refresh.js";
export { createSessionEventRefreshCoordinator } from "./session-event-refresh.js";

export type DeepReadonly<T> = T extends (...args: infer _Args) => infer _Result
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export type ControlModelConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export type ControlModelError = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
}>;

export type ControlModelConnectionSnapshot = Readonly<{
  status: ControlModelConnectionStatus;
  epoch: number;
  error?: ControlModelError;
}>;

export type ControlModelRequestOptions = Readonly<{
  signal?: AbortSignal;
}>;

/** Gateway-neutral query fields for the bounded session catalog snapshot. */
export type ControlModelSessionCatalogQuery = Readonly<{
  agentId?: string;
  spawnedBy?: string;
  boardFace?: "chat" | "dashboard";
  activeMinutes?: number;
  search?: string;
  creatorId?: string;
  offset?: number;
  limit?: number;
  includeGlobal?: boolean;
  includeUnknown?: boolean;
  configuredAgentsOnly?: boolean;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  archived?: boolean | "all";
}>;

export type ControlModelGatewayEventFrame = Readonly<{
  event: string;
  payload?: unknown;
  connectionEpoch: number;
  seq?: number;
  gap?: boolean | Readonly<Record<string, unknown>>;
}>;

export type ControlModelGatewayBinding = Readonly<{
  getSessionMessageSubscriptionClient?(): GatewaySessionMessageRequestClient | null;
  sessionMessageKeysEquivalent?(left: string, right: string): boolean;
  getConnectionSnapshot(): ControlModelConnectionSnapshot;
  subscribeConnection(listener: () => void): () => void;
  subscribeSessionCatalogInvalidations(listener: () => void): () => void;
  subscribeEvents(listener: (frame: ControlModelGatewayEventFrame) => void): () => void;
  request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: ControlModelRequestOptions,
  ): Promise<T>;
  materializeArtifactView?(
    input: Readonly<{
      sessionKey: string;
      agentId?: string;
      artifactId: string;
      artifactRevision: number;
      viewId: string;
    }>,
    options?: ControlModelRequestOptions,
  ): Promise<unknown>;
}>;

export type ControlModelSessionCatalogSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  query: DeepReadonly<ControlModelSessionCatalogQuery>;
  ts: number | null;
  path: string | null;
  count: number;
  sessions: readonly DeepReadonly<SessionRow>[];
  totalCount: number;
  limitApplied: number | null;
  offset: number | null;
  nextOffset: number | null;
  hasMore: boolean;
  creators: readonly DeepReadonly<Record<string, unknown>>[];
  defaults: unknown;
  refreshedAt: number | null;
  error: ControlModelError | null;
}>;

export type ControlModelSnapshot = Readonly<{
  revision: number;
  lifecycle: "idle" | "running" | "disposed";
  connection: ControlModelConnectionSnapshot;
  sessionCatalog: ControlModelSessionCatalogSnapshot;
}>;

export type ControlModelSubscriber = () => void | Promise<void>;

export type ControlModelCatalogBounds = Readonly<{
  maxSessions?: number;
  maxSubscribers?: number;
}>;

export type ControlModelCatalogOptions = Readonly<{
  gateway: ControlModelGatewayBinding;
  agentId?: string;
  autoRefreshSessionCatalog?: boolean;
  bounds?: ControlModelCatalogBounds;
  now?: () => number;
  onSubscriberError?: (error: unknown) => void;
  onBackgroundError?: (error: unknown) => void;
}>;

export type ControlModelCatalog = Readonly<{
  getSnapshot(): ControlModelSnapshot;
  subscribe(subscriber: ControlModelSubscriber): () => void;
  start(): void;
  refreshSessions(
    options?: ControlModelRequestOptions,
    query?: ControlModelSessionCatalogQuery,
  ): Promise<void>;
  dispose(): void;
}>;

type SessionsListResponse = Readonly<{
  ts?: number;
  path?: string;
  count?: number;
  sessions: readonly SessionRow[];
  totalCount?: number;
  limitApplied?: number;
  offset?: number;
  nextOffset?: number | null;
  hasMore?: boolean;
  creators?: readonly Record<string, unknown>[];
  defaults?: unknown;
}>;

const MAX_CATALOG_QUERY_LIMIT = 1_000;
const MAX_CATALOG_QUERY_OFFSET = 1_000_000;
const MAX_CATALOG_QUERY_ACTIVE_MINUTES = 1_000_000;

export class ControlModelDisposedError extends Error {
  constructor() {
    super("Control Model has been disposed");
    this.name = "ControlModelDisposedError";
  }
}

export class ControlModelSubscriberLimitError extends Error {
  constructor(limit: number) {
    super(`Control Model subscriber limit reached (${limit})`);
    this.name = "ControlModelSubscriberLimitError";
  }
}

function normalizeBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeError(error: unknown): ControlModelError {
  const record =
    error !== null && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : String(error);
  const candidateCode = record?.code ?? record?.gatewayCode;
  return Object.freeze({
    code:
      typeof candidateCode === "string" && candidateCode.trim()
        ? candidateCode.trim()
        : "CONTROL_MODEL_REQUEST_FAILED",
    message,
    retryable: record?.retryable === true,
  });
}

function cloneAndFreeze<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }
  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(value, clone);
    for (const item of value) {
      clone.push(cloneAndFreeze(item, seen));
    }
    return Object.freeze(clone) as T;
  }
  const clone: Record<string, unknown> = {};
  seen.set(value, clone);
  for (const [key, item] of Object.entries(value)) {
    clone[key] = cloneAndFreeze(item, seen);
  }
  return Object.freeze(clone) as T;
}

function freezeConnection(
  connection: ControlModelConnectionSnapshot,
): ControlModelConnectionSnapshot {
  return cloneAndFreeze(connection);
}

function trimmedCatalogQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boundedPositiveCatalogQueryNumber(value: unknown, maximum: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(maximum, Math.floor(value));
}

function normalizeCatalogQuery(
  query: ControlModelSessionCatalogQuery | undefined,
): ControlModelSessionCatalogQuery {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return Object.freeze({});
  }
  const source = query as Record<string, unknown>;
  const next: Record<string, unknown> = {};
  for (const key of ["agentId", "spawnedBy", "search", "creatorId"] as const) {
    const value = trimmedCatalogQueryString(source[key]);
    if (value !== undefined) {
      next[key] = value;
    }
  }
  if (source.boardFace === "chat" || source.boardFace === "dashboard") {
    next.boardFace = source.boardFace;
  }
  const activeMinutes = boundedPositiveCatalogQueryNumber(
    source.activeMinutes,
    MAX_CATALOG_QUERY_ACTIVE_MINUTES,
  );
  if (activeMinutes !== undefined) {
    next.activeMinutes = activeMinutes;
  }
  const offset = boundedPositiveCatalogQueryNumber(source.offset, MAX_CATALOG_QUERY_OFFSET);
  if (offset !== undefined) {
    next.offset = offset;
  }
  const limit = boundedPositiveCatalogQueryNumber(source.limit, MAX_CATALOG_QUERY_LIMIT);
  if (limit !== undefined) {
    next.limit = limit;
  }
  for (const key of [
    "includeGlobal",
    "includeUnknown",
    "configuredAgentsOnly",
    "includeDerivedTitles",
    "includeLastMessage",
  ] as const) {
    if (typeof source[key] === "boolean") {
      next[key] = source[key];
    }
  }
  if (typeof source.archived === "boolean" || source.archived === "all") {
    next.archived = source.archived;
  }
  return Object.freeze(next) as ControlModelSessionCatalogQuery;
}

function emptyCatalog(
  query: ControlModelSessionCatalogQuery = {},
): ControlModelSessionCatalogSnapshot {
  return Object.freeze({
    status: "idle",
    query: cloneAndFreeze(query),
    ts: null,
    path: null,
    count: 0,
    sessions: Object.freeze([]),
    totalCount: 0,
    limitApplied: null,
    offset: null,
    nextOffset: null,
    hasMore: false,
    creators: Object.freeze([]),
    defaults: null,
    refreshedAt: null,
    error: null,
  });
}

function initialSnapshot(connection: ControlModelConnectionSnapshot): ControlModelSnapshot {
  return Object.freeze({
    revision: 0,
    lifecycle: "idle",
    connection: freezeConnection(connection),
    sessionCatalog: emptyCatalog(),
  });
}

export class ControlModelCatalogImpl implements ControlModelCatalog {
  readonly #gateway: ControlModelGatewayBinding;
  readonly #maxSessions: number;
  readonly #maxSubscribers: number;
  readonly #agentId: string | undefined;
  readonly #autoRefreshSessionCatalog: boolean;
  readonly #now: () => number;
  readonly #onSubscriberError?: (error: unknown) => void;
  readonly #onBackgroundError?: (error: unknown) => void;
  readonly #subscribers = new Set<ControlModelSubscriber>();
  #snapshot: ControlModelSnapshot;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeSessionCatalogInvalidations: (() => void) | null = null;
  #refreshLoop: Promise<void> | null = null;
  #refreshRequested = false;
  #refreshOptions: ControlModelRequestOptions | undefined;
  #sessionCatalogQuery: ControlModelSessionCatalogQuery = Object.freeze({});
  #refreshQuery: ControlModelSessionCatalogQuery = Object.freeze({});
  #sessionCatalogEnabled = false;
  #notificationScheduled = false;
  readonly #eventRefreshCoordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;

  constructor(options: ControlModelCatalogOptions) {
    this.#gateway = options.gateway;
    this.#maxSessions = normalizeBound(
      options.bounds?.maxSessions,
      CONTROL_MODEL_DEFAULT_BOUNDS.maxSessions,
    );
    this.#maxSubscribers = normalizeBound(
      options.bounds?.maxSubscribers,
      CONTROL_MODEL_DEFAULT_BOUNDS.maxSubscribers,
    );
    this.#agentId = options.agentId?.trim() || undefined;
    this.#autoRefreshSessionCatalog = options.autoRefreshSessionCatalog !== false;
    this.#now = options.now ?? Date.now;
    this.#onSubscriberError = options.onSubscriberError;
    this.#onBackgroundError = options.onBackgroundError;
    this.#snapshot = initialSnapshot(this.#gateway.getConnectionSnapshot());
    this.#eventRefreshCoordinator = createSessionEventRefreshCoordinator({
      canRefresh: () =>
        this.#sessionCatalogEnabled &&
        this.#snapshot.lifecycle === "running" &&
        this.#gateway.getConnectionSnapshot().status === "connected",
      refresh: async () => {
        try {
          await this.refreshSessions();
        } catch (error) {
          this.#reportBackgroundError(error);
          throw error;
        }
      },
    });
  }

  getSnapshot(): ControlModelSnapshot {
    return this.#snapshot;
  }

  subscribe(subscriber: ControlModelSubscriber): () => void {
    this.#assertActive();
    if (this.#subscribers.size >= this.#maxSubscribers) {
      throw new ControlModelSubscriberLimitError(this.#maxSubscribers);
    }
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  start(): void {
    this.#assertActive();
    if (this.#snapshot.lifecycle === "running") {
      return;
    }
    this.#unsubscribeConnection = this.#gateway.subscribeConnection(() => this.#readConnection());
    this.#unsubscribeSessionCatalogInvalidations =
      this.#gateway.subscribeSessionCatalogInvalidations(() =>
        this.#eventRefreshCoordinator.schedule(),
      );
    this.#publish({
      ...this.#snapshot,
      lifecycle: "running",
      connection: freezeConnection(this.#gateway.getConnectionSnapshot()),
    });
    if (this.#snapshot.connection.status === "connected" && this.#autoRefreshSessionCatalog) {
      this.#sessionCatalogEnabled = true;
      this.#eventRefreshCoordinator.schedule();
      this.#eventRefreshCoordinator.flush();
    }
  }

  refreshSessions(
    options?: ControlModelRequestOptions,
    query?: ControlModelSessionCatalogQuery,
  ): Promise<void> {
    this.#assertActive();
    this.#sessionCatalogEnabled = true;
    if (query !== undefined) {
      this.#sessionCatalogQuery = normalizeCatalogQuery(query);
      this.#refreshQuery = this.#sessionCatalogQuery;
    }
    this.#refreshRequested = true;
    if (options !== undefined || this.#refreshOptions === undefined) {
      this.#refreshOptions = options;
    }
    if (!this.#refreshLoop) {
      const loop = this.#drainRefreshes().finally(() => {
        if (this.#refreshLoop === loop) {
          this.#refreshLoop = null;
          if (this.#refreshRequested && this.#snapshot.lifecycle !== "disposed") {
            void this.refreshSessions(this.#refreshOptions, this.#refreshQuery).catch(
              (error: unknown) => this.#reportBackgroundError(error),
            );
          }
        }
      });
      this.#refreshLoop = loop;
    }
    return this.#refreshLoop;
  }

  dispose(): void {
    if ((this.#snapshot.lifecycle as ControlModelSnapshot["lifecycle"]) === "disposed") {
      return;
    }
    this.#unsubscribeConnection?.();
    this.#unsubscribeSessionCatalogInvalidations?.();
    this.#unsubscribeConnection = null;
    this.#unsubscribeSessionCatalogInvalidations = null;
    this.#refreshRequested = false;
    this.#eventRefreshCoordinator.dispose();
    this.#publish({ ...this.#snapshot, lifecycle: "disposed" });
    this.#subscribers.clear();
  }

  protected isCurrentCatalogEpoch(epoch: number): boolean {
    const connection = this.#gateway.getConnectionSnapshot();
    return (
      this.#snapshot.lifecycle !== "disposed" &&
      connection.status === "connected" &&
      connection.epoch === epoch
    );
  }

  async #drainRefreshes(): Promise<void> {
    let firstError: unknown;
    while (this.#refreshRequested && this.#snapshot.lifecycle !== "disposed") {
      this.#refreshRequested = false;
      const options = this.#refreshOptions;
      this.#refreshOptions = undefined;
      try {
        await this.#refreshOnce(options);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw firstError instanceof Error
        ? firstError
        : new Error("Control Model catalog refresh failed", { cause: firstError });
    }
  }

  async #refreshOnce(options?: ControlModelRequestOptions): Promise<void> {
    const connection = this.#gateway.getConnectionSnapshot();
    if (connection.status !== "connected" || !this.#sessionCatalogEnabled) {
      return;
    }
    const epoch = connection.epoch;
    const query = this.#refreshQuery;
    this.#publish({
      ...this.#snapshot,
      connection: freezeConnection(connection),
      sessionCatalog: Object.freeze({
        ...this.#snapshot.sessionCatalog,
        status: "loading",
        query: cloneAndFreeze(query),
        error: null,
      }),
    });
    try {
      const params: Record<string, unknown> = {
        ...query,
        limit: Math.min(
          this.#maxSessions,
          typeof query.limit === "number" && Number.isFinite(query.limit) && query.limit > 0
            ? Math.floor(query.limit)
            : this.#maxSessions,
        ),
      };
      if (this.#agentId && params.agentId === undefined) {
        params.agentId = this.#agentId;
      }
      if (typeof query.offset !== "number" || query.offset <= 0) {
        delete params.offset;
      }
      const response = await this.#gateway.request<SessionsListResponse>(
        "sessions.list",
        params,
        options,
      );
      if (!this.isCurrentCatalogEpoch(epoch) || this.#refreshQuery !== query) {
        return;
      }
      const locallyTruncated = response.sessions.length > this.#maxSessions;
      const sessions = cloneAndFreeze(response.sessions.slice(0, this.#maxSessions));
      const responseOffset =
        typeof response.offset === "number" && Number.isFinite(response.offset)
          ? Math.max(0, Math.floor(response.offset))
          : typeof query.offset === "number" && query.offset > 0
            ? Math.floor(query.offset)
            : null;
      const totalCount = Math.max(
        sessions.length,
        typeof response.totalCount === "number" && Number.isFinite(response.totalCount)
          ? Math.max(0, Math.floor(response.totalCount))
          : sessions.length,
      );
      if (responseOffset !== null && responseOffset > 0 && this.#refreshQuery === query) {
        this.#refreshQuery = normalizeCatalogQuery({
          ...query,
          offset: undefined,
          limit: Math.max(query.limit ?? this.#maxSessions, responseOffset + sessions.length),
        });
      }
      this.#publish({
        ...this.#snapshot,
        connection: freezeConnection(this.#gateway.getConnectionSnapshot()),
        sessionCatalog: Object.freeze({
          status: "ready",
          query: cloneAndFreeze(query),
          ts: typeof response.ts === "number" ? response.ts : null,
          path: typeof response.path === "string" ? response.path : null,
          count: typeof response.count === "number" ? response.count : sessions.length,
          sessions,
          totalCount,
          limitApplied: typeof response.limitApplied === "number" ? response.limitApplied : null,
          offset: responseOffset,
          nextOffset:
            typeof response.nextOffset === "number"
              ? response.nextOffset
              : (response.nextOffset ?? null),
          hasMore:
            locallyTruncated ||
            (response.nextOffset === null
              ? false
              : response.hasMore === true || totalCount > (responseOffset ?? 0) + sessions.length),
          creators: cloneAndFreeze(response.creators ?? []),
          defaults: cloneAndFreeze(response.defaults ?? null),
          refreshedAt: this.#now(),
          error: null,
        }),
      });
    } catch (error) {
      if (!this.isCurrentCatalogEpoch(epoch) || this.#refreshQuery !== query) {
        return;
      }
      this.#publish({
        ...this.#snapshot,
        sessionCatalog: Object.freeze({
          ...this.#snapshot.sessionCatalog,
          status: "error",
          error: normalizeError(error),
        }),
      });
      throw error;
    }
  }

  #readConnection(): void {
    if ((this.#snapshot.lifecycle as ControlModelSnapshot["lifecycle"]) === "disposed") {
      return;
    }
    const previous = this.#snapshot.connection;
    const connection = freezeConnection(this.#gateway.getConnectionSnapshot());
    if (this.#autoRefreshSessionCatalog && connection.status === "connected") {
      this.#sessionCatalogEnabled = true;
    }
    const epochChanged = connection.epoch !== previous.epoch;
    if (epochChanged || connection.status !== "connected") {
      this.#eventRefreshCoordinator.reset();
    }
    this.#publish({
      ...this.#snapshot,
      connection,
      sessionCatalog: epochChanged
        ? emptyCatalog(this.#sessionCatalogQuery)
        : connection.status !== "connected" && this.#snapshot.sessionCatalog.status === "loading"
          ? Object.freeze({ ...this.#snapshot.sessionCatalog, status: "idle", error: null })
          : this.#snapshot.sessionCatalog,
    });
    if (
      this.#sessionCatalogEnabled &&
      connection.status === "connected" &&
      (epochChanged || this.#snapshot.sessionCatalog.status === "idle")
    ) {
      this.#eventRefreshCoordinator.schedule();
      this.#eventRefreshCoordinator.flush();
    }
  }

  #publish(next: Omit<ControlModelSnapshot, "revision"> & { revision?: number }): void {
    const { revision: _ignored, ...rest } = next;
    this.#snapshot = Object.freeze({ ...rest, revision: this.#snapshot.revision + 1 });
    this.#scheduleNotification();
  }

  #scheduleNotification(): void {
    if (this.#notificationScheduled || this.#snapshot.lifecycle === "disposed") {
      return;
    }
    this.#notificationScheduled = true;
    queueMicrotask(() => {
      this.#notificationScheduled = false;
      if (this.#snapshot.lifecycle === "disposed") {
        return;
      }
      // oxlint-disable-next-line no-useless-spread
      for (const subscriber of [...this.#subscribers]) {
        if ((this.#snapshot.lifecycle as ControlModelSnapshot["lifecycle"]) === "disposed") {
          break;
        }
        try {
          const result = subscriber();
          if (result && typeof result.then === "function") {
            void result.catch((error: unknown) => this.#reportSubscriberError(error));
          }
        } catch (error) {
          this.#reportSubscriberError(error);
        }
      }
    });
  }

  #reportSubscriberError(error: unknown): void {
    try {
      this.#onSubscriberError?.(error);
    } catch {
      // Error observers cannot own model progress.
    }
  }

  #reportBackgroundError(error: unknown): void {
    try {
      this.#onBackgroundError?.(error);
    } catch {
      // The structured catalog error remains observable when reporting fails.
    }
  }

  #assertActive(): void {
    if (this.#snapshot.lifecycle === "disposed") {
      throw new ControlModelDisposedError();
    }
  }
}

export function createControlModelCatalog(
  options: ControlModelCatalogOptions,
): ControlModelCatalog {
  return new ControlModelCatalogImpl(options);
}
