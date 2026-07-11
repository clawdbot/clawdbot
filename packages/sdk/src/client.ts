// OpenClaw SDK module implements client behavior.
import { randomUUID } from "node:crypto";
import { EventHub } from "./event-hub.js";
import { normalizeGatewayEvent } from "./normalize.js";
import { GatewayClientTransport, isConnectableTransport } from "./transport.js";
import type {
  AgentsCreateParams,
  AgentsDeleteParams,
  AgentsUpdateParams,
  AgentRunParams,
  ApprovalDecisionParams,
  ArtifactQuery,
  ArtifactsDownloadResult,
  ArtifactsGetResult,
  ArtifactsListResult,
  EnvironmentCreateParams,
  EnvironmentSummary,
  EnvironmentsListResult,
  GatewayEvent,
  GatewayRequestOptions,
  OpenClawEvent,
  OpenClawTransport,
  RunCreateParams,
  RunResult,
  RunTimestamp,
  SessionCreateParams,
  SessionSendParams,
  SessionTarget,
  TasksCancelResult,
  TasksGetResult,
  TasksListParams,
  TasksListResult,
  ToolsEffectiveParams,
  ToolInvokeParams,
  ToolInvokeResult,
} from "./types.js";

// High-level OpenClaw SDK client. Namespaces below translate friendly SDK calls
// into current Gateway RPC methods and normalize event streams for consumers.
const MAX_REPLAY_RUNS = 100;
const MAX_REPLAY_EVENTS_PER_RUN = 500;
const MAX_NORMALIZED_REPLAY_EVENTS = 2000;

/** Connection and transport options for the OpenClaw SDK client. */
export type OpenClawOptions = {
  gateway?: "auto" | (string & {});
  url?: string;
  token?: string;
  password?: string;
  requestTimeoutMs?: number;
  transport?: OpenClawTransport;
};

function resolveGatewayUrl(options: OpenClawOptions): string | undefined {
  if (options.url) {
    return options.url;
  }
  if (options.gateway && options.gateway !== "auto") {
    return options.gateway;
  }
  return undefined;
}

function runStatusFromWaitPayload(payload: unknown): RunResult["status"] {
  // Gateway wait payloads come from several runtime paths. Preserve timeout vs
  // cancellation semantics from metadata instead of trusting one status field.
  const record =
    typeof payload === "object" && payload !== null
      ? (payload as Record<string, unknown> & { aborted?: unknown; status?: unknown })
      : {};
  const status = typeof record.status === "string" ? record.status.toLowerCase() : undefined;
  const stopReason = typeof record.stopReason === "string" ? record.stopReason.toLowerCase() : "";
  const pendingError = record.pendingError === true;
  const timeoutPhase =
    typeof record.timeoutPhase === "string" ? record.timeoutPhase.toLowerCase() : undefined;
  const statusAlreadyTimeoutAttributed = status === "timeout" || status === "timed_out";
  const hardTimeout =
    !pendingError &&
    ((stopReason !== "restart" &&
      record.providerStarted === true &&
      statusAlreadyTimeoutAttributed) ||
      timeoutPhase === "preflight" ||
      timeoutPhase === "provider" ||
      timeoutPhase === "post_turn");
  const hasTerminalTimeoutMetadata =
    readOptionalTimestamp(record.endedAt) !== undefined ||
    (!pendingError && readOptionalString(record.error) !== undefined) ||
    stopReason.length > 0 ||
    typeof record.livenessState === "string" ||
    record.yielded === true;
  if (hardTimeout) {
    return "timed_out";
  }
  if (
    status === "aborted" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "killed" ||
    stopReason === "aborted" ||
    stopReason === "cancelled" ||
    stopReason === "canceled" ||
    stopReason === "killed" ||
    stopReason === "auth-revoked" ||
    stopReason === "restart" ||
    stopReason === "rpc" ||
    stopReason === "user" ||
    (record.aborted === true && stopReason === "stop")
  ) {
    return "cancelled";
  }
  if (status === "ok" || status === "completed" || status === "succeeded") {
    return "completed";
  }
  if (status === "timeout") {
    if (
      stopReason === "timeout" ||
      stopReason === "timed_out" ||
      record.aborted === true ||
      hasTerminalTimeoutMetadata
    ) {
      return "timed_out";
    }
    return "accepted";
  }
  if (status === "timed_out") {
    return "timed_out";
  }
  if (status === "accepted") {
    return "accepted";
  }
  return "failed";
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalTimestamp(value: unknown): RunTimestamp | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new Error("timeoutMs must be a finite non-negative number");
  }
  return Math.floor(timeoutMs);
}

function timeoutSecondsFromMs(timeoutMs: number | undefined): number | undefined {
  const normalized = normalizeTimeoutMs(timeoutMs);
  if (normalized === undefined) {
    return undefined;
  }
  return normalized === 0 ? 0 : Math.ceil(normalized / 1000);
}

function splitModelRef(model: string | undefined): { provider?: string; model?: string } {
  if (!model) {
    return {};
  }
  const index = model.indexOf("/");
  if (index <= 0 || index === model.length - 1) {
    return { model };
  }
  return {
    provider: model.slice(0, index),
    model: model.slice(index + 1),
  };
}

function assertNoUnsupportedRunOptions(params: AgentRunParams): void {
  const unsupported = [
    params.workspace ? "workspace" : undefined,
    params.runtime ? "runtime" : undefined,
    params.environment ? "environment" : undefined,
    params.approvals ? "approvals" : undefined,
  ].filter((value): value is string => Boolean(value));
  if (unsupported.length === 0) {
    return;
  }
  throw new Error(
    `OpenClaw Gateway does not support per-run SDK option${
      unsupported.length === 1 ? "" : "s"
    } yet: ${unsupported.join(", ")}`,
  );
}

function buildAgentParams(params: AgentRunParams): Record<string, unknown> {
  assertNoUnsupportedRunOptions(params);
  const modelRef = splitModelRef(params.model);
  const timeoutSeconds = timeoutSecondsFromMs(params.timeoutMs);
  return {
    message: params.input,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(modelRef.provider ? { provider: modelRef.provider } : {}),
    ...(modelRef.model ? { model: modelRef.model } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.thinking ? { thinking: params.thinking } : {}),
    ...(typeof params.deliver === "boolean" ? { deliver: params.deliver } : {}),
    ...(params.attachments ? { attachments: params.attachments } : {}),
    ...(timeoutSeconds !== undefined ? { timeout: timeoutSeconds } : {}),
    ...(params.label ? { label: params.label } : {}),
    idempotencyKey: params.idempotencyKey ?? randomUUID(),
  };
}

function unsupportedGatewayApi(api: string): never {
  throw new Error(`${api} is not supported by the current OpenClaw Gateway yet`);
}

type ChatProjectionState = "delta" | "final";

type ChatProjection = {
  state: ChatProjectionState;
  payload: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function hasArtifactQueryScope(params: unknown): params is ArtifactQuery {
  const record = asRecord(params);
  return [record.sessionKey, record.runId, record.taskId].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function requireArtifactQueryScope(api: string, params: unknown): ArtifactQuery {
  if (!hasArtifactQueryScope(params)) {
    throw new Error(`${api} requires one of sessionKey, runId, or taskId`);
  }
  return params;
}

function hasToolsEffectiveSessionKey(params: unknown): params is ToolsEffectiveParams {
  const record = asRecord(params);
  return typeof record.sessionKey === "string" && record.sessionKey.trim().length > 0;
}

function requireToolsEffectiveSessionKey(params: unknown): ToolsEffectiveParams {
  if (!hasToolsEffectiveSessionKey(params)) {
    throw new Error("oc.tools.effective requires sessionKey");
  }
  return params;
}

function readChatProjection(event: OpenClawEvent): ChatProjection | undefined {
  const raw = event.raw;
  if (event.type !== "raw" || raw?.event !== "chat") {
    return undefined;
  }
  const payload = asRecord(raw.payload);
  return payload.state === "delta" || payload.state === "final"
    ? { state: payload.state, payload }
    : undefined;
}

function readChatProjectionText(payload: Record<string, unknown>): string | undefined {
  const message = asRecord(payload.message);
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const text = content
    .map((part) => {
      const record = asRecord(part);
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
  return text.length > 0 ? text : undefined;
}

function readChatProjectionDeltaText(payload: Record<string, unknown>): string | undefined {
  return typeof payload.deltaText === "string" ? payload.deltaText : undefined;
}

function readChatProjectionReplace(payload: Record<string, unknown>): boolean {
  return payload.replace === true;
}

function isAssistantRunEvent(event: OpenClawEvent): boolean {
  return event.type === "assistant.delta" || event.type === "assistant.message";
}

function isTerminalRunEvent(event: OpenClawEvent): boolean {
  return (
    event.type === "run.completed" ||
    event.type === "run.failed" ||
    event.type === "run.cancelled" ||
    event.type === "run.timed_out"
  );
}

function normalizeChatProjectionEvent(
  event: OpenClawEvent,
  projection: ChatProjection,
  previousText: string | undefined,
): OpenClawEvent {
  const text = readChatProjectionText(projection.payload);
  const deltaText = readChatProjectionDeltaText(projection.payload);
  const hasPreviousText = previousText !== undefined;
  const isReplacement = readChatProjectionReplace(projection.payload);
  return {
    ...event,
    type: projection.state === "delta" ? "assistant.delta" : "run.completed",
    data:
      projection.state === "delta"
        ? text !== undefined
          ? {
              text,
              delta: hasPreviousText ? (deltaText ?? text) : text,
              ...(isReplacement ? { replace: true } : {}),
            }
          : event.data
        : { phase: "end", ...(text !== undefined ? { outputText: text } : {}) },
  };
}

/** Root SDK client with namespaces for agents, sessions, runs, and gateway APIs. */
export class OpenClaw {
  readonly agents: AgentsNamespace;
  readonly sessions: SessionsNamespace;
  readonly runs: RunsNamespace;
  readonly tasks: TasksNamespace;
  readonly models: ModelsNamespace;
  readonly tools: ToolsNamespace;
  readonly artifacts: ArtifactsNamespace;
  readonly approvals: ApprovalsNamespace;
  readonly environments: EnvironmentsNamespace;

  private readonly transport: OpenClawTransport;
  private readonly normalizedEvents = new EventHub<OpenClawEvent>({
    replayLimit: MAX_NORMALIZED_REPLAY_EVENTS,
  });
  private readonly replayByRunId = new Map<string, OpenClawEvent[]>();
  private connected = false;
  private closed = false;
  private eventPumpPromise: Promise<void> | null = null;
  private eventPumpReady: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: OpenClawOptions = {}) {
    this.transport =
      options.transport ??
      new GatewayClientTransport({
        url: resolveGatewayUrl(options),
        token: options.token,
        password: options.password,
        requestTimeoutMs: options.requestTimeoutMs,
      });
    this.agents = new AgentsNamespace(this);
    this.sessions = new SessionsNamespace(this);
    this.runs = new RunsNamespace(this);
    this.tasks = new TasksNamespace(this);
    this.models = new ModelsNamespace(this);
    this.tools = new ToolsNamespace(this);
    this.artifacts = new ArtifactsNamespace(this);
    this.approvals = new ApprovalsNamespace(this);
    this.environments = new EnvironmentsNamespace(this);
  }

  async connect(): Promise<void> {
    this.assertOpen();
    if (this.connected) {
      await this.startEventPump();
      this.assertOpen();
      return;
    }
    if (isConnectableTransport(this.transport)) {
      await this.transport.connect();
    }
    this.assertOpen();
    this.connected = true;
    await this.startEventPump();
    this.assertOpen();
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return await this.closePromise;
    }
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closePromise = (async () => {
      try {
        await this.transport.close?.();
        await this.eventPumpPromise?.catch(() => {});
      } finally {
        this.normalizedEvents.close();
        this.eventPumpPromise = null;
        this.eventPumpReady = null;
        this.connected = false;
      }
    })();
    try {
      await this.closePromise;
    } finally {
      this.closePromise = null;
    }
  }

  async request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    await this.connect();
    this.assertOpen();
    return await this.transport.request<T>(method, params, options);
  }

  events(filter?: (event: OpenClawEvent) => boolean): AsyncIterable<OpenClawEvent> {
    return this.iterateEvents(filter);
  }

  runEvents(
    runId: string,
    filter?: (event: OpenClawEvent) => boolean,
  ): AsyncIterable<OpenClawEvent> {
    return this.iterateRunEvents(runId, filter);
  }

  rawEvents(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent> {
    this.assertOpen();
    return this.transport.events(filter);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("OpenClaw SDK client is closed");
    }
  }

  private async *iterateEvents(
    filter?: (event: OpenClawEvent) => boolean,
  ): AsyncIterable<OpenClawEvent> {
    await this.connect();
    this.assertOpen();
    for await (const event of this.normalizedEvents.stream(filter)) {
      yield event;
    }
  }

  private async *iterateRunEvents(
    runId: string,
    filter?: (event: OpenClawEvent) => boolean,
  ): AsyncIterable<OpenClawEvent> {
    await this.connect();
    this.assertOpen();
    const replayEvents = this.replaySnapshot(runId);
    let hasCanonicalAssistantRunEvent = replayEvents.some(isAssistantRunEvent);
    let hasTerminalRunEvent = replayEvents.some(isTerminalRunEvent);
    let previousChatProjectionText: string | undefined;
    const toRunStreamEvent = (event: OpenClawEvent): OpenClawEvent | undefined => {
      const chatProjection = readChatProjection(event);
      if (chatProjection?.state === "delta") {
        if (hasCanonicalAssistantRunEvent) {
          return undefined;
        }
        const runEvent = normalizeChatProjectionEvent(
          event,
          chatProjection,
          previousChatProjectionText,
        );
        const text = readChatProjectionText(chatProjection.payload);
        if (text !== undefined) {
          previousChatProjectionText = text;
        }
        return runEvent;
      }
      if (chatProjection?.state === "final") {
        if (hasTerminalRunEvent) {
          return undefined;
        }
        hasTerminalRunEvent = true;
        return normalizeChatProjectionEvent(event, chatProjection, previousChatProjectionText);
      }
      if (isAssistantRunEvent(event)) {
        hasCanonicalAssistantRunEvent = true;
      }
      if (isTerminalRunEvent(event)) {
        hasTerminalRunEvent = true;
      }
      return event;
    };
    const matches = (event: OpenClawEvent) => event.runId === runId;
    const liveSource = this.normalizedEvents.stream(matches, { replay: true });
    const live = liveSource[Symbol.asyncIterator]();
    const seen = new Set<string>();
    try {
      for (const event of replayEvents) {
        if (seen.has(event.id)) {
          continue;
        }
        seen.add(event.id);
        const runEvent = toRunStreamEvent(event);
        if (!runEvent || (filter && !filter(runEvent))) {
          continue;
        }
        yield runEvent;
      }
      while (true) {
        const next = await live.next();
        if (next.done) {
          break;
        }
        if (seen.has(next.value.id)) {
          continue;
        }
        seen.add(next.value.id);
        const runEvent = toRunStreamEvent(next.value);
        if (!runEvent || (filter && !filter(runEvent))) {
          continue;
        }
        yield runEvent;
      }
    } finally {
      await live.return?.();
    }
  }

  private startEventPump(): Promise<void> {
    if (this.eventPumpReady) {
      return this.eventPumpReady;
    }
    let markReady = () => {};
    let ready = false;
    this.eventPumpReady = new Promise<void>((resolve) => {
      markReady = () => {
        if (ready) {
          return;
        }
        ready = true;
        resolve();
      };
    });
    this.eventPumpPromise = (async () => {
      let iterator: AsyncIterator<GatewayEvent> | undefined;
      let pumpError: unknown;
      let hasPumpError = false;
      try {
        iterator = this.transport.events()[Symbol.asyncIterator]();
        while (true) {
          const next = iterator.next();
          await Promise.resolve();
          markReady();
          const result = await next;
          if (result.done) {
            break;
          }
          const normalized = normalizeGatewayEvent(result.value);
          this.recordReplayEvent(normalized);
          this.normalizedEvents.publish(normalized);
        }
      } catch (error) {
        pumpError = error;
        hasPumpError = true;
      } finally {
        markReady();
        try {
          await iterator?.return?.();
        } catch (error) {
          if (!hasPumpError) {
            pumpError = error;
            hasPumpError = true;
          }
        }
      }
      if (hasPumpError) {
        this.normalizedEvents.close(pumpError);
        return;
      }
      this.normalizedEvents.close();
    })().catch((error: unknown) => {
      markReady();
      this.normalizedEvents.close(error);
    });
    return this.eventPumpReady;
  }

  private recordReplayEvent(event: OpenClawEvent): void {
    if (!event.runId) {
      return;
    }
    let events = this.replayByRunId.get(event.runId);
    if (!events) {
      if (this.replayByRunId.size >= MAX_REPLAY_RUNS) {
        const oldestRunId = this.replayByRunId.keys().next().value;
        if (oldestRunId) {
          this.replayByRunId.delete(oldestRunId);
        }
      }
      events = [];
      this.replayByRunId.set(event.runId, events);
    }
    events.push(event);
    if (events.length > MAX_REPLAY_EVENTS_PER_RUN) {
      events.splice(0, events.length - MAX_REPLAY_EVENTS_PER_RUN);
    }
  }

  private replaySnapshot(runId: string): OpenClawEvent[] {
    return [...(this.replayByRunId.get(runId) ?? [])];
  }
}

/** Agent-scoped helper for runs and identity lookups. */
export class Agent {
  constructor(
    private readonly client: OpenClaw,
    readonly id: string,
  ) {}

  async run(input: string | Omit<AgentRunParams, "agentId">): Promise<Run> {
    const params: AgentRunParams =
      typeof input === "string" ? { input, agentId: this.id } : { ...input, agentId: this.id };
    return await this.client.runs.create(params);
  }

  async identity(params?: { sessionKey?: string }): Promise<unknown> {
    return await this.client.request("agent.identity.get", {
      agentId: this.id,
      ...(params?.sessionKey ? { sessionKey: params.sessionKey } : {}),
    });
  }
}

/** Run handle for streaming events, waiting, and cancellation. */
export class Run {
  constructor(
    private readonly client: OpenClaw,
    readonly id: string,
    readonly sessionKey?: string,
  ) {}

  events(filter?: (event: OpenClawEvent) => boolean): AsyncIterable<OpenClawEvent> {
    return this.client.runEvents(this.id, filter);
  }

  async wait(options?: { timeoutMs?: number }): Promise<RunResult> {
    const timeoutMs = normalizeTimeoutMs(options?.timeoutMs);
    const raw = await this.client.request(
      "agent.wait",
      {
        runId: this.id,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      },
      { timeoutMs: null },
    );
    const record = asRecord(raw);
    const status = runStatusFromWaitPayload(raw);
    const error = readOptionalString(record.error)
      ? { message: readOptionalString(record.error) ?? "run failed" }
      : undefined;
    return {
      runId: this.id,
      status,
      sessionKey: readOptionalString(record.sessionKey) ?? this.sessionKey,
      sessionId: readOptionalString(record.sessionId),
      startedAt: readOptionalTimestamp(record.startedAt),
      endedAt: readOptionalTimestamp(record.endedAt),
      ...(error ? { error } : {}),
      raw,
    };
  }

  async cancel(): Promise<unknown> {
    return await this.client.request("sessions.abort", {
      runId: this.id,
      ...(this.sessionKey ? { key: this.sessionKey } : {}),
    });
  }
}

/** Session handle for sending messages and session-scoped mutations. */
export class Session {
  constructor(
    private readonly client: OpenClaw,
    readonly key: string,
    readonly info?: unknown,
  ) {}

  async send(input: string | Omit<SessionSendParams, "key">): Promise<Run> {
    const params: SessionSendParams =
      typeof input === "string" ? { key: this.key, message: input } : { ...input, key: this.key };
    const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
    if (timeoutMs !== undefined) {
      params.timeoutMs = timeoutMs;
    }
    const raw = await this.client.request("sessions.send", params, {
      expectFinal: true,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs === 0 ? null : timeoutMs } : {}),
    });
    const record = asRecord(raw);
    const runId = readOptionalString(record.runId);
    if (!runId) {
      throw new Error("sessions.send did not return a runId");
    }
    return new Run(this.client, runId, this.key);
  }

  async abort(runId?: string): Promise<unknown> {
    return await this.client.request("sessions.abort", {
      key: this.key,
      ...(runId ? { runId } : {}),
    });
  }

  async patch(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.patch", { ...params, key: this.key });
  }

  async compact(params?: { maxLines?: number }): Promise<unknown> {
    return await this.client.request(
      "sessions.compact",
      { key: this.key, ...params },
      // The server owns the configurable terminal compaction deadline.
      { timeoutMs: null },
    );
  }
}

/** Agent management namespace. */
export class AgentsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("agents.list", params === undefined ? {} : params);
  }

  async get(id: string): Promise<Agent> {
    return new Agent(this.client, id);
  }

  async create(params: AgentsCreateParams): Promise<unknown> {
    return await this.client.request("agents.create", params);
  }

  async update(params: AgentsUpdateParams): Promise<unknown> {
    return await this.client.request("agents.update", params);
  }

  async delete(params: AgentsDeleteParams): Promise<unknown> {
    return await this.client.request("agents.delete", params);
  }
}

/** Session management namespace. */
export class SessionsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.list", params === undefined ? {} : params);
  }

  async create(params: SessionCreateParams = {}): Promise<Session> {
    const raw = await this.client.request("sessions.create", params);
    const record = asRecord(raw);
    const key =
      readOptionalString(record.key) ?? readOptionalString(record.sessionKey) ?? params.key;
    if (!key) {
      throw new Error("sessions.create did not return a session key");
    }
    return new Session(this.client, key, raw);
  }

  async get(target: SessionTarget | string): Promise<Session> {
    const key = typeof target === "string" ? target : target.key;
    return new Session(this.client, key);
  }

  async resolve(params: Record<string, unknown>): Promise<unknown> {
    return await this.client.request("sessions.resolve", params);
  }

  async send(input: SessionSendParams): Promise<Run> {
    return await new Session(this.client, input.key).send(input);
  }
}

/** Run creation and lifecycle namespace. */
export class RunsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async create(params: RunCreateParams): Promise<Run> {
    const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
    const normalizedParams = timeoutMs !== undefined ? { ...params, timeoutMs } : params;
    const raw = await this.client.request("agent", buildAgentParams(normalizedParams), {
      expectFinal: false,
      ...(timeoutMs !== undefined ? { timeoutMs: timeoutMs === 0 ? null : timeoutMs } : {}),
    });
    const record = asRecord(raw);
    const runId = readOptionalString(record.runId);
    if (!runId) {
      throw new Error("agent did not return a runId");
    }
    return new Run(this.client, runId, readOptionalString(record.sessionKey) ?? params.sessionKey);
  }

  async get(runId: string): Promise<Run> {
    return new Run(this.client, runId);
  }

  events(runId: string): AsyncIterable<OpenClawEvent> {
    return new Run(this.client, runId).events();
  }

  async wait(runId: string, options?: { timeoutMs?: number }): Promise<RunResult> {
    return await new Run(this.client, runId).wait(options);
  }

  async cancel(runId: string, sessionKey?: string): Promise<unknown> {
    return await new Run(this.client, runId, sessionKey).cancel();
  }
}

class RpcNamespace {
  constructor(
    protected readonly client: OpenClaw,
    private readonly prefix: string,
  ) {}

  protected async call<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T> {
    return await this.client.request<T>(`${this.prefix}.${method}`, params, options);
  }
}

/** Task query and cancellation namespace. */
export class TasksNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "tasks");
  }

  async list(params?: TasksListParams): Promise<TasksListResult> {
    return await this.call("list", params === undefined ? {} : params);
  }

  async get(taskId: string): Promise<TasksGetResult> {
    return await this.call("get", { taskId });
  }

  async cancel(taskId: string, options?: { reason?: string }): Promise<TasksCancelResult> {
    return await this.call("cancel", {
      taskId,
      ...(options?.reason ? { reason: options.reason } : {}),
    });
  }
}

/** Model catalog and auth status namespace. */
export class ModelsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "models");
  }

  async list(params?: unknown): Promise<unknown> {
    return await this.call("list", params === undefined ? {} : params);
  }

  async status(params?: unknown): Promise<unknown> {
    return await this.call("authStatus", params);
  }
}

/** Tool catalog, effective tool, and direct invocation namespace. */
export class ToolsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "tools");
  }

  async list(params?: unknown): Promise<unknown> {
    return await this.call("catalog", params === undefined ? {} : params);
  }

  async effective(params: ToolsEffectiveParams): Promise<unknown> {
    return await this.call("effective", requireToolsEffectiveSessionKey(params));
  }

  async invoke(name: string, params?: ToolInvokeParams): Promise<ToolInvokeResult> {
    return await this.call("invoke", {
      name,
      conversationReadOrigin: "direct-operator",
      ...(params?.args ? { args: params.args } : {}),
      ...(params?.sessionKey ? { sessionKey: params.sessionKey } : {}),
      ...(params?.agentId ? { agentId: params.agentId } : {}),
      ...(typeof params?.confirm === "boolean" ? { confirm: params.confirm } : {}),
      ...(params?.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    });
  }
}

/** Run/session artifact listing and download namespace. */
export class ArtifactsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "artifacts");
  }

  async list(params: ArtifactQuery): Promise<ArtifactsListResult> {
    return await this.call("list", requireArtifactQueryScope("oc.artifacts.list", params));
  }

  async get(id: string, params: ArtifactQuery): Promise<ArtifactsGetResult> {
    return await this.call("get", {
      ...requireArtifactQueryScope("oc.artifacts.get", params),
      artifactId: id,
    });
  }

  async download(id: string, params: ArtifactQuery): Promise<ArtifactsDownloadResult> {
    return await this.call("download", {
      ...requireArtifactQueryScope("oc.artifacts.download", params),
      artifactId: id,
    });
  }
}

/** Approval request listing and response namespace. */
export class ApprovalsNamespace {
  constructor(private readonly client: OpenClaw) {}

  async list(params?: unknown): Promise<unknown> {
    return await this.client.request("exec.approval.list", params === undefined ? {} : params);
  }

  async respond(approvalId: string, params: ApprovalDecisionParams): Promise<unknown> {
    return await this.client.request("exec.approval.resolve", {
      id: approvalId,
      decision: params.decision,
    });
  }
}

/** Environment discovery namespace. */
export class EnvironmentsNamespace extends RpcNamespace {
  constructor(client: OpenClaw) {
    super(client, "environments");
  }

  async list(params?: unknown): Promise<EnvironmentsListResult> {
    return await this.call("list", params === undefined ? {} : params);
  }

  async create(params: EnvironmentCreateParams): Promise<EnvironmentSummary> {
    return await this.call("create", params);
  }

  async status(environmentId: string): Promise<EnvironmentSummary> {
    return await this.call("status", { environmentId });
  }

  async destroy(environmentId: string): Promise<EnvironmentSummary> {
    return await this.call("destroy", { environmentId });
  }

  async delete(environmentId: string): Promise<unknown> {
    void environmentId;
    return unsupportedGatewayApi("oc.environments.delete");
  }
}
