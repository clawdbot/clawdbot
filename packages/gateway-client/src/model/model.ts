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

const DEFAULT_MAX_INACTIVE_CONVERSATIONS = 32;

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
  #lastConnection: ControlModelConnectionSnapshot;
  #running = false;
  #disposed = false;

  constructor(options: ControlModelOptions, catalog?: ControlModelCatalog) {
    this.#catalog = catalog ?? new ControlModelCatalogImpl(options);
    this.#ownsCatalog = catalog === undefined;
    this.#gateway = options.gateway;
    this.#maxInactiveConversations = normalizeBound(
      options.bounds?.maxInactiveConversations,
      DEFAULT_MAX_INACTIVE_CONVERSATIONS,
    );
    this.#agentId = options.agentId?.trim() || undefined;
    this.#autoLoadConversationHistory = options.autoLoadConversationHistory !== false;
    this.#generateId =
      options.generateId ??
      ((prefix) =>
        `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    this.#conversationBounds = {
      maxSubscribers: normalizeBound(options.bounds?.maxSubscribers, 100),
      maxMessages: normalizeBound(options.bounds?.maxConversationMessages, 200),
      maxRuns: normalizeBound(options.bounds?.maxConversationRuns, 200),
      maxTools: normalizeBound(options.bounds?.maxConversationTools, 100),
      maxApprovals: normalizeBound(options.bounds?.maxConversationApprovals, 100),
      maxQuestions: normalizeBound(options.bounds?.maxConversationQuestions, 100),
      maxProgressUpdates: normalizeBound(options.bounds?.maxConversationProgressUpdates, 100),
      maxProgressBytes: normalizeBound(options.bounds?.maxConversationProgressBytes, 64_000),
      maxMetadataBytes: normalizeBound(options.bounds?.maxConversationStartupMetadataBytes, 64_000),
      maxArtifacts: normalizeBound(options.bounds?.maxConversationArtifacts, 100),
      maxArtifactBytes: normalizeBound(options.bounds?.maxArtifactBytes, 64_000),
      maxArtifactDepth: normalizeBound(options.bounds?.maxArtifactDepth, 12),
      maxArtifactCollectionItems: normalizeBound(options.bounds?.maxArtifactCollectionItems, 256),
      maxArtifactStringBytes: normalizeBound(options.bounds?.maxArtifactStringBytes, 16_000),
      maxArtifactViews: normalizeBound(options.bounds?.maxArtifactViews, 16),
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
    resetGatewaySessionMessageSubscriptionCoordinator(this.#gateway);
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
      getMessageSubscriptionCoordinator: () =>
        getGatewaySessionMessageSubscriptionCoordinator(this.#gateway),
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
      resetGatewaySessionMessageSubscriptionCoordinator(this.#gateway);
      for (const conversation of this.#conversations.values()) {
        if (connection.status === "connected") {
          conversation.onConnection(
            connection,
            getGatewaySessionMessageSubscriptionCoordinator(this.#gateway),
          );
        } else {
          conversation.onDisconnected(connection);
        }
      }
    }
    if (connection.status === "connected") {
      this.#startConversations();
    }
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
