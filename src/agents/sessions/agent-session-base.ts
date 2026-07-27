import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import type { AssistantMessage, Model } from "../../llm/types.js";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  ThinkingLevel,
} from "../runtime/index.js";
import type {
  AgentSessionConfig,
  AgentSessionEvent,
  AgentSessionEventListener,
  AgentSessionWriteLockRunner,
} from "./agent-session-types.js";
import { extractTextContent } from "./agent-session-utils.js";
import { formatNoApiKeyFoundMessage } from "./auth-guidance.js";
import {
  type ExtensionCommandContextActions,
  type ExtensionErrorListener,
  ExtensionRunner,
  type ExtensionUIContext,
  type MessageEndEvent,
  type MessageStartEvent,
  type MessageUpdateEvent,
  type SessionStartEvent,
  type ShutdownHandler,
  type ToolDefinition,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
  type ToolInfo,
  type TurnEndEvent,
  type TurnStartEvent,
} from "./extensions/index.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { getModelRegistryRuntime } from "./model-registry-runtime.js";
import type { ModelRegistry } from "./model-registry.js";
import type { PromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { SourceInfo } from "./source-info.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.js";

interface ToolDefinitionEntry {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

type ActiveToolPromptMetadata = {
  validToolNames: string[];
  toolSnippets: Record<string, string>;
  promptGuidelines: string[];
};

export abstract class AgentSessionBase {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  protected scopedModelEntries: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

  // Event subscription state
  protected unsubscribeAgent?: () => void;
  private eventListeners: AgentSessionEventListener[] = [];

  /** Tracks pending steering messages for UI display. Removed when delivered. */
  protected steeringMessages: string[] = [];
  /** Tracks pending follow-up messages for UI display. Removed when delivered. */
  protected followUpMessages: string[] = [];
  /** Messages queued to be included with the next user prompt as context ("asides"). */
  protected pendingNextTurnMessages: CustomMessage[] = [];

  // Compaction state
  protected compactionAbortController: AbortController | undefined = undefined;
  protected autoCompactionAbortController: AbortController | undefined = undefined;
  protected overflowRecoveryAttempted = false;
  protected contextOverflowRecoveryOwner: "session" | "caller";

  // Branch summarization state
  protected branchSummaryAbortController: AbortController | undefined = undefined;
  private extensionModifiedToolResultIds = new Set<string>();

  // Retry state
  protected retryAbortController: AbortController | undefined = undefined;
  protected retryCount = 0;

  // Bash execution state
  protected bashAbortController: AbortController | undefined = undefined;
  protected pendingBashMessages: BashExecutionMessage[] = [];

  // Extension system
  protected currentExtensionRunner!: ExtensionRunner;
  private turnIndex = 0;

  protected sessionResourceLoader: ResourceLoader;
  protected customTools: ToolDefinition[];
  protected baseToolDefinitions: Map<string, ToolDefinition> = new Map();
  protected cwd: string;
  protected extensionRunnerRef?: { current?: ExtensionRunner };
  protected initialActiveToolNames?: string[];
  protected allowedToolNames?: Set<string>;
  protected disableBuiltInTools: boolean;
  protected baseToolsOverride?: Record<string, AgentTool>;
  protected sessionStartEvent: SessionStartEvent;
  protected withExternalSessionWriteLock?: AgentSessionWriteLockRunner;
  protected extensionUIContext?: ExtensionUIContext;
  protected extensionCommandContextActions?: ExtensionCommandContextActions;
  protected extensionAbortHandler?: () => void;
  protected extensionShutdownHandler?: ShutdownHandler;
  protected extensionErrorListener?: ExtensionErrorListener;
  protected extensionErrorUnsubscriber?: () => void;

  // Model registry for API key resolution
  protected sessionModelRegistry: ModelRegistry;

  // Tool registry for extension getTools/setTools
  protected toolRegistry: Map<string, AgentTool> = new Map();
  protected toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
  protected toolPromptSnippets: Map<string, string> = new Map();
  protected toolPromptGuidelines: Map<string, string[]> = new Map();

  // Base system prompt (without extension appends) - used to apply fresh appends each turn
  protected baseSystemPrompt = "";
  protected baseSystemPromptOptions!: BuildSystemPromptOptions;
  protected exactBaseSystemPrompt: string | undefined;
  protected systemPromptOverride: string | undefined;

  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this.settingsManager = config.settingsManager;
    this.scopedModelEntries = config.scopedModels ?? [];
    this.sessionResourceLoader = config.resourceLoader;
    this.customTools = config.customTools ?? [];
    this.cwd = config.cwd;
    this.sessionModelRegistry = config.modelRegistry;
    this.extensionRunnerRef = config.extensionRunnerRef;
    this.initialActiveToolNames = config.initialActiveToolNames;
    this.allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
    this.disableBuiltInTools = config.disableBuiltInTools === true;
    this.baseToolsOverride = config.baseToolsOverride;
    this.sessionStartEvent = config.sessionStartEvent ?? {
      type: "session_start",
      reason: "startup",
    };
    this.withExternalSessionWriteLock = config.withSessionWriteLock;
    this.contextOverflowRecoveryOwner = config.contextOverflowRecoveryOwner ?? "session";
  }

  /** Model registry for API key resolution and model discovery */
  get modelRegistry(): ModelRegistry {
    return this.sessionModelRegistry;
  }

  protected async getRequiredRequestAuth(model: Model): Promise<{
    apiKey: string;
    headers?: Record<string, string>;
  }> {
    const result = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    if (!result.ok) {
      if (result.error.startsWith("No API key found")) {
        throw new Error(formatNoApiKeyFoundMessage(model.provider));
      }
      throw new Error(result.error);
    }
    if (result.apiKey) {
      return { apiKey: result.apiKey, headers: result.headers };
    }

    const isOAuth = this.sessionModelRegistry.isUsingOAuth(model);
    if (isOAuth) {
      throw new Error(
        `Authentication failed for "${model.provider}". ` +
          `Credentials may have expired or network is unavailable. ` +
          `Run '/login ${model.provider}' to re-authenticate.`,
      );
    }
    throw new Error(formatNoApiKeyFoundMessage(model.provider));
  }

  protected async getCompactionRequestAuth(model: Model): Promise<{
    apiKey?: string;
    headers?: Record<string, string>;
  }> {
    if (
      this.agent.streamFn ===
      getModelRegistryRuntime(this.sessionModelRegistry).llmRuntime.streamSimple
    ) {
      return this.getRequiredRequestAuth(model);
    }

    const result = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
  }

  protected async runWithSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T> {
    return this.withExternalSessionWriteLock
      ? await this.withExternalSessionWriteLock(run)
      : await run();
  }

  private eventMayWriteSession(event: AgentEvent): boolean {
    return event.type === "message_end" || this.currentExtensionRunner.hasHandlers(event.type);
  }

  /**
   * Install tool hooks once on the Agent instance.
   *
   * The callbacks read `this.currentExtensionRunner` at execution time, so extension reload swaps in the
   * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
   * registered tool execution to the extension context. Tool call and tool result interception now
   * happens here instead of in wrappers.
   */
  protected installAgentToolHooks(): void {
    this.agent.beforeToolCall = async ({ toolCall, args }) => {
      const runner = this.currentExtensionRunner;
      return await this.runWithSessionWriteLock(async () => {
        if (!runner.hasHandlers("tool_call")) {
          return undefined;
        }

        try {
          return await runner.emitToolCall({
            type: "tool_call",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: args as Record<string, unknown>,
          });
        } catch (err) {
          if (err instanceof Error) {
            throw err;
          }
          throw new Error(`Extension failed, blocking execution: ${String(err)}`, { cause: err });
        }
      });
    };

    this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
      const runner = this.currentExtensionRunner;
      if (!runner.hasHandlers("tool_result")) {
        return undefined;
      }

      const hookResult = await this.runWithSessionWriteLock(
        async () =>
          await runner.emitToolResult({
            type: "tool_result",
            toolName: toolCall.name,
            toolCallId: toolCall.id,
            input: args as Record<string, unknown>,
            content: result.content,
            details: result.details,
            isError,
          }),
      );

      if (!hookResult) {
        return undefined;
      }
      this.extensionModifiedToolResultIds.add(toolCall.id);

      return {
        content: hookResult.content,
        details: hookResult.details,
        isError: hookResult.isError ?? isError,
      };
    };
  }

  // =========================================================================
  // Event Subscription
  // =========================================================================

  /** Emit an event to all listeners */
  protected emit(event: AgentSessionEvent): void {
    for (const l of this.eventListeners) {
      l(event);
    }
  }

  protected emitQueueUpdate(): void {
    this.emit({
      type: "queue_update",
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    });
  }

  // Track last assistant message for auto-compaction check
  protected lastAssistantMessage: AssistantMessage | undefined = undefined;
  protected lastRunEndedForTurnHandoff = false;

  /** Internal handler for agent events - shared by subscribe and reconnect */
  protected handleAgentEvent = async (event: AgentEvent, signal?: AbortSignal): Promise<void> => {
    if (event.type === "agent_end") {
      const reason: unknown = signal?.reason;
      this.lastRunEndedForTurnHandoff =
        signal?.aborted === true &&
        typeof reason === "object" &&
        reason !== null &&
        (reason as { turnHandoff?: unknown }).turnHandoff === true;
    }
    if (this.eventMayWriteSession(event)) {
      await this.runWithSessionWriteLock(async () => await this.handleAgentEventUnlocked(event));
      return;
    }
    await this.handleAgentEventUnlocked(event);
  };

  private async handleAgentEventUnlocked(event: AgentEvent): Promise<void> {
    // When a user message starts, check if it's from either queue and remove it BEFORE emitting
    // This ensures the UI sees the updated queue state
    if (event.type === "message_start" && event.message.role === "user") {
      this.overflowRecoveryAttempted = false;
      const messageText = extractTextContent(event.message.content);
      if (messageText) {
        // Check steering queue first
        const steeringIndex = this.steeringMessages.indexOf(messageText);
        if (steeringIndex !== -1) {
          this.steeringMessages.splice(steeringIndex, 1);
          this.emitQueueUpdate();
        } else {
          // Check follow-up queue
          const followUpIndex = this.followUpMessages.indexOf(messageText);
          if (followUpIndex !== -1) {
            this.followUpMessages.splice(followUpIndex, 1);
            this.emitQueueUpdate();
          }
        }
      }
    }

    // Emit to extensions first
    const messageChangedByExtension = await this.emitExtensionEvent(event);

    // Notify all listeners
    this.emit(
      event.type === "agent_end"
        ? { ...event, willRetry: this.willRetryAfterAgentEnd(event) }
        : event,
    );

    // Handle session persistence
    if (event.type === "message_end") {
      // Check if this is a custom message from extensions
      if (event.message.role === "custom") {
        // Persist as CustomMessageEntry
        this.sessionManager.appendCustomMessageEntry(
          event.message.customType,
          event.message.content,
          event.message.display,
          event.message.details,
        );
      } else if (
        event.message.role === "user" ||
        event.message.role === "assistant" ||
        event.message.role === "toolResult"
      ) {
        // Regular LLM message - persist as SessionMessageEntry
        const toolResultChangedByExtension =
          event.message.role === "toolResult" &&
          this.extensionModifiedToolResultIds.delete(event.message.toolCallId);
        this.sessionManager.appendMessage(event.message, {
          invalidateSerializedPrefixCache:
            messageChangedByExtension || toolResultChangedByExtension,
        });
      }
      // Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

      // Track assistant message for auto-compaction (checked on agent_end)
      if (event.message.role === "assistant") {
        this.lastAssistantMessage = event.message;

        const assistantMsg = event.message;
        // A length response may still need overflow recovery in checkCompaction();
        // retryCount is independent and resets for every non-error response below.
        if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
          this.overflowRecoveryAttempted = false;
        }

        // Reset retry counter immediately on successful assistant response
        // This prevents accumulation across multiple LLM calls within a turn
        if (assistantMsg.stopReason !== "error" && this.retryCount > 0) {
          this.emit({
            type: "auto_retry_end",
            success: true,
            attempt: this.retryCount,
          });
          this.retryCount = 0;
        }
      }
    }
  }

  private willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled || this.retryCount >= settings.maxRetries) {
      return false;
    }

    for (const message of event.messages.toReversed()) {
      if (message.role === "assistant") {
        return this.isRetryableError(message);
      }
    }
    return false;
  }

  /** Find the last assistant message in agent state (including aborted ones) */
  protected findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (const msg of messages.toReversed()) {
      if (msg.role === "assistant") {
        return msg;
      }
    }
    return undefined;
  }

  private replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
    // Agent-core stores the finalized message object in its state before emitting message_end.
    // SessionManager persistence happens later in handleAgentEvent() with event.message.
    // Mutating this object in place keeps agent state, later turn/agent events, listeners,
    // and the eventual SessionManager.appendMessage(event.message) persistence in sync.
    if (target === replacement) {
      return;
    }

    const targetRecord = target as unknown as Record<string, unknown>;
    for (const key of Object.keys(targetRecord)) {
      delete targetRecord[key];
    }
    Object.assign(targetRecord, replacement);
  }

  /** Emit extension events based on agent events */
  private async emitExtensionEvent(event: AgentEvent): Promise<boolean> {
    if (event.type === "agent_start") {
      this.turnIndex = 0;
      await this.currentExtensionRunner.emit({ type: "agent_start" });
    } else if (event.type === "agent_end") {
      await this.currentExtensionRunner.emit({ type: "agent_end", messages: event.messages });
    } else if (event.type === "turn_start") {
      const extensionEvent: TurnStartEvent = {
        type: "turn_start",
        turnIndex: this.turnIndex,
        timestamp: Date.now(),
      };
      await this.currentExtensionRunner.emit(extensionEvent);
    } else if (event.type === "turn_end") {
      const extensionEvent: TurnEndEvent = {
        type: "turn_end",
        turnIndex: this.turnIndex,
        message: event.message,
        toolResults: event.toolResults,
      };
      await this.currentExtensionRunner.emit(extensionEvent);
      this.turnIndex++;
    } else if (event.type === "message_start") {
      const extensionEvent: MessageStartEvent = {
        type: "message_start",
        message: event.message,
      };
      await this.currentExtensionRunner.emit(extensionEvent);
    } else if (event.type === "message_update") {
      const extensionEvent: MessageUpdateEvent = {
        type: "message_update",
        message: event.message,
        assistantMessageEvent: event.assistantMessageEvent,
      };
      await this.currentExtensionRunner.emit(extensionEvent);
    } else if (event.type === "message_end") {
      const extensionEvent: MessageEndEvent = {
        type: "message_end",
        message: event.message,
      };
      const replacement = await this.currentExtensionRunner.emitMessageEnd(extensionEvent);
      if (replacement) {
        this.replaceMessageInPlace(event.message, replacement);
        return true;
      }
    } else if (event.type === "tool_execution_start") {
      const extensionEvent: ToolExecutionStartEvent = {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
      await this.currentExtensionRunner.emit(extensionEvent);
    } else if (event.type === "tool_execution_update") {
      const extensionEvent: ToolExecutionUpdateEvent = {
        type: "tool_execution_update",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        partialResult: event.partialResult,
      };
      await this.currentExtensionRunner.emit(extensionEvent);
    } else if (event.type === "tool_execution_end") {
      const extensionEvent: ToolExecutionEndEvent = {
        type: "tool_execution_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        result: event.result,
        isError: event.isError,
      };
      await this.currentExtensionRunner.emit(extensionEvent);
    }
    return false;
  }

  /**
   * Subscribe to agent events.
   * Session persistence is handled internally (saves messages on message_end).
   * Multiple listeners can be added. Returns unsubscribe function for this listener.
   */
  subscribe(listener: AgentSessionEventListener): () => void {
    this.eventListeners.push(listener);

    // Return unsubscribe function for this specific listener
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index !== -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  /**
   * Temporarily disconnect from agent events.
   * User listeners are preserved and will receive events again after resubscribe().
   * Used internally during operations that need to pause event processing.
   */
  protected disconnectFromAgent(): void {
    if (this.unsubscribeAgent) {
      this.unsubscribeAgent();
      this.unsubscribeAgent = undefined;
    }
  }

  /**
   * Reconnect to agent events after disconnectFromAgent().
   * Preserves all existing listeners.
   */
  protected reconnectToAgent(): void {
    if (this.unsubscribeAgent) {
      return;
    } // Already connected
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
  }

  /**
   * Remove all listeners and disconnect from agent.
   * Call this when completely done with the session.
   */
  dispose(): void {
    const abortOperations = [
      () => this.abortRetry(),
      () => this.abortCompaction(),
      () => this.abortBranchSummary(),
      () => this.abortBash(),
      () => this.agent.abort(),
    ];
    for (const abortOperation of abortOperations) {
      try {
        abortOperation();
      } catch {
        // One broken abort hook must not prevent the remaining work from being cancelled.
      }
    }

    this.currentExtensionRunner.invalidate(
      "This extension ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
    );
    this.disconnectFromAgent();
    this.eventListeners = [];
    cleanupSessionResources(this.sessionId);
  }

  // =========================================================================
  // Read-only State Access
  // =========================================================================

  /** Full agent state */
  get state(): AgentState {
    return this.agent.state;
  }

  /** Current model (may be undefined if not yet selected) */
  get model(): Model | undefined {
    return this.agent.state.model;
  }

  /** Current thinking level */
  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }

  /** Whether agent is currently streaming a response */
  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /** Current effective system prompt (includes any per-turn extension modifications) */
  get systemPrompt(): string {
    return this.agent.state.systemPrompt;
  }

  /** Current retry attempt (0 if not retrying) */
  get retryAttempt(): number {
    return this.retryCount;
  }

  /**
   * Get the names of currently active tools.
   * Returns the names of tools currently set on the agent.
   */
  getActiveToolNames(): string[] {
    return this.agent.state.tools.map((t) => t.name);
  }

  /**
   * Get all configured tools with name, description, parameter schema, and source metadata.
   */
  getAllTools(): ToolInfo[] {
    return Array.from(this.toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      sourceInfo,
    }));
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    return this.toolDefinitions.get(name)?.definition;
  }

  /**
   * Set active tools by name.
   * Only tools in the registry can be enabled. Unknown tool names are ignored.
   * Also rebuilds the system prompt to reflect the new tool set.
   * Changes take effect on the next agent turn.
   */
  setActiveToolsByName(toolNames: string[]): void {
    const tools: AgentTool[] = [];
    const validToolNames: string[] = [];
    for (const name of toolNames) {
      const tool = this.toolRegistry.get(name);
      if (tool) {
        tools.push(tool);
        validToolNames.push(name);
      }
    }
    this.agent.state.tools = tools;

    // Rebuild base system prompt with new tool set
    this.baseSystemPrompt = this.rebuildSystemPrompt(validToolNames);
    this.agent.state.systemPrompt = this.systemPromptOverride ?? this.baseSystemPrompt;
  }

  /** Set an exact base prompt owned by the current runtime. */
  setBaseSystemPrompt(systemPrompt: string): void {
    const { validToolNames, toolSnippets, promptGuidelines } = this.collectActiveToolPromptMetadata(
      this.getActiveToolNames(),
    );
    this.exactBaseSystemPrompt = systemPrompt;
    this.baseSystemPrompt = systemPrompt;
    this.baseSystemPromptOptions = {
      cwd: this.cwd,
      selectedTools: validToolNames,
      toolSnippets,
      promptGuidelines,
      customPrompt: systemPrompt,
    };
    this.agent.state.systemPrompt = systemPrompt;
  }

  /** Whether compaction or branch summarization is currently running */
  get isCompacting(): boolean {
    return (
      this.autoCompactionAbortController !== undefined ||
      this.compactionAbortController !== undefined ||
      this.branchSummaryAbortController !== undefined
    );
  }

  /** All messages including custom types like BashExecutionMessage */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** Current steering mode */
  get steeringMode(): "all" | "one-at-a-time" {
    return this.agent.steeringMode;
  }

  /** Current follow-up mode */
  get followUpMode(): "all" | "one-at-a-time" {
    return this.agent.followUpMode;
  }

  /** Current session file path, or undefined if sessions are disabled */
  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  /** Current session ID */
  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  /** Current session display name, if set */
  get sessionName(): string | undefined {
    return this.sessionManager.getSessionName();
  }

  /** Scoped models for cycling (from --models flag) */
  get scopedModels(): ReadonlyArray<{ model: Model; thinkingLevel?: ThinkingLevel }> {
    return this.scopedModelEntries;
  }

  /** Update scoped models for cycling */
  setScopedModels(scopedModels: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>): void {
    this.scopedModelEntries = scopedModels;
  }

  /** File-based prompt templates */
  get promptTemplates(): ReadonlyArray<PromptTemplate> {
    return this.sessionResourceLoader.getPrompts().prompts;
  }

  protected normalizePromptSnippet(text: string | undefined): string | undefined {
    if (!text) {
      return undefined;
    }
    const oneLine = text
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return oneLine.length > 0 ? oneLine : undefined;
  }

  protected normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
    if (!guidelines || guidelines.length === 0) {
      return [];
    }

    const unique = new Set<string>();
    for (const guideline of guidelines) {
      const normalized = guideline.trim();
      if (normalized.length > 0) {
        unique.add(normalized);
      }
    }
    return Array.from(unique);
  }

  protected collectActiveToolPromptMetadata(toolNames: string[]): ActiveToolPromptMetadata {
    const validToolNames = toolNames.filter((name) => this.toolRegistry.has(name));
    const toolSnippets: Record<string, string> = {};
    const promptGuidelines: string[] = [];
    for (const name of validToolNames) {
      const snippet = this.toolPromptSnippets.get(name);
      if (snippet) {
        toolSnippets[name] = snippet;
      }

      const toolGuidelines = this.toolPromptGuidelines.get(name);
      if (toolGuidelines) {
        promptGuidelines.push(...toolGuidelines);
      }
    }

    return { validToolNames, toolSnippets, promptGuidelines };
  }

  protected rebuildSystemPrompt(toolNames: string[]): string {
    const { validToolNames, toolSnippets, promptGuidelines } =
      this.collectActiveToolPromptMetadata(toolNames);

    if (this.exactBaseSystemPrompt !== undefined) {
      this.baseSystemPromptOptions = {
        ...this.baseSystemPromptOptions,
        cwd: this.cwd,
        customPrompt: this.exactBaseSystemPrompt,
        selectedTools: validToolNames,
        toolSnippets,
        promptGuidelines,
      };
      return this.exactBaseSystemPrompt;
    }

    const loaderSystemPrompt = this.sessionResourceLoader.getSystemPrompt();
    const loaderAppendSystemPrompt = this.sessionResourceLoader.getAppendSystemPrompt();
    const appendSystemPrompt =
      loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
    const loadedSkills = this.sessionResourceLoader.getSkills().skills;
    const loadedContextFiles = this.sessionResourceLoader.getAgentsFiles().agentsFiles;

    this.baseSystemPromptOptions = {
      cwd: this.cwd,
      skills: loadedSkills,
      contextFiles: loadedContextFiles,
      customPrompt: loaderSystemPrompt,
      appendSystemPrompt,
      selectedTools: validToolNames,
      toolSnippets,
      promptGuidelines,
    };
    return buildSystemPrompt(this.baseSystemPromptOptions);
  }

  protected abstract isRetryableError(message: AssistantMessage): boolean;
  protected abstract prepareRetry(message: AssistantMessage): Promise<boolean>;
  protected abstract checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck?: boolean,
  ): Promise<boolean>;
  abstract abortRetry(): void;
  abstract abortCompaction(): void;
  abstract abortBranchSummary(): void;
  abstract abortBash(): void;
  protected abstract flushPendingBashMessages(): void;
}
