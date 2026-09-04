import {
  createSessionProjection,
  reduceSessionProjection,
  reduceSessionProjectionRunEvent,
  releaseGatewaySessionMessageSubscription,
  type GatewaySessionMessageSubscription,
  type GatewaySessionMessageSubscriptionCoordinator,
  type SessionProjectionGatewayRunEvent,
  type SessionProjectionState,
} from "../browser.js";
import { ConversationArtifactStore } from "./conversation-artifacts.js";
import { ConversationCommandController } from "./conversation-commands.js";
import { ConversationHistoryController } from "./conversation-history.js";
import { ConversationInteractionStore } from "./conversation-interactions.js";
import {
  buildConversationSnapshot,
  type ConversationTruncationState,
} from "./conversation-snapshot.js";
import { ConversationToolStore } from "./conversation-tools.js";
import {
  ControlModelCommandError,
  type ControlModelConversationHost,
  type ControlModelConversationSnapshot,
  type ControlModelConversationStatus,
  type ControlModelConversationSubscriber,
  type ControlModelGatewayEventFrame,
  type ControlModelMaterializedView,
  type ControlModelMaterializeViewInput,
  type ControlModelSendInput,
  type ControlModelSendResult,
} from "./conversation-types.js";
import {
  connectionError,
  eventAgentId,
  eventSessionKey,
  localError,
  normalizeGatewayError,
  record,
  text,
} from "./conversation-utils.js";
import type { ControlModelConnectionSnapshot, ControlModelRequestOptions } from "./model.js";

export { ControlModelCommandError } from "./conversation-types.js";
export type {
  ControlModelCommandCategory,
  ControlModelConversationApproval,
  ControlModelConversationBounds,
  ControlModelConversationHistory,
  ControlModelConversationHost,
  ControlModelConversationMessage,
  ControlModelConversationQuestion,
  ControlModelConversationRun,
  ControlModelConversationSnapshot,
  ControlModelConversationStatus,
  ControlModelConversationSubscriber,
  ControlModelConversationTool,
  ControlModelGatewayEventFrame,
  ControlModelSendInput,
  ControlModelSendResult,
  ControlModelToolStatus,
  ControlModelMaterializedView,
  ControlModelMaterializeViewInput,
} from "./conversation-types.js";

export class ControlModelConversation {
  readonly #host: ControlModelConversationHost;
  readonly #sessionKey: string;
  #canonicalSessionKey: string;
  readonly #subscribers = new Set<ControlModelConversationSubscriber>();
  readonly #artifacts: ConversationArtifactStore;
  readonly #tools: ConversationToolStore;
  readonly #interactions: ConversationInteractionStore;
  readonly #history: ConversationHistoryController;
  readonly #commands: ConversationCommandController;
  #projection: SessionProjectionState;
  #snapshot: ControlModelConversationSnapshot;
  #connection: ControlModelConnectionSnapshot;
  #status: ControlModelConversationStatus = "idle";
  #revision = 0;
  #partialReasons = new Set<string>();
  #leases: {
    plain: GatewaySessionMessageSubscription | null;
    approvals: GatewaySessionMessageSubscription | null;
  } = { plain: null, approvals: null };
  #activationEpoch: number | null = null;
  #activationGeneration = 0;
  #activation: Promise<void> | null = null;
  #disposed = false;
  #notificationScheduled = false;
  #lastUsed = 0;
  #boundsTruncated: ConversationTruncationState = {
    messages: false,
    runs: false,
  };

  constructor(host: ControlModelConversationHost, sessionKey: string) {
    this.#host = host;
    this.#sessionKey = sessionKey;
    this.#canonicalSessionKey = sessionKey;
    this.#connection = host.getConnectionSnapshot();
    this.#artifacts = new ConversationArtifactStore({
      host,
      sessionKey,
      assertCommandReady: (command) => this.#assertCommandReady(command),
      captureEpoch: (command) => this.#captureEpoch(command),
      assertEpoch: (epoch, command) => this.#assertEpoch(epoch, command),
      matchesSessionKey: (key) => this.#matchesSessionKey(key),
      getCurrentArtifacts: () => this.#snapshot.artifacts,
      normalizeCommandError: (error, command, epoch) => {
        if (epoch !== null) {
          this.#assertEpoch(epoch, command);
        }
        return normalizeGatewayError(error, command);
      },
      publish: () => this.#publish(),
    });
    this.#tools = new ConversationToolStore(host.bounds);
    this.#interactions = new ConversationInteractionStore({
      host,
      sessionKey,
      partialReasons: this.#partialReasons,
      matchesSessionKey: (key) => this.#matchesSessionKey(key),
      matchesQuestionEvent: (question) => this.#eventMatches(question, "question.requested"),
      isDisposed: () => this.#disposed,
      publish: () => this.#publish(),
    });
    this.#history = new ConversationHistoryController({
      host,
      sessionKey,
      partialReasons: this.#partialReasons,
      isDisposed: () => this.#disposed,
      captureEpoch: (command) => this.#captureEpoch(command),
      assertEpoch: (epoch, command) => this.#assertEpoch(epoch, command),
      getProjection: () => this.#projection,
      setProjection: (projection) => {
        this.#projection = projection;
      },
      restoreInFlightRun: (value) => this.#restoreInFlightRun(value),
      boundProjectionEntries: () => this.#boundProjectionEntries(),
      setMessagesTruncated: (truncated) => {
        this.#boundsTruncated.messages = truncated;
      },
      setStatus: (status) => {
        this.#status = status;
      },
      publish: () => this.#publish(),
    });
    this.#commands = new ConversationCommandController({
      host,
      sessionKey,
      interactions: this.#interactions,
      assertCommandReady: (command) => this.#assertCommandReady(command),
      captureEpoch: (command) => this.#captureEpoch(command),
      assertEpoch: (epoch, command) => this.#assertEpoch(epoch, command),
      activeRunId: () => this.#activeRunId(),
      applyProjection: (event) => this.#applyProjection(event),
    });
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
    return (
      this.#commands.hasActiveOperations ||
      this.#artifacts.hasActiveOperations ||
      this.#activation !== null ||
      this.#history.hasActiveOperation
    );
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
    if (this.#subscribers.size >= this.#host.bounds.maxSubscribers) {
      throw localError(
        "conflict",
        "subscribe",
        "Conversation subscriber limit reached",
        "SUBSCRIBER_LIMIT",
      );
    }
    this.#subscribers.add(subscriber);
    this.#lastUsed = this.#host.now();
    return () => this.#subscribers.delete(subscriber);
  }

  startIfNeeded(): void {
    if (this.#disposed || !this.#host.isRunning()) {
      return;
    }
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
    if (this.#disposed) {
      return;
    }
    this.#connection = connection;
    if (this.#activationEpoch === connection.epoch) {
      return;
    }
    this.#releaseLeases();
    this.#canonicalSessionKey = this.#sessionKey;
    this.#activationGeneration += 1;
    const generation = this.#activationGeneration;
    this.#activationEpoch = connection.epoch;
    this.#artifacts.beginEpoch(this.#projection.entries);
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
          this.#interactions.applyApprovalReplay(approvals.approvalReplay);
        } catch (error) {
          if (generation !== this.#activationGeneration || this.#disposed) {
            return;
          }
          this.#partialReasons.add("approvals-unavailable");
          this.#host.reportBackgroundError(
            normalizeGatewayError(error, "sessions.messages.subscribe"),
          );
          this.#publish();
        }
        await Promise.allSettled([
          this.refreshHistory(),
          this.#interactions.hydrateQuestions(connection.epoch),
        ]);
        if (generation !== this.#activationGeneration || this.#disposed) {
          return;
        }
        if (
          !this.#partialReasons.has("approvals-unavailable") &&
          !this.#partialReasons.has("questions-unavailable") &&
          this.#history.status === "ready"
        ) {
          this.#partialReasons.delete("transport-gap");
        }
        this.#status =
          this.#history.status === "error"
            ? "error"
            : this.#partialReasons.size > 0
              ? "partial"
              : "ready";
        this.#publish();
      } catch (error) {
        if (generation === this.#activationGeneration && !this.#disposed) {
          this.#activationEpoch = null;
          this.#status = "error";
          this.#history.setActivationError(error);
          this.#publish();
          this.#host.reportBackgroundError(error);
        }
      } finally {
        if (generation === this.#activationGeneration) {
          this.#activation = null;
        }
      }
    })();
    void this.#activation.catch(() => undefined);
  }

  handleEvent(frame: ControlModelGatewayEventFrame): void {
    if (this.#disposed) {
      return;
    }
    const connection = this.#host.getConnectionSnapshot();
    this.#connection = connection;
    if (connection.status !== "connected" || frame.connectionEpoch !== connection.epoch) {
      return;
    }
    const payload = record(frame.payload);
    const hasGap =
      (frame.gap !== undefined && frame.gap !== false) ||
      (payload?.gap !== undefined && payload.gap !== false);
    if (hasGap) {
      this.#partialReasons.add("transport-gap");
      this.#status = "partial";
      this.#applyProjection({ type: "transportGap", scope: { sessionKey: this.#sessionKey } });
      this.#scheduleHistoryRefresh();
      void this.#interactions.hydrateQuestions(frame.connectionEpoch);
    }
    if (!payload || !this.#eventMatches(payload, frame.event)) {
      return;
    }
    switch (frame.event) {
      case "chat":
        this.#handleChat(payload);
        break;
      case "session.message":
        if (payload.message !== undefined) {
          this.#applyProjection({
            type: "messagePersisted",
            message: payload.message,
            envelope: payload,
            scope: { sessionKey: this.#sessionKey },
          });
        } else {
          this.#scheduleHistoryRefresh();
        }
        break;
      case "sessions.changed":
        if (
          payload.reason !== "reset" &&
          payload.phase !== "reset" &&
          payload.change !== "reset" &&
          payload.reset !== true
        ) {
          break;
        }
        this.#artifacts.reset();
        this.#history.invalidatePending();
        this.#applyProjection({ type: "sessionReset", scope: { sessionKey: this.#sessionKey } });
        this.#partialReasons.add("session-reset-awaiting-history");
        this.#status = "partial";
        this.#scheduleHistoryRefresh();
        break;
      case "agent":
        this.#handleAgent(payload);
        break;
      case "session.approval":
        this.#interactions.upsertApproval(payload.approval ?? payload);
        break;
      case "question.requested":
        this.#interactions.upsertQuestion(payload.question ?? payload);
        break;
      case "question.resolved":
        this.#interactions.resolveQuestionEvent(payload);
        break;
      default:
        break;
    }
  }

  onDisconnected(connection: ControlModelConnectionSnapshot): void {
    if (this.#disposed) {
      return;
    }
    this.#connection = connection;
    this.#activationGeneration += 1;
    this.#activationEpoch = null;
    this.#activation = null;
    this.#releaseLeases();
    this.#artifacts.retireMaterializedViews();
    this.#status = "stale";
    this.#partialReasons.add("disconnected");
    this.#publish();
  }

  async refreshHistory(options?: ControlModelRequestOptions): Promise<void> {
    this.#assertCommandReady("chat.history");
    return this.#history.refresh(options);
  }

  async loadMoreHistory(options?: ControlModelRequestOptions): Promise<void> {
    this.#assertCommandReady("chat.history");
    return this.#history.loadMore(options);
  }

  async send(
    input: ControlModelSendInput,
    options?: ControlModelRequestOptions,
  ): Promise<ControlModelSendResult> {
    return this.#commands.send(input, options);
  }

  async abort(
    runId?: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#commands.abort(runId, options);
  }

  async resolveApproval(
    id: string,
    decision: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#commands.resolveApproval(id, decision, options);
  }

  answerQuestion(
    id: string,
    answers: Readonly<Record<string, readonly string[]>>,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#commands.answerQuestion(id, answers, options);
  }
  cancelQuestion(
    id: string,
    options?: ControlModelRequestOptions,
  ): Promise<Readonly<Record<string, unknown>>> {
    return this.#commands.cancelQuestion(id, options);
  }

  materializeView(
    input: ControlModelMaterializeViewInput,
    options?: ControlModelRequestOptions,
  ): Promise<ControlModelMaterializedView> {
    return this.#artifacts.materialize(input, options);
  }

  async release(): Promise<void> {
    await this.#host.onConversationReleased(this);
  }
  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    this.#activationGeneration += 1;
    this.#status = "disposed";
    this.#releaseLeases();
    this.#subscribers.clear();
    this.#publish();
  }

  #captureEpoch(command: string): number {
    this.#assertNotDisposed();
    const connection = this.#host.getConnectionSnapshot();
    if (connection.status !== "connected") {
      throw connectionError(command, connection);
    }
    this.#connection = connection;
    return connection.epoch;
  }
  #assertEpoch(epoch: number, command: string): void {
    const current = this.#host.getConnectionSnapshot();
    this.#connection = current;
    if (this.#disposed || current.status !== "connected" || current.epoch !== epoch) {
      throw localError(
        "stale",
        command,
        "Gateway response belongs to a retired connection",
        "STALE_EPOCH",
      );
    }
  }
  #assertCommandReady(command: string): void {
    this.#assertNotDisposed();
    const connection = this.#host.getConnectionSnapshot();
    this.#connection = connection;
    if (!this.#host.isRunning()) {
      throw localError("disconnected", command, "Control Model is not running", "NOT_READY");
    }
    if (connection.status !== "connected") {
      throw connectionError(command, connection);
    }
  }
  #assertNotDisposed(): void {
    if (this.#disposed) {
      throw localError("disposed", "conversation", "Conversation has been disposed", "DISPOSED");
    }
  }
  #scheduleHistoryRefresh(): void {
    if (this.#disposed || this.#connection.status !== "connected") {
      return;
    }
    if (!this.#history.requestRefresh()) {
      return;
    }
    queueMicrotask(() => {
      if (this.#disposed) {
        return;
      }
      void this.#history.refresh().catch((error: unknown) => {
        if (!(error instanceof ControlModelCommandError && error.category === "stale")) {
          this.#host.reportBackgroundError(error);
        }
      });
    });
  }
  #eventMatches(payload: Record<string, unknown>, event?: string): boolean {
    const payloadAgentId = eventAgentId(payload);
    if (
      this.#host.agentId &&
      payloadAgentId &&
      payloadAgentId.toLowerCase() !== this.#host.agentId.toLowerCase()
    ) {
      return false;
    }
    const key = eventSessionKey(payload);
    if (key) {
      return this.#matchesSessionKey(key);
    }
    const data = record(payload.data);
    const runId = text(payload.runId) ?? text(data?.runId);
    if (event === "agent") {
      return Boolean(runId && this.#projection.runs[runId]);
    }
    if (
      event === "question.resolved" &&
      payload.id !== undefined &&
      this.#interactions.hasQuestion(text(payload.id) ?? "")
    ) {
      return true;
    }
    return Boolean(runId && this.#projection.runs[runId]);
  }

  #handleChat(payload: Record<string, unknown>): void {
    const state = text(payload.state);
    const runId = text(payload.runId);
    if (!runId) {
      return;
    }
    if (state === "status") {
      this.#applyProjection({ type: "runDelta", runId, scope: { sessionKey: this.#sessionKey } });
      return;
    }
    const transition = reduceSessionProjectionRunEvent(
      this.#projection,
      // SAFETY: chat event payloads are narrowed by event type and validated by the reducer.
      payload as SessionProjectionGatewayRunEvent,
      { sessionKey: this.#sessionKey },
    );
    if (!transition) {
      return;
    }
    this.#projection = transition.projection;
    this.#boundProjectionEntries();
    this.#publish();
  }

  #handleAgent(payload: Record<string, unknown>): void {
    if (this.#tools.handle(payload, (runId) => Boolean(this.#projection.runs[runId]))) {
      this.#artifacts.ingestToolEvent(payload);
      this.#publish();
    }
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
    if (leases.approvals) {
      void releaseGatewaySessionMessageSubscription(leases.approvals).catch((error: unknown) =>
        this.#host.reportBackgroundError(error),
      );
    }
    if (leases.plain) {
      void releaseGatewaySessionMessageSubscription(leases.plain).catch((error: unknown) =>
        this.#host.reportBackgroundError(error),
      );
    }
  }

  #matchesSessionKey(key: string): boolean {
    return key === this.#sessionKey || key === this.#canonicalSessionKey;
  }

  #applyProjection(event: Parameters<typeof reduceSessionProjection>[1]): void {
    const next = reduceSessionProjection(this.#projection, event);
    if (next === this.#projection) {
      return;
    }
    this.#projection = next;
    this.#boundProjectionEntries();
    this.#publish();
  }

  #restoreInFlightRun(value: unknown): void {
    const inFlight = record(value);
    const runId = text(inFlight?.runId);
    if (!runId) {
      return;
    }
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
      if (payload) {
        this.#handleAgent({ ...payload, sessionKey: this.#sessionKey });
      }
    }
  }

  #boundProjectionEntries(): void {
    const maxMessages = this.#host.bounds.maxMessages;
    if (this.#projection.entries.length <= maxMessages) {
      return;
    }
    const entries =
      this.#history.window === "older"
        ? this.#projection.entries.slice(0, maxMessages)
        : this.#projection.entries.slice(-maxMessages);
    this.#projection = {
      ...this.#projection,
      entries,
      messages: entries.map((entry) => entry.message),
    };
    this.#boundsTruncated.messages = true;
    this.#partialReasons.add("messages-truncated");
    this.#history.markProjectionTruncated();
  }

  #buildSnapshot(): ControlModelConversationSnapshot {
    return buildConversationSnapshot({
      sessionKey: this.#sessionKey,
      status: this.#status,
      revision: this.#revision,
      connection: this.#connection,
      history: this.#history.snapshot(),
      projection: this.#projection,
      maxMessages: this.#host.bounds.maxMessages,
      maxRuns: this.#host.bounds.maxRuns,
      tools: this.#tools,
      artifacts: this.#artifacts,
      canMaterializeArtifacts: this.#host.gateway.materializeArtifactView !== undefined,
      interactions: this.#interactions,
      partialReasons: this.#partialReasons,
      truncation: this.#boundsTruncated,
    });
  }

  #publish(): void {
    this.#revision += 1;
    this.#snapshot = this.#buildSnapshot();
    this.#scheduleNotification();
  }
  #scheduleNotification(): void {
    if (this.#notificationScheduled || this.#disposed) {
      return;
    }
    this.#notificationScheduled = true;
    queueMicrotask(() => {
      this.#notificationScheduled = false;
      if (this.#disposed) {
        return;
      }
      for (const subscriber of Array.from(this.#subscribers)) {
        if (this.#disposed) {
          break;
        }
        try {
          const result = subscriber();
          if (result && typeof result.then === "function") {
            void result.catch((error: unknown) => this.#host.reportSubscriberError(error));
          }
        } catch (error) {
          this.#host.reportSubscriberError(error);
        }
      }
    });
  }
}
