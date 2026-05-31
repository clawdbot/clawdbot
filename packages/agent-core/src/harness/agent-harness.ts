import type {
  AssistantMessage,
  ImageContent,
  Model,
  UserMessage,
} from "../../../llm-core/src/index.js";
import { runAgentLoop } from "../agent-loop.js";
import { type AgentCoreRuntimeDeps, resolveAgentCoreStreamFn } from "../runtime-deps.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  QueueMode,
  StreamFn,
  ThinkingLevel,
} from "../types.js";
import {
  collectEntriesForBranchSummary,
  generateBranchSummary,
} from "./compaction/branch-summarization.js";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
} from "./compaction/compaction.js";
import { convertToLlm } from "./messages.js";
import { formatPromptTemplateInvocation } from "./prompt-templates.js";
import { formatSkillInvocation } from "./skills.js";
import type {
  AbortResult,
  AgentHarnessEvent,
  AgentHarnessEventResultMap,
  AgentHarnessOptions,
  AgentHarnessOwnEvent,
  AgentHarnessPhase,
  AgentHarnessResources,
  AgentHarnessStreamOptions,
  AgentHarnessStreamOptionsPatch,
  ExecutionEnv,
  NavigateTreeResult,
  PendingSessionWrite,
  PromptTemplate,
  Session,
  Skill,
} from "./types.js";
import {
  AgentHarnessError,
  BranchSummaryError,
  CompactionError,
  SessionError,
  toError,
} from "./types.js";

function createUserMessage(text: string, images?: ImageContent[]): UserMessage {
  const content: Array<{ type: "text"; text: string } | ImageContent> = [{ type: "text", text }];
  if (images) {
    content.push(...images);
  }
  return { role: "user", content, timestamp: Date.now() };
}

function createFailureMessage(model: Model, error: unknown, aborted: boolean): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

function cloneStreamOptions(streamOptions?: AgentHarnessStreamOptions): AgentHarnessStreamOptions {
  return {
    ...streamOptions,
    headers: streamOptions?.headers ? { ...streamOptions.headers } : undefined,
    metadata: streamOptions?.metadata ? { ...streamOptions.metadata } : undefined,
  };
}

function mergeHeaders(
  ...headers: Array<Record<string, string> | undefined>
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  let hasHeaders = false;
  for (const entry of headers) {
    if (!entry) {
      continue;
    }
    Object.assign(merged, entry);
    hasHeaders = true;
  }
  return hasHeaders ? merged : undefined;
}

function applyStreamOptionsPatch(
  base: AgentHarnessStreamOptions,
  patch?: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
  const result = cloneStreamOptions(base);
  if (!patch) {
    return result;
  }

  if (Object.hasOwn(patch, "transport")) {
    result.transport = patch.transport;
  }
  if (Object.hasOwn(patch, "timeoutMs")) {
    result.timeoutMs = patch.timeoutMs;
  }
  if (Object.hasOwn(patch, "maxRetries")) {
    result.maxRetries = patch.maxRetries;
  }
  if (Object.hasOwn(patch, "maxRetryDelayMs")) {
    result.maxRetryDelayMs = patch.maxRetryDelayMs;
  }
  if (Object.hasOwn(patch, "cacheRetention")) {
    result.cacheRetention = patch.cacheRetention;
  }

  if (Object.hasOwn(patch, "headers")) {
    if (patch.headers === undefined) {
      result.headers = undefined;
    } else {
      const headers = { ...result.headers };
      for (const [key, value] of Object.entries(patch.headers)) {
        if (value === undefined) {
          delete headers[key];
        } else {
          headers[key] = value;
        }
      }
      result.headers = Object.keys(headers).length > 0 ? headers : undefined;
    }
  }

  if (Object.hasOwn(patch, "metadata")) {
    if (patch.metadata === undefined) {
      result.metadata = undefined;
    } else {
      const metadata = { ...result.metadata };
      for (const [key, value] of Object.entries(patch.metadata)) {
        if (value === undefined) {
          delete metadata[key];
        } else {
          metadata[key] = value;
        }
      }
      result.metadata = Object.keys(metadata).length > 0 ? metadata : undefined;
    }
  }

  return result;
}

const SUBSCRIBER_EVENT_TYPE = "*";

type AgentHarnessHandler = (event: unknown, signal?: AbortSignal) => unknown;

function normalizeHarnessError(
  error: unknown,
  fallbackCode: AgentHarnessError["code"],
): AgentHarnessError {
  if (error instanceof AgentHarnessError) {
    return error;
  }
  const cause = toError(error);
  if (cause instanceof SessionError) {
    return new AgentHarnessError("session", cause.message, cause);
  }
  if (cause instanceof CompactionError) {
    return new AgentHarnessError("compaction", cause.message, cause);
  }
  if (cause instanceof BranchSummaryError) {
    return new AgentHarnessError("branch_summary", cause.message, cause);
  }
  return new AgentHarnessError(fallbackCode, cause.message, cause);
}

function normalizeHookError(error: unknown): AgentHarnessError {
  return normalizeHarnessError(error, "hook");
}

interface AgentHarnessTurnState<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentTool = AgentTool,
> {
  messages: AgentMessage[];
  resources: AgentHarnessResources<TSkill, TPromptTemplate>;
  streamOptions: AgentHarnessStreamOptions;
  sessionId: string;
  systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  tools: TTool[];
  activeTools: TTool[];
}

export class AgentHarness<
  TSkill extends Skill = Skill,
  TPromptTemplate extends PromptTemplate = PromptTemplate,
  TTool extends AgentTool = AgentTool,
> {
  readonly env: ExecutionEnv;
  private session: Session;
  private phase: AgentHarnessPhase = "idle";
  private runAbortController?: AbortController;
  private runPromise?: Promise<void>;
  private pendingSessionWrites: PendingSessionWrite[] = [];
  private model: Model;
  private thinkingLevel: ThinkingLevel;
  private systemPrompt: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>["systemPrompt"];
  private streamOptions: AgentHarnessStreamOptions;
  private getApiKeyAndHeaders?: AgentHarnessOptions["getApiKeyAndHeaders"];
  private runtime?: AgentCoreRuntimeDeps;
  private resources: AgentHarnessResources<TSkill, TPromptTemplate>;
  private tools = new Map<string, TTool>();
  private activeToolNames: string[];
  private steerQueue: UserMessage[] = [];
  private steeringQueueMode: QueueMode;
  private followUpQueue: UserMessage[] = [];
  private followUpQueueMode: QueueMode;
  private nextTurnQueue: AgentMessage[] = [];
  private handlers = new Map<string, Set<AgentHarnessHandler>>();

  constructor(options: AgentHarnessOptions<TSkill, TPromptTemplate, TTool>) {
    this.env = options.env;
    this.session = options.session;
    this.resources = options.resources ?? {};
    this.streamOptions = cloneStreamOptions(options.streamOptions);
    this.systemPrompt = options.systemPrompt;
    this.getApiKeyAndHeaders = options.getApiKeyAndHeaders;
    this.runtime = options.runtime;
    for (const tool of options.tools ?? []) {
      this.tools.set(tool.name, tool);
    }
    this.model = options.model;
    this.thinkingLevel = options.thinkingLevel ?? "off";
    this.activeToolNames =
      options.activeToolNames ?? (options.tools ?? []).map((tool) => tool.name);
    this.steeringQueueMode = options.steeringMode ?? "one-at-a-time";
    this.followUpQueueMode = options.followUpMode ?? "one-at-a-time";
  }

  private getHandlers(type: string): Set<AgentHarnessHandler> | undefined {
    return this.handlers.get(type);
  }

  private async emitOwn(
    event: AgentHarnessOwnEvent<TSkill, TPromptTemplate>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
      try {
        await listener(event, signal);
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
  }

  private async emitAny(
    event: AgentHarnessEvent<TSkill, TPromptTemplate>,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const listener of this.getHandlers(SUBSCRIBER_EVENT_TYPE) ?? []) {
      try {
        await listener(event, signal);
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
  }

  private async emitHook<TType extends keyof AgentHarnessEventResultMap>(
    event: Extract<AgentHarnessOwnEvent, { type: TType }>,
  ): Promise<AgentHarnessEventResultMap[TType] | undefined> {
    const handlers = this.getHandlers(event.type);
    if (!handlers || handlers.size === 0) {
      return undefined;
    }
    let lastResult: AgentHarnessEventResultMap[TType] | undefined;
    for (const handler of handlers) {
      try {
        const result = (await handler(event)) as AgentHarnessEventResultMap[TType] | undefined;
        if (result !== undefined) {
          lastResult = result;
        }
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
    return lastResult;
  }

  private async emitBeforeProviderRequest(
    model: Model,
    sessionId: string,
    streamOptions: AgentHarnessStreamOptions,
  ): Promise<AgentHarnessStreamOptions> {
    const handlers = this.getHandlers("before_provider_request");
    let current = cloneStreamOptions(streamOptions);
    if (!handlers || handlers.size === 0) {
      return current;
    }
    for (const handler of handlers) {
      try {
        const result = (await handler({
          type: "before_provider_request",
          model,
          sessionId,
          streamOptions: cloneStreamOptions(current),
        })) as AgentHarnessEventResultMap["before_provider_request"];
        if (result?.streamOptions) {
          current = applyStreamOptionsPatch(current, result.streamOptions);
        }
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
    return current;
  }

  private async emitBeforeProviderPayload(model: Model, payload: unknown): Promise<unknown> {
    const handlers = this.getHandlers("before_provider_payload");
    let current = payload;
    if (!handlers || handlers.size === 0) {
      return current;
    }
    for (const handler of handlers) {
      try {
        const result = (await handler({
          type: "before_provider_payload",
          model,
          payload: current,
        })) as AgentHarnessEventResultMap["before_provider_payload"];
        if (result !== undefined) {
          current = result.payload;
        }
      } catch (error) {
        throw normalizeHookError(error);
      }
    }
    return current;
  }

  private async emitQueueUpdate(): Promise<void> {
    await this.emitOwn({
      type: "queue_update",
      steer: [...this.steerQueue],
      followUp: [...this.followUpQueue],
      nextTurn: [...this.nextTurnQueue],
    });
  }

  private startRunPromise(): () => void {
    let finish = () => {};
    this.runPromise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return () => {
      this.runPromise = undefined;
      finish();
    };
  }

  private async createTurnState(): Promise<AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>> {
    const context = await this.session.buildContext();
    const resources = this.getResources();
    const sessionMetadata = await this.session.getMetadata();
    const tools = [...this.tools.values()];
    const activeTools = this.activeToolNames
      .map((name) => this.tools.get(name))
      .filter((tool): tool is TTool => tool !== undefined);
    let systemPrompt = "You are a helpful assistant.";
    if (typeof this.systemPrompt === "string") {
      systemPrompt = this.systemPrompt;
    } else if (this.systemPrompt) {
      systemPrompt = await this.systemPrompt({
        env: this.env,
        session: this.session,
        model: this.model,
        thinkingLevel: this.thinkingLevel,
        activeTools,
        resources,
      });
    }
    return {
      messages: context.messages,
      resources,
      streamOptions: cloneStreamOptions(this.streamOptions),
      sessionId: sessionMetadata.id,
      systemPrompt,
      model: this.model,
      thinkingLevel: this.thinkingLevel,
      tools,
      activeTools,
    };
  }

  private createContext(
    turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
    systemPrompt?: string,
  ): AgentContext {
    return {
      systemPrompt: systemPrompt ?? turnState.systemPrompt,
      messages: turnState.messages.slice(),
      tools: turnState.activeTools.slice(),
    };
  }

  private createStreamFn(
    getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
  ): StreamFn {
    return async (model, context, streamOptions) => {
      const turnState = getTurnState();
      const auth = await this.getApiKeyAndHeaders?.(model);
      const snapshotOptions: AgentHarnessStreamOptions = {
        ...turnState.streamOptions,
        headers: mergeHeaders(turnState.streamOptions.headers, auth?.headers),
      };
      const requestOptions = await this.emitBeforeProviderRequest(
        model,
        turnState.sessionId,
        snapshotOptions,
      );
      return resolveAgentCoreStreamFn(this.runtime)(model, context, {
        cacheRetention: requestOptions.cacheRetention,
        headers: requestOptions.headers,
        maxRetries: requestOptions.maxRetries,
        maxRetryDelayMs: requestOptions.maxRetryDelayMs,
        metadata: requestOptions.metadata,
        onPayload: async (payload) => await this.emitBeforeProviderPayload(model, payload),
        onResponse: async (response) => {
          const headers = { ...response.headers };
          await this.emitOwn(
            { type: "after_provider_response", status: response.status, headers },
            streamOptions?.signal,
          );
        },
        reasoning: streamOptions?.reasoning,
        signal: streamOptions?.signal,
        sessionId: turnState.sessionId,
        timeoutMs: requestOptions.timeoutMs,
        transport: requestOptions.transport,
        apiKey: auth?.apiKey,
      });
    };
  }

  private async drainQueuedMessages(
    queue: AgentMessage[],
    mode: QueueMode,
  ): Promise<AgentMessage[]> {
    const messages = mode === "all" ? queue.splice(0) : queue.splice(0, 1);
    if (messages.length === 0) {
      return messages;
    }
    try {
      await this.emitQueueUpdate();
      return messages;
    } catch (error) {
      queue.unshift(...messages);
      throw normalizeHookError(error);
    }
  }

  private createLoopConfig(
    getTurnState: () => AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
    setTurnState: (turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => void,
  ): AgentLoopConfig {
    const turnState = getTurnState();
    return {
      model: turnState.model,
      reasoning: turnState.thinkingLevel === "off" ? undefined : turnState.thinkingLevel,
      convertToLlm,
      transformContext: async (messages) => {
        const result = await this.emitHook({ type: "context", messages: [...messages] });
        return result?.messages ?? messages;
      },
      beforeToolCall: async ({ toolCall, args }) => {
        const result = await this.emitHook({
          type: "tool_call",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: args as Record<string, unknown>,
        });
        return result ? { block: result.block, reason: result.reason } : undefined;
      },
      afterToolCall: async ({ toolCall, args, result, isError }) => {
        const patch = await this.emitHook({
          type: "tool_result",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          input: args as Record<string, unknown>,
          content: result.content,
          details: result.details,
          isError,
        });
        return patch
          ? {
              content: patch.content,
              details: patch.details,
              isError: patch.isError,
              terminate: patch.terminate,
            }
          : undefined;
      },
      prepareNextTurn: async () => {
        await this.flushPendingSessionWrites();
        const nextTurnState = await this.createTurnState();
        setTurnState(nextTurnState);
        return {
          context: this.createContext(nextTurnState),
          model: nextTurnState.model,
          thinkingLevel: nextTurnState.thinkingLevel,
        };
      },
      getSteeringMessages: async () =>
        this.drainQueuedMessages(this.steerQueue, this.steeringQueueMode),
      getFollowUpMessages: async () =>
        this.drainQueuedMessages(this.followUpQueue, this.followUpQueueMode),
    };
  }

  private validateToolNames(toolNames: string[], tools: Map<string, TTool> = this.tools): void {
    const missing = toolNames.filter((name) => !tools.has(name));
    if (missing.length > 0) {
      throw new AgentHarnessError("invalid_argument", `Unknown tool(s): ${missing.join(", ")}`);
    }
  }

  private async flushPendingSessionWrites(): Promise<void> {
    while (this.pendingSessionWrites.length > 0) {
      const write = this.pendingSessionWrites[0];
      if (write.type === "message") {
        await this.session.appendMessage(write.message);
      } else if (write.type === "model_change") {
        await this.session.appendModelChange(write.provider, write.modelId);
      } else if (write.type === "thinking_level_change") {
        await this.session.appendThinkingLevelChange(write.thinkingLevel);
      } else if (write.type === "custom") {
        await this.session.appendCustomEntry(write.customType, write.data);
      } else if (write.type === "custom_message") {
        await this.session.appendCustomMessageEntry(
          write.customType,
          write.content,
          write.display,
          write.details,
        );
      } else if (write.type === "label") {
        await this.session.appendLabel(write.targetId, write.label);
      } else if (write.type === "session_info") {
        await this.session.appendSessionName(write.name ?? "");
      } else if (write.type === "leaf") {
        await this.session.getStorage().setLeafId(write.targetId);
      }
      this.pendingSessionWrites.shift();
    }
  }

  private async handleAgentEvent(event: AgentEvent, signal?: AbortSignal): Promise<void> {
    if (event.type === "message_end") {
      await this.session.appendMessage(event.message);
      await this.emitAny(event, signal);
      return;
    }
    if (event.type === "turn_end") {
      let eventError: unknown;
      try {
        await this.emitAny(event, signal);
      } catch (error) {
        eventError = error;
      }
      const hadPendingMutations = this.pendingSessionWrites.length > 0;
      await this.flushPendingSessionWrites();
      if (eventError) {
        throw eventError;
      }
      await this.emitOwn({ type: "save_point", hadPendingMutations });
      return;
    }
    if (event.type === "agent_end") {
      await this.flushPendingSessionWrites();
      this.phase = "idle";
      await this.emitAny(event, signal);
      await this.emitOwn({ type: "settled", nextTurnCount: this.nextTurnQueue.length }, signal);
      return;
    }
    await this.emitAny(event, signal);
  }

  private async emitRunFailure(
    model: Model,
    error: unknown,
    aborted: boolean,
    signal: AbortSignal,
  ): Promise<AgentMessage[]> {
    const failureMessage = createFailureMessage(model, error, aborted);
    await this.handleAgentEvent({ type: "message_start", message: failureMessage }, signal);
    await this.handleAgentEvent({ type: "message_end", message: failureMessage }, signal);
    await this.handleAgentEvent(
      { type: "turn_end", message: failureMessage, toolResults: [] },
      signal,
    );
    await this.handleAgentEvent({ type: "agent_end", messages: [failureMessage] }, signal);
    return [failureMessage];
  }

  private async executeTurn(
    turnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>,
    text: string,
    options?: { images?: ImageContent[] },
  ): Promise<AssistantMessage> {
    let activeTurnState = turnState;
    let messages: AgentMessage[] = [createUserMessage(text, options?.images)];
    if (this.nextTurnQueue.length > 0) {
      const queuedMessages = this.nextTurnQueue.splice(0);
      try {
        await this.emitQueueUpdate();
      } catch (error) {
        this.nextTurnQueue.unshift(...queuedMessages);
        throw normalizeHookError(error);
      }
      messages = [...queuedMessages, messages[0]];
    }
    const beforeResult = await this.emitHook({
      type: "before_agent_start",
      prompt: text,
      images: options?.images,
      systemPrompt: turnState.systemPrompt,
      resources: turnState.resources,
    });
    if (beforeResult?.messages) {
      messages = [...messages, ...beforeResult.messages];
    }

    const abortController = new AbortController();
    const getTurnState = () => activeTurnState;
    const setTurnState = (nextTurnState: AgentHarnessTurnState<TSkill, TPromptTemplate, TTool>) => {
      activeTurnState = nextTurnState;
    };
    this.runAbortController = abortController;
    const runResultPromise = (async () => {
      try {
        return await runAgentLoop(
          messages,
          this.createContext(turnState, beforeResult?.systemPrompt),
          this.createLoopConfig(getTurnState, setTurnState),
          (event) => this.handleAgentEvent(event, abortController.signal),
          abortController.signal,
          this.createStreamFn(getTurnState),
        );
      } catch (error) {
        try {
          return await this.emitRunFailure(
            activeTurnState.model,
            error,
            abortController.signal.aborted,
            abortController.signal,
          );
        } catch (failureError) {
          const cause = new AggregateError(
            [toError(error), toError(failureError)],
            "Agent run failed and failure reporting failed",
          );
          throw new AgentHarnessError("unknown", cause.message, cause);
        }
      }
    })();
    try {
      const newMessages = await runResultPromise;
      for (let i = newMessages.length - 1; i >= 0; i--) {
        const message = newMessages[i];
        if (message.role === "assistant") {
          return message;
        }
      }
      throw new AgentHarnessError(
        "invalid_state",
        "AgentHarness prompt completed without an assistant message",
      );
    } finally {
      try {
        await this.flushPendingSessionWrites();
      } finally {
        this.runAbortController = undefined;
      }
    }
  }

  async prompt(text: string, options?: { images?: ImageContent[] }): Promise<AssistantMessage> {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "AgentHarness is busy");
    }
    this.phase = "turn";
    const finishRunPromise = this.startRunPromise();
    try {
      const turnState = await this.createTurnState();
      return await this.executeTurn(turnState, text, options);
    } catch (error) {
      this.phase = "idle";
      throw normalizeHarnessError(error, "unknown");
    } finally {
      finishRunPromise();
    }
  }

  async skill(name: string, additionalInstructions?: string): Promise<AssistantMessage> {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "AgentHarness is busy");
    }
    this.phase = "turn";
    const finishRunPromise = this.startRunPromise();
    try {
      const turnState = await this.createTurnState();
      const skill = (turnState.resources.skills ?? []).find((candidate) => candidate.name === name);
      if (!skill) {
        throw new AgentHarnessError("invalid_argument", `Unknown skill: ${name}`);
      }
      return await this.executeTurn(
        turnState,
        formatSkillInvocation(skill, additionalInstructions),
      );
    } catch (error) {
      this.phase = "idle";
      throw normalizeHarnessError(error, "unknown");
    } finally {
      finishRunPromise();
    }
  }

  async promptFromTemplate(name: string, args: string[] = []): Promise<AssistantMessage> {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "AgentHarness is busy");
    }
    this.phase = "turn";
    const finishRunPromise = this.startRunPromise();
    try {
      const turnState = await this.createTurnState();
      const template = (turnState.resources.promptTemplates ?? []).find(
        (candidate) => candidate.name === name,
      );
      if (!template) {
        throw new AgentHarnessError("invalid_argument", `Unknown prompt template: ${name}`);
      }
      return await this.executeTurn(turnState, formatPromptTemplateInvocation(template, args));
    } catch (error) {
      this.phase = "idle";
      throw normalizeHarnessError(error, "unknown");
    } finally {
      finishRunPromise();
    }
  }

  async steer(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.phase === "idle") {
      throw new AgentHarnessError("invalid_state", "Cannot steer while idle");
    }
    this.steerQueue.push(createUserMessage(text, options?.images));
    await this.emitQueueUpdate();
  }

  async followUp(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    if (this.phase === "idle") {
      throw new AgentHarnessError("invalid_state", "Cannot follow up while idle");
    }
    this.followUpQueue.push(createUserMessage(text, options?.images));
    await this.emitQueueUpdate();
  }

  async nextTurn(text: string, options?: { images?: ImageContent[] }): Promise<void> {
    this.nextTurnQueue.push(createUserMessage(text, options?.images));
    await this.emitQueueUpdate();
  }

  async appendMessage(message: AgentMessage): Promise<void> {
    try {
      if (this.phase === "idle") {
        await this.session.appendMessage(message);
      } else {
        this.pendingSessionWrites.push({ type: "message", message });
      }
    } catch (error) {
      throw normalizeHarnessError(error, "session");
    }
  }

  async compact(customInstructions?: string): Promise<{
    summary: string;
    firstKeptEntryId: string;
    tokensBefore: number;
    details?: unknown;
  }> {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "compact() requires idle harness");
    }
    this.phase = "compaction";
    try {
      const model = this.model;
      if (!model) {
        throw new AgentHarnessError("invalid_state", "No model set for compaction");
      }
      const auth = await this.getApiKeyAndHeaders?.(model);
      if (!auth) {
        throw new AgentHarnessError("auth", "No auth available for compaction");
      }
      const branchEntries = await this.session.getBranch();
      const preparationResult = prepareCompaction(branchEntries, DEFAULT_COMPACTION_SETTINGS);
      if (!preparationResult.ok) {
        throw preparationResult.error;
      }
      const preparation = preparationResult.value;
      if (!preparation) {
        throw new AgentHarnessError("compaction", "Nothing to compact");
      }
      const hookResult = await this.emitHook({
        type: "session_before_compact",
        preparation,
        branchEntries,
        customInstructions,
        signal: new AbortController().signal,
      });
      if (hookResult?.cancel) {
        throw new AgentHarnessError("compaction", "Compaction cancelled");
      }
      const provided = hookResult?.compaction;
      const compactResult = provided
        ? { ok: true as const, value: provided }
        : await compact(
            preparation,
            model,
            auth.apiKey,
            auth.headers,
            customInstructions,
            undefined,
            this.thinkingLevel,
            undefined,
            this.runtime,
          );
      if (!compactResult.ok) {
        throw compactResult.error;
      }
      const result = compactResult.value;
      const entryId = await this.session.appendCompaction(
        result.summary,
        result.firstKeptEntryId,
        result.tokensBefore,
        result.details,
        provided !== undefined,
      );
      const entry = await this.session.getEntry(entryId);
      if (entry?.type === "compaction") {
        await this.emitOwn({
          type: "session_compact",
          compactionEntry: entry,
          fromHook: provided !== undefined,
        });
      }
      return result;
    } catch (error) {
      throw normalizeHarnessError(error, "compaction");
    } finally {
      this.phase = "idle";
    }
  }

  async navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<NavigateTreeResult> {
    if (this.phase !== "idle") {
      throw new AgentHarnessError("busy", "navigateTree() requires idle harness");
    }
    this.phase = "branch_summary";
    try {
      const oldLeafId = await this.session.getLeafId();
      if (oldLeafId === targetId) {
        return { cancelled: false };
      }
      const targetEntry = await this.session.getEntry(targetId);
      if (!targetEntry) {
        throw new AgentHarnessError("invalid_argument", `Entry ${targetId} not found`);
      }
      const { entries, commonAncestorId } = await collectEntriesForBranchSummary(
        this.session,
        oldLeafId,
        targetId,
      );
      const preparation = {
        targetId,
        oldLeafId,
        commonAncestorId,
        entriesToSummarize: entries,
        userWantsSummary: options?.summarize ?? false,
        customInstructions: options?.customInstructions,
        replaceInstructions: options?.replaceInstructions,
        label: options?.label,
      };
      const signal = new AbortController().signal;
      const hookResult = await this.emitHook({ type: "session_before_tree", preparation, signal });
      if (hookResult?.cancel) {
        return { cancelled: true };
      }
      let summaryEntry: NavigateTreeResult["summaryEntry"];
      let summaryText: string | undefined = hookResult?.summary?.summary;
      let summaryDetails: unknown = hookResult?.summary?.details;
      if (!summaryText && options?.summarize && entries.length > 0) {
        const model = this.model;
        if (!model) {
          throw new AgentHarnessError("invalid_state", "No model set for branch summary");
        }
        const auth = await this.getApiKeyAndHeaders?.(model);
        if (!auth) {
          throw new AgentHarnessError("auth", "No auth available for branch summary");
        }
        const branchSummary = await generateBranchSummary(entries, {
          model,
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: new AbortController().signal,
          runtime: this.runtime,
          customInstructions: hookResult?.customInstructions ?? options?.customInstructions,
          replaceInstructions: hookResult?.replaceInstructions ?? options?.replaceInstructions,
        });
        if (!branchSummary.ok) {
          if (branchSummary.error.code === "aborted") {
            return { cancelled: true };
          }
          throw new AgentHarnessError(
            "branch_summary",
            branchSummary.error.message,
            branchSummary.error,
          );
        }
        summaryText = branchSummary.value.summary;
        summaryDetails = {
          readFiles: branchSummary.value.readFiles,
          modifiedFiles: branchSummary.value.modifiedFiles,
        };
      }
      let editorText: string | undefined;
      let newLeafId: string | null;
      if (targetEntry.type === "message" && targetEntry.message.role === "user") {
        newLeafId = targetEntry.parentId;
        const content = targetEntry.message.content;
        editorText =
          typeof content === "string"
            ? content
            : content
                .filter(
                  (c): c is { readonly type: "text"; readonly text: string } => c.type === "text",
                )
                .map((c) => c.text)
                .join("");
      } else if (targetEntry.type === "custom_message") {
        newLeafId = targetEntry.parentId;
        editorText =
          typeof targetEntry.content === "string"
            ? targetEntry.content
            : targetEntry.content
                .filter(
                  (c): c is { readonly type: "text"; readonly text: string } => c.type === "text",
                )
                .map((c) => c.text)
                .join("");
      } else {
        newLeafId = targetId;
      }
      const summaryId = await this.session.moveTo(
        newLeafId,
        summaryText
          ? {
              summary: summaryText,
              details: summaryDetails,
              fromHook: hookResult?.summary !== undefined,
            }
          : undefined,
      );
      if (summaryId) {
        const entry = await this.session.getEntry(summaryId);
        if (entry?.type === "branch_summary") {
          summaryEntry = entry;
        }
      }
      await this.emitOwn({
        type: "session_tree",
        newLeafId: await this.session.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromHook: hookResult?.summary !== undefined,
      });
      return { cancelled: false, editorText, summaryEntry };
    } catch (error) {
      throw normalizeHarnessError(error, "branch_summary");
    } finally {
      this.phase = "idle";
    }
  }

  getModel(): Model {
    return this.model;
  }

  getThinkingLevel(): ThinkingLevel {
    return this.thinkingLevel;
  }

  async setModel(model: Model): Promise<void> {
    try {
      const previousModel = this.model;
      if (this.phase === "idle") {
        await this.session.appendModelChange(model.provider, model.id);
      } else {
        this.pendingSessionWrites.push({
          type: "model_change",
          provider: model.provider,
          modelId: model.id,
        });
      }
      this.model = model;
      await this.emitOwn({ type: "model_select", model, previousModel, source: "set" });
    } catch (error) {
      throw normalizeHarnessError(error, "session");
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    try {
      const previousLevel = this.thinkingLevel;
      if (this.phase === "idle") {
        await this.session.appendThinkingLevelChange(level);
      } else {
        this.pendingSessionWrites.push({ type: "thinking_level_change", thinkingLevel: level });
      }
      this.thinkingLevel = level;
      await this.emitOwn({ type: "thinking_level_select", level, previousLevel });
    } catch (error) {
      throw normalizeHarnessError(error, "session");
    }
  }

  async setActiveTools(toolNames: string[]): Promise<void> {
    try {
      this.validateToolNames(toolNames);
      this.activeToolNames = [...toolNames];
    } catch (error) {
      throw normalizeHarnessError(error, "invalid_argument");
    }
  }

  getSteeringMode(): QueueMode {
    return this.steeringQueueMode;
  }

  async setSteeringMode(mode: QueueMode): Promise<void> {
    this.steeringQueueMode = mode;
  }

  getFollowUpMode(): QueueMode {
    return this.followUpQueueMode;
  }

  async setFollowUpMode(mode: QueueMode): Promise<void> {
    this.followUpQueueMode = mode;
  }

  getResources(): AgentHarnessResources<TSkill, TPromptTemplate> {
    return {
      skills: this.resources.skills?.slice(),
      promptTemplates: this.resources.promptTemplates?.slice(),
    };
  }

  async setResources(resources: AgentHarnessResources<TSkill, TPromptTemplate>): Promise<void> {
    const previousResources = this.getResources();
    this.resources = {
      skills: resources.skills?.slice(),
      promptTemplates: resources.promptTemplates?.slice(),
    };
    await this.emitOwn({
      type: "resources_update",
      resources: this.getResources(),
      previousResources,
    });
  }

  getStreamOptions(): AgentHarnessStreamOptions {
    return cloneStreamOptions(this.streamOptions);
  }

  async setStreamOptions(streamOptions: AgentHarnessStreamOptions): Promise<void> {
    this.streamOptions = cloneStreamOptions(streamOptions);
  }

  async setTools(tools: TTool[], activeToolNames?: string[]): Promise<void> {
    try {
      const nextTools = new Map(tools.map((tool) => [tool.name, tool]));
      const nextActiveToolNames = activeToolNames ? [...activeToolNames] : this.activeToolNames;
      this.validateToolNames(nextActiveToolNames, nextTools);
      this.tools = nextTools;
      this.activeToolNames = [...nextActiveToolNames];
    } catch (error) {
      throw normalizeHarnessError(error, "invalid_argument");
    }
  }

  async abort(): Promise<AbortResult> {
    const clearedSteer = [...this.steerQueue];
    const clearedFollowUp = [...this.followUpQueue];
    this.steerQueue = [];
    this.followUpQueue = [];
    this.runAbortController?.abort();
    const errors: Error[] = [];
    try {
      await this.emitQueueUpdate();
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await this.waitForIdle();
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await this.emitOwn({ type: "abort", clearedSteer, clearedFollowUp });
    } catch (error) {
      errors.push(toError(error));
    }
    if (errors.length > 0) {
      const cause =
        errors.length === 1 ? errors[0] : new AggregateError(errors, "Abort completed with errors");
      throw normalizeHarnessError(cause, "hook");
    }
    return { clearedSteer, clearedFollowUp };
  }

  async waitForIdle(): Promise<void> {
    await this.runPromise;
  }

  subscribe(
    listener: (
      event: AgentHarnessEvent<TSkill, TPromptTemplate>,
      signal?: AbortSignal,
    ) => Promise<void> | void,
  ): () => void {
    let handlers = this.handlers.get(SUBSCRIBER_EVENT_TYPE);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(SUBSCRIBER_EVENT_TYPE, handlers);
    }
    handlers.add(listener as AgentHarnessHandler);
    return () => handlers.delete(listener as AgentHarnessHandler);
  }

  on<TType extends keyof AgentHarnessEventResultMap>(
    type: TType,
    handler: (
      event: Extract<AgentHarnessOwnEvent, { type: TType }>,
    ) => Promise<AgentHarnessEventResultMap[TType]> | AgentHarnessEventResultMap[TType],
  ): () => void {
    let handlers = this.handlers.get(type);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(type, handlers);
    }
    handlers.add(handler as AgentHarnessHandler);
    return () => handlers.delete(handler as AgentHarnessHandler);
  }
}
