import {
  getGatewaySessionMessageSubscriptionCoordinator,
  resetGatewaySessionMessageSubscriptionCoordinator,
} from "../browser.js";
import {
  ControlModelCatalogImpl,
  ControlModelDisposedError,
  type ControlModelCatalog,
  type ControlModelCatalogBounds,
  type ControlModelCatalogOptions,
  type ControlModelConnectionSnapshot,
  type ControlModelGatewayEventFrame,
  type ControlModelGatewayBinding,
  type ControlModelSnapshot,
} from "./catalog.js";
import {
  ControlModelConversation,
  ControlModelCommandError,
  type ControlModelConversationBounds,
  type ControlModelConversationHost,
} from "./conversation.js";
import { CONTROL_MODEL_DEFAULT_BOUNDS } from "./defaults.js";

export type {
  ControlModelCatalog,
  ControlModelCatalogBounds,
  ControlModelCatalogOptions,
  ControlModelConnectionSnapshot,
  ControlModelGatewayBinding,
  ControlModelGatewayEventFrame,
  ControlModelRequestOptions,
  ControlModelSessionCatalogQuery,
  ControlModelSessionCatalogSnapshot,
  ControlModelSnapshot,
  ControlModelSubscriber,
} from "./catalog.js";
export { ControlModelDisposedError, ControlModelSubscriberLimitError } from "./catalog.js";
import type {
  ControlModelRequestOptions,
  ControlModelSessionCatalogQuery,
  ControlModelSubscriber,
} from "./catalog.js";

export type ControlModelBounds = Readonly<
  ControlModelCatalogBounds & {
    maxInactiveConversations?: number;
    maxConversationMessages?: number;
    maxConversationRuns?: number;
    maxConversationTools?: number;
    maxConversationApprovals?: number;
    maxConversationQuestions?: number;
    maxConversationProgressUpdates?: number;
    maxConversationProgressBytes?: number;
    /** Total JSON bytes retained from one chat.startup/chat.history metadata payload. */
    maxConversationStartupMetadataBytes?: number;
    maxConversationArtifacts?: number;
    maxArtifactBytes?: number;
    maxArtifactDepth?: number;
    maxArtifactCollectionItems?: number;
    maxArtifactStringBytes?: number;
    maxArtifactViews?: number;
  }
>;

export type ControlModelOptions = Readonly<
  ControlModelCatalogOptions & {
    autoLoadConversationHistory?: boolean;
    bounds?: ControlModelBounds;
    generateId?: (prefix: string) => string;
  }
>;

/** Internal/adopter-facing bridge used after the conversation chunk is loaded. */
export type ControlModelConversationModelOptions = Readonly<
  ControlModelOptions & { catalog: ControlModelCatalog }
>;

export type ControlModel = Readonly<
  ControlModelCatalog & {
    conversation(
      sessionKey: string,
      options?: Readonly<{ agentId?: string }>,
    ): ControlModelConversation;
    releaseConversation(
      sessionKey: string,
      options?: Readonly<{ agentId?: string }>,
    ): Promise<void>;
  }
>;

function normalizeBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

class ControlModelImpl implements ControlModel {
  readonly #catalog: ControlModelCatalog;
  readonly #ownsCatalog: boolean;
  readonly #gateway: ControlModelGatewayBinding;
  readonly #maxInactiveConversations: number;
  readonly #conversationBounds: ControlModelConversationBounds;
  readonly #agentId: string | undefined;
  readonly #autoLoadConversationHistory: boolean;
  readonly #generateId: (prefix: string) => string;
  readonly #conversations = new Map<string, ControlModelConversation>();
  readonly #now: () => number;
  readonly #onSubscriberError?: (error: unknown) => void;
  readonly #onBackgroundError?: (error: unknown) => void;
  #unsubscribeConnection: (() => void) | null = null;
  #unsubscribeEvents: (() => void) | null = null;
  #messageSubscriptionCoordinator: ReturnType<
    typeof getGatewaySessionMessageSubscriptionCoordinator
  > | null = null;
  #messageSubscriptionClient:
    | Parameters<typeof getGatewaySessionMessageSubscriptionCoordinator>[0]
    | null = null;
  #lastConnection: ControlModelConnectionSnapshot;
  #running = false;
  #disposed = false;

  constructor(options: ControlModelOptions, catalog?: ControlModelCatalog) {
    this.#catalog = catalog ?? new ControlModelCatalogImpl(options);
    this.#ownsCatalog = catalog === undefined;
    this.#gateway = options.gateway;
    this.#maxInactiveConversations = normalizeBound(
      options.bounds?.maxInactiveConversations,
      CONTROL_MODEL_DEFAULT_BOUNDS.maxInactiveConversations,
    );
    this.#agentId = options.agentId?.trim() || undefined;
    this.#autoLoadConversationHistory = options.autoLoadConversationHistory !== false;
    this.#generateId =
      options.generateId ??
      ((prefix) =>
        `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.#conversationBounds = {
      maxSubscribers: normalizeBound(
        options.bounds?.maxSubscribers,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxSubscribers,
      ),
      maxMessages: normalizeBound(
        options.bounds?.maxConversationMessages,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationMessages,
      ),
      maxRuns: normalizeBound(
        options.bounds?.maxConversationRuns,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationRuns,
      ),
      maxTools: normalizeBound(
        options.bounds?.maxConversationTools,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationTools,
      ),
      maxApprovals: normalizeBound(
        options.bounds?.maxConversationApprovals,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationApprovals,
      ),
      maxQuestions: normalizeBound(
        options.bounds?.maxConversationQuestions,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationQuestions,
      ),
      maxProgressUpdates: normalizeBound(
        options.bounds?.maxConversationProgressUpdates,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationProgressUpdates,
      ),
      maxProgressBytes: normalizeBound(
        options.bounds?.maxConversationProgressBytes,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationProgressBytes,
      ),
      maxMetadataBytes: normalizeBound(
        options.bounds?.maxConversationStartupMetadataBytes,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationStartupMetadataBytes,
      ),
      maxArtifacts: normalizeBound(
        options.bounds?.maxConversationArtifacts,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxConversationArtifacts,
      ),
      maxArtifactBytes: normalizeBound(
        options.bounds?.maxArtifactBytes,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxArtifactBytes,
      ),
      maxArtifactDepth: normalizeBound(
        options.bounds?.maxArtifactDepth,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxArtifactDepth,
      ),
      maxArtifactCollectionItems: normalizeBound(
        options.bounds?.maxArtifactCollectionItems,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxArtifactCollectionItems,
      ),
      maxArtifactStringBytes: normalizeBound(
        options.bounds?.maxArtifactStringBytes,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxArtifactStringBytes,
      ),
      maxArtifactViews: normalizeBound(
        options.bounds?.maxArtifactViews,
        CONTROL_MODEL_DEFAULT_BOUNDS.maxArtifactViews,
      ),
    };
    this.#now = options.now ?? Date.now;
    this.#onSubscriberError = options.onSubscriberError;
    this.#onBackgroundError = options.onBackgroundError;
    this.#lastConnection = this.#gateway.getConnectionSnapshot();
  }

  getSnapshot(): ControlModelSnapshot {
    return this.#catalog.getSnapshot();
  }

  subscribe(subscriber: ControlModelSubscriber): () => void {
    return this.#catalog.subscribe(subscriber);
  }

  start(): void {
    this.#assertActive();
    if (this.#running) {
      return;
    }
    this.#running = true;
    this.#unsubscribeConnection = this.#gateway.subscribeConnection(() => this.#readConnection());
    this.#unsubscribeEvents = this.#gateway.subscribeEvents((frame) => this.#handleEvent(frame));
    this.#catalog.start();
    this.#lastConnection = this.#gateway.getConnectionSnapshot();
    if (this.#lastConnection.status === "connected") {
      this.#startConversations();
    }
  }

  refreshSessions(
    options?: ControlModelRequestOptions,
    query?: ControlModelSessionCatalogQuery,
  ): Promise<void> {
    this.#assertActive();
    return this.#catalog.refreshSessions(options, query);
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#unsubscribeConnection?.();
    this.#unsubscribeEvents?.();
    this.#unsubscribeConnection = null;
    this.#unsubscribeEvents = null;
    for (const conversation of this.#conversations.values()) {
      conversation.dispose();
    }
    this.#conversations.clear();
    if (this.#ownsCatalog) {
      this.#catalog.dispose();
    }
  }

  conversation(
    sessionKey: string,
    options: Readonly<{ agentId?: string }> = {},
  ): ControlModelConversation {
    this.#assertActive();
    const key = sessionKey.trim();
    if (!key) {
      throw new ControlModelCommandError({
        category: "invalid-input",
        code: "EMPTY_SESSION_KEY",
        message: "Session key is required",
        command: "conversation",
      });
    }
    const agentId = options.agentId?.trim() || undefined;
    const conversationId = `${agentId ?? ""}\u0000${key}`;
    const existing = this.#conversations.get(conversationId);
    if (existing) {
      existing.startIfNeeded();
      return existing;
    }
    while (true) {
      const inactive = [...this.#conversations.values()]
        .filter((conversation) => conversation.isEvictable)
        .toSorted((left, right) => left.lastUsed - right.lastUsed);
      if (inactive.length < this.#maxInactiveConversations) {
        break;
      }
      const candidate = inactive[0];
      if (!candidate) {
        break;
      }
      candidate.dispose();
      for (const [id, value] of this.#conversations) {
        if (value === candidate) {
          this.#conversations.delete(id);
        }
      }
    }
    const host: ControlModelConversationHost = {
      gateway: this.#gateway,
      agentId: agentId ?? this.#agentId,
      bounds: this.#conversationBounds,
      autoLoadHistory: this.#autoLoadConversationHistory,
      getConnectionSnapshot: () => this.#gateway.getConnectionSnapshot(),
      isRunning: () => this.#running && !this.#disposed,
      getMessageSubscriptionCoordinator: () => this.#getMessageSubscriptionCoordinator(),
      onConversationReleased: async (conversation) => {
        for (const [id, value] of this.#conversations) {
          if (value === conversation) {
            conversation.dispose();
            this.#conversations.delete(id);
            return;
          }
        }
      },
      now: this.#now,
      generateId: this.#generateId,
      reportSubscriberError: (error) => this.#reportSubscriberError(error),
      reportBackgroundError: (error) => this.#reportBackgroundError(error),
    };
    const conversation = new ControlModelConversation(host, key);
    this.#conversations.set(conversationId, conversation);
    conversation.startIfNeeded();
    return conversation;
  }

  async releaseConversation(
    sessionKey: string,
    options: Readonly<{ agentId?: string }> = {},
  ): Promise<void> {
    this.#assertActive();
    const key = sessionKey.trim();
    if (!key) {
      throw new ControlModelCommandError({
        category: "invalid-input",
        code: "EMPTY_SESSION_KEY",
        message: "Session key is required",
        command: "releaseConversation",
      });
    }
    const conversation = this.#conversations.get(`${options.agentId?.trim() || ""}\u0000${key}`);
    if (!conversation) {
      return;
    }
    await conversation.release();
  }

  #readConnection(): void {
    if (!this.#running || this.#disposed) {
      return;
    }
    const connection = this.#gateway.getConnectionSnapshot();
    const previous = this.#lastConnection;
    this.#lastConnection = connection;
    if (connection.epoch !== previous.epoch || connection.status !== "connected") {
      if (this.#messageSubscriptionCoordinator) {
        resetGatewaySessionMessageSubscriptionCoordinator(
          this.#messageSubscriptionClient ?? this.#gateway,
          this.#messageSubscriptionCoordinator,
        );
        this.#messageSubscriptionCoordinator = null;
        this.#messageSubscriptionClient = null;
      }
      for (const conversation of this.#conversations.values()) {
        if (connection.status === "connected") {
          conversation.onConnection(connection, this.#getMessageSubscriptionCoordinator());
        } else {
          conversation.onDisconnected(connection);
        }
      }
    }
    if (connection.status === "connected") {
      this.#startConversations();
    }
  }

  #getMessageSubscriptionCoordinator() {
    if (!this.#messageSubscriptionCoordinator) {
      this.#messageSubscriptionClient =
        this.#gateway.getSessionMessageSubscriptionClient?.() ?? this.#gateway;
      this.#messageSubscriptionCoordinator = getGatewaySessionMessageSubscriptionCoordinator(
        this.#messageSubscriptionClient,
      );
    }
    return this.#messageSubscriptionCoordinator;
  }

  #startConversations(): void {
    for (const conversation of this.#conversations.values()) {
      conversation.startIfNeeded();
    }
  }

  #handleEvent(frame: ControlModelGatewayEventFrame): void {
    if (!this.#running || this.#disposed) {
      return;
    }
    const connection = this.#gateway.getConnectionSnapshot();
    if (connection.status !== "connected" || frame.connectionEpoch !== connection.epoch) {
      return;
    }
    for (const conversation of this.#conversations.values()) {
      conversation.handleEvent(frame);
    }
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
      // The conversation remains observable when reporting fails.
    }
  }

  #assertActive(): void {
    if (this.#disposed) {
      throw new ControlModelDisposedError();
    }
  }
}

export function createControlModel(options: ControlModelOptions): ControlModel {
  return new ControlModelImpl(options);
}

export function createControlModelConversationModel(
  options: ControlModelConversationModelOptions,
): ControlModel {
  return new ControlModelImpl(options, options.catalog);
}
