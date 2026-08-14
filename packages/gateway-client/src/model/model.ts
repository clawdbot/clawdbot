import type { SessionRow } from "@openclaw/gateway-protocol";
import { createSessionEventRefreshCoordinator } from "./session-event-refresh.js";

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

export type ControlModelGatewayBinding = Readonly<{
  getConnectionSnapshot(): ControlModelConnectionSnapshot;
  subscribeConnection(listener: () => void): () => void;
  subscribeSessionCatalogInvalidations(listener: () => void): () => void;
  request<T>(
    method: string,
    params: Record<string, unknown>,
    options?: ControlModelRequestOptions,
  ): Promise<T>;
}>;

export type ControlModelSessionCatalogSnapshot = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  sessions: readonly DeepReadonly<SessionRow>[];
  totalCount: number;
  hasMore: boolean;
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

export type ControlModelBounds = Readonly<{
  maxSessions?: number;
  maxSubscribers?: number;
}>;

export type ControlModelOptions = Readonly<{
  gateway: ControlModelGatewayBinding;
  bounds?: ControlModelBounds;
  now?: () => number;
  onSubscriberError?: (error: unknown) => void;
  onBackgroundError?: (error: unknown) => void;
}>;

export type ControlModel = Readonly<{
  getSnapshot(): ControlModelSnapshot;
  subscribe(subscriber: ControlModelSubscriber): () => void;
  start(): void;
  refreshSessions(options?: ControlModelRequestOptions): Promise<void>;
  dispose(): void;
}>;

type SessionsListResponse = Readonly<{
  sessions: readonly SessionRow[];
  totalCount?: number;
  hasMore?: boolean;
}>;

const DEFAULT_MAX_SESSIONS = 200;
const DEFAULT_MAX_SUBSCRIBERS = 100;

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

function initialSnapshot(connection: ControlModelConnectionSnapshot): ControlModelSnapshot {
  return Object.freeze({
    revision: 0,
    lifecycle: "idle",
    connection: freezeConnection(connection),
    sessionCatalog: Object.freeze({
      status: "idle",
      sessions: Object.freeze([]),
      totalCount: 0,
      hasMore: false,
      refreshedAt: null,
      error: null,
    }),
  });
}

class ControlModelImpl implements ControlModel {
  readonly #gateway: ControlModelGatewayBinding;
  readonly #maxSessions: number;
  readonly #maxSubscribers: number;
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
  #notificationScheduled = false;
  readonly #eventRefreshCoordinator: ReturnType<typeof createSessionEventRefreshCoordinator>;

  constructor(options: ControlModelOptions) {
    this.#gateway = options.gateway;
    this.#maxSessions = normalizeBound(options.bounds?.maxSessions, DEFAULT_MAX_SESSIONS);
    this.#maxSubscribers = normalizeBound(options.bounds?.maxSubscribers, DEFAULT_MAX_SUBSCRIBERS);
    this.#now = options.now ?? Date.now;
    this.#onSubscriberError = options.onSubscriberError;
    this.#onBackgroundError = options.onBackgroundError;
    this.#snapshot = initialSnapshot(this.#gateway.getConnectionSnapshot());
    this.#eventRefreshCoordinator = createSessionEventRefreshCoordinator({
      active:
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
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  start(): void {
    this.#assertActive();
    if (this.#snapshot.lifecycle === "running") {
      return;
    }
    this.#unsubscribeConnection = this.#gateway.subscribeConnection(() => {
      this.#readConnection();
    });
    this.#unsubscribeSessionCatalogInvalidations =
      this.#gateway.subscribeSessionCatalogInvalidations(() => {
        this.#eventRefreshCoordinator.schedule();
      });
    this.#publish({
      ...this.#snapshot,
      lifecycle: "running",
      connection: freezeConnection(this.#gateway.getConnectionSnapshot()),
    });
    this.#eventRefreshCoordinator.setActive(this.#snapshot.connection.status === "connected");
    if (this.#snapshot.connection.status === "connected") {
      this.#eventRefreshCoordinator.schedule();
      this.#eventRefreshCoordinator.flush();
    }
  }

  refreshSessions(options?: ControlModelRequestOptions): Promise<void> {
    this.#assertActive();
    this.#refreshRequested = true;
    if (options !== undefined || this.#refreshOptions === undefined) {
      this.#refreshOptions = options;
    }
    if (!this.#refreshLoop) {
      const loop = this.#drainRefreshes().finally(() => {
        if (this.#refreshLoop === loop) {
          this.#refreshLoop = null;
          if (this.#refreshRequested && this.#snapshot.lifecycle !== "disposed") {
            void this.refreshSessions(this.#refreshOptions).catch((error: unknown) => {
              this.#reportBackgroundError(error);
            });
          }
        }
      });
      this.#refreshLoop = loop;
    }
    return this.#refreshLoop;
  }

  dispose(): void {
    if (this.#snapshot.lifecycle === "disposed") {
      return;
    }
    this.#unsubscribeConnection?.();
    this.#unsubscribeSessionCatalogInvalidations?.();
    this.#unsubscribeConnection = null;
    this.#unsubscribeSessionCatalogInvalidations = null;
    this.#refreshRequested = false;
    this.#eventRefreshCoordinator.dispose();
    this.#publish({
      ...this.#snapshot,
      lifecycle: "disposed",
    });
    this.#subscribers.clear();
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
      throw firstError;
    }
  }

  async #refreshOnce(options?: ControlModelRequestOptions): Promise<void> {
    const connection = this.#gateway.getConnectionSnapshot();
    if (connection.status !== "connected") {
      return;
    }
    const epoch = connection.epoch;
    this.#publish({
      ...this.#snapshot,
      connection: freezeConnection(connection),
      sessionCatalog: Object.freeze({
        ...this.#snapshot.sessionCatalog,
        status: "loading",
        error: null,
      }),
    });

    try {
      const response = await this.#gateway.request<SessionsListResponse>(
        "sessions.list",
        { limit: this.#maxSessions },
        options,
      );
      if (!this.#isCurrentEpoch(epoch)) {
        return;
      }
      const locallyTruncated = response.sessions.length > this.#maxSessions;
      const sessions = cloneAndFreeze(response.sessions.slice(0, this.#maxSessions));
      const totalCount = Math.max(
        sessions.length,
        typeof response.totalCount === "number" && Number.isFinite(response.totalCount)
          ? Math.max(0, Math.floor(response.totalCount))
          : sessions.length,
      );
      this.#publish({
        ...this.#snapshot,
        connection: freezeConnection(this.#gateway.getConnectionSnapshot()),
        sessionCatalog: Object.freeze({
          status: "ready",
          sessions,
          totalCount,
          hasMore: response.hasMore === true || locallyTruncated || totalCount > sessions.length,
          refreshedAt: this.#now(),
          error: null,
        }),
      });
    } catch (error) {
      if (!this.#isCurrentEpoch(epoch)) {
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
    if (this.#snapshot.lifecycle === "disposed") {
      return;
    }
    const connection = freezeConnection(this.#gateway.getConnectionSnapshot());
    const epochChanged = connection.epoch !== this.#snapshot.connection.epoch;
    if (epochChanged || connection.status !== "connected") {
      this.#eventRefreshCoordinator.reset();
    }
    this.#publish({
      ...this.#snapshot,
      connection,
      sessionCatalog: epochChanged
        ? Object.freeze({
            status: "idle",
            sessions: Object.freeze([]),
            totalCount: 0,
            hasMore: false,
            refreshedAt: null,
            error: null,
          })
        : connection.status !== "connected" && this.#snapshot.sessionCatalog.status === "loading"
          ? Object.freeze({
              ...this.#snapshot.sessionCatalog,
              status: "idle",
              error: null,
            })
          : this.#snapshot.sessionCatalog,
    });
    this.#eventRefreshCoordinator.setActive(
      this.#snapshot.lifecycle === "running" && connection.status === "connected",
    );
    if (
      connection.status === "connected" &&
      (epochChanged || this.#snapshot.sessionCatalog.status === "idle")
    ) {
      this.#eventRefreshCoordinator.schedule();
      this.#eventRefreshCoordinator.flush();
    }
  }

  #isCurrentEpoch(epoch: number): boolean {
    const connection = this.#gateway.getConnectionSnapshot();
    return (
      this.#snapshot.lifecycle !== "disposed" &&
      connection.status === "connected" &&
      connection.epoch === epoch
    );
  }

  #publish(next: Omit<ControlModelSnapshot, "revision"> & { revision?: number }): void {
    const { revision: _ignored, ...rest } = next;
    this.#snapshot = Object.freeze({
      ...rest,
      revision: this.#snapshot.revision + 1,
    });
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
      for (const subscriber of [...this.#subscribers]) {
        if (this.#snapshot.lifecycle === "disposed") {
          break;
        }
        try {
          const result = subscriber();
          if (result && typeof result.then === "function") {
            void result.catch((error: unknown) => {
              this.#reportSubscriberError(error);
            });
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
      // Error observers are terminal reporting hooks and cannot own model progress.
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

export function createControlModel(options: ControlModelOptions): ControlModel {
  return new ControlModelImpl(options);
}
