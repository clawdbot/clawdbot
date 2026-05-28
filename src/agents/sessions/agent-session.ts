/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { CURRENT_SESSION_VERSION } from "../../config/sessions/version.js";
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
  modelsAreEqual,
} from "../../llm/model-utils.js";
import { resetApiProviders } from "../../llm/providers/register-builtins.js";
import { cleanupSessionResources } from "../../llm/session-resources.js";
import { streamSimple } from "../../llm/stream.js";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
} from "../../llm/types.js";
import { isContextOverflow } from "../../llm/utils/overflow.js";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentState,
  AgentTool,
  BranchSummaryResult as CoreBranchSummaryResult,
  CompactionResult,
  ThinkingLevel,
} from "../runtime/index.js";
import {
  calculateContextTokens,
  collectEntriesForBranchSummaryFromBranches,
  compact,
  estimateContextTokens,
  generateBranchSummary,
  prepareCompaction,
  shouldCompact,
} from "../runtime/index.js";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { sleep } from "../utils/sleep.js";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.js";
import { type BashResult, executeBashWithOperations } from "./bash-executor.js";
import { DEFAULT_THINKING_LEVEL } from "./defaults.js";
import {
  type ContextUsage,
  type ExtensionCommandContextActions,
  type ExtensionErrorListener,
  ExtensionRunner,
  type ExtensionUIContext,
  type InputSource,
  type MessageEndEvent,
  type MessageStartEvent,
  type MessageUpdateEvent,
  type ReplacedSessionContext,
  type SessionStartEvent,
  type ShutdownHandler,
  type ToolDefinition,
  type ToolExecutionEndEvent,
  type ToolExecutionStartEvent,
  type ToolExecutionUpdateEvent,
  type ToolInfo,
  type TreePreparation,
  type TurnEndEvent,
  type TurnStartEvent,
  wrapRegisteredTools,
} from "./extensions/index.js";
import { emitSessionShutdownEvent } from "./extensions/runner.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import type { ModelRegistry } from "./model-registry.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.js";
import type { BranchSummaryEntry, CompactionEntry, SessionManager } from "./session-manager.js";
import { getLatestCompactionEntry, type SessionHeader } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";
import type { SlashCommandInfo } from "./slash-commands.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.js";
import type { BashOperations } from "./tools/bash-operations.js";
import { createLocalBashOperations } from "./tools/bash.js";
import { createAllToolDefinitions } from "./tools/index.js";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.js";

function unwrapCoreResult<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (result.ok) {
    return result.value;
  }
  throw result.error;
}

function normalizeBranchSummaryResult(
  result:
    | { ok: true; value: CoreBranchSummaryResult }
    | { ok: false; error: { code: string; message: string } },
): {
  summary?: string;
  readFiles?: string[];
  modifiedFiles?: string[];
  aborted?: boolean;
  error?: string;
} {
  if (result.ok) {
    return result.value;
  }
  if (result.error.code === "aborted") {
    return { aborted: true, error: result.error.message };
  }
  return { error: result.error.message };
}

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
  name: string;
  location: string;
  content: string;
  userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
  const match = text.match(
    /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/,
  );
  if (!match) {
    return null;
  }
  return {
    name: match[1],
    location: match[2],
    content: match[3],
    userMessage: match[4]?.trim() || undefined,
  };
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | {
      type: "agent_end";
      messages: AgentMessage[];
      willRetry: boolean;
    }
  | {
      type: "queue_update";
      steering: readonly string[];
      followUp: readonly string[];
    }
  | { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
  | { type: "session_info_changed"; name: string | undefined }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | {
      type: "compaction_end";
      reason: "manual" | "threshold" | "overflow";
      result: CompactionResult | undefined;
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    }
  | {
      type: "auto_retry_start";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      errorMessage: string;
    }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type AgentSessionWriteLockRunner = <T>(run: () => Promise<T> | T) => Promise<T>;

// ============================================================================
// Types
// ============================================================================

export interface AgentSessionConfig {
  agent: Agent;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;
  /** Models to cycle through with Ctrl+P (from --models flag) */
  scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
  /** Resource loader for skills, prompts, themes, context files, system prompt */
  resourceLoader: ResourceLoader;
  /** SDK custom tools registered outside extensions */
  customTools?: ToolDefinition[];
  /** Model registry for API key resolution and model discovery */
  modelRegistry: ModelRegistry;
  /** Initial active built-in tool names. Default: [read, bash, edit, write] */
  initialActiveToolNames?: string[];
  /** Optional allowlist of tool names. When provided, only these tool names are exposed. */
  allowedToolNames?: string[];
  /** Exclude built-in shell/filesystem tools from the registry. */
  disableBuiltInTools?: boolean;
  /**
   * Override base tools (useful for custom runtimes).
   *
   * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
   * a definition-first registry even when callers provide plain AgentTool instances.
   */
  baseToolsOverride?: Record<string, AgentTool>;
  /** Mutable ref used by Agent to access the current ExtensionRunner */
  extensionRunnerRef?: { current?: ExtensionRunner };
  /** Session start event metadata emitted when extensions bind to this runtime. */
  sessionStartEvent?: SessionStartEvent;
  /** Optional lock used by embedded runs before session-file writes or write-capable hooks. */
  withSessionWriteLock?: AgentSessionWriteLockRunner;
}

export interface ExtensionBindings {
  uiContext?: ExtensionUIContext;
  commandContextActions?: ExtensionCommandContextActions;
  abortHandler?: () => void;
  shutdownHandler?: ShutdownHandler;
  onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
  /** Whether to expand file-based prompt templates (default: true) */
  expandPromptTemplates?: boolean;
  /** Image attachments */
  images?: ImageContent[];
  /** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
  streamingBehavior?: "steer" | "followUp";
  /** Source of input for extension input event handlers. Defaults to "interactive". */
  source?: InputSource;
  /** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
  preflightResult?: (success: boolean) => void;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
  model: Model;
  thinkingLevel: ThinkingLevel;
  /** Whether cycling through scoped models (--models flag) or all available */
  isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

type CompactionReason = "manual" | "threshold" | "overflow";

type CompactionWorkOutcome =
  | { status: "compacted"; result: CompactionResult }
  | { status: "aborted" }
  | { status: "skipped" };

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;

  private scopedModelEntries: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;

  // Event subscription state
  private unsubscribeAgent?: () => void;
  private eventListeners: AgentSessionEventListener[] = [];

  /** Tracks pending steering messages for UI display. Removed when delivered. */
  private steeringMessages: string[] = [];
  /** Tracks pending follow-up messages for UI display. Removed when delivered. */
  private followUpMessages: string[] = [];
  /** Messages queued to be included with the next user prompt as context ("asides"). */
  private pendingNextTurnMessages: CustomMessage[] = [];

  // Compaction state
  private compactionAbortController: AbortController | undefined = undefined;
  private autoCompactionAbortController: AbortController | undefined = undefined;
  private overflowRecoveryAttempted = false;

  // Branch summarization state
  private branchSummaryAbortController: AbortController | undefined = undefined;

  // Retry state
  private retryAbortController: AbortController | undefined = undefined;
  private retryCount = 0;

  // Bash execution state
  private bashAbortController: AbortController | undefined = undefined;
  private pendingBashMessages: BashExecutionMessage[] = [];

  // Extension system
  private currentExtensionRunner!: ExtensionRunner;
  private turnIndex = 0;

  private sessionResourceLoader: ResourceLoader;
  private customTools: ToolDefinition[];
  private baseToolDefinitions: Map<string, ToolDefinition> = new Map();
  private cwd: string;
  private extensionRunnerRef?: { current?: ExtensionRunner };
  private initialActiveToolNames?: string[];
  private allowedToolNames?: Set<string>;
  private disableBuiltInTools: boolean;
  private baseToolsOverride?: Record<string, AgentTool>;
  private sessionStartEvent: SessionStartEvent;
  private withExternalSessionWriteLock?: AgentSessionWriteLockRunner;
  private extensionUIContext?: ExtensionUIContext;
  private extensionCommandContextActions?: ExtensionCommandContextActions;
  private extensionAbortHandler?: () => void;
  private extensionShutdownHandler?: ShutdownHandler;
  private extensionErrorListener?: ExtensionErrorListener;
  private extensionErrorUnsubscriber?: () => void;

  // Model registry for API key resolution
  private sessionModelRegistry: ModelRegistry;

  // Tool registry for extension getTools/setTools
  private toolRegistry: Map<string, AgentTool> = new Map();
  private toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
  private toolPromptSnippets: Map<string, string> = new Map();
  private toolPromptGuidelines: Map<string, string[]> = new Map();

  // Base system prompt (without extension appends) - used to apply fresh appends each turn
  private baseSystemPrompt = "";
  private baseSystemPromptOptions!: BuildSystemPromptOptions;

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

    // Always subscribe to agent events for internal handling
    // (session persistence, extensions, auto-compaction, retry logic)
    this.unsubscribeAgent = this.agent.subscribe(this.handleAgentEvent);
    this.installAgentToolHooks();

    this.buildRuntime({
      activeToolNames: this.initialActiveToolNames,
      includeAllExtensionTools: true,
    });
  }

  /** Model registry for API key resolution and model discovery */
  get modelRegistry(): ModelRegistry {
    return this.sessionModelRegistry;
  }

  private async getRequiredRequestAuth(model: Model): Promise<{
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

  private async getCompactionRequestAuth(model: Model): Promise<{
    apiKey?: string;
    headers?: Record<string, string>;
  }> {
    if (this.agent.streamFn === streamSimple) {
      return this.getRequiredRequestAuth(model);
    }

    const result = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    return result.ok ? { apiKey: result.apiKey, headers: result.headers } : {};
  }

  private async runWithSessionWriteLock<T>(run: () => Promise<T> | T): Promise<T> {
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
  private installAgentToolHooks(): void {
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
  private emit(event: AgentSessionEvent): void {
    for (const l of this.eventListeners) {
      l(event);
    }
  }

  private emitQueueUpdate(): void {
    this.emit({
      type: "queue_update",
      steering: [...this.steeringMessages],
      followUp: [...this.followUpMessages],
    });
  }

  // Track last assistant message for auto-compaction check
  private lastAssistantMessage: AssistantMessage | undefined = undefined;

  /** Internal handler for agent events - shared by subscribe and reconnect */
  private handleAgentEvent = async (event: AgentEvent): Promise<void> => {
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
      const messageText = this.getUserMessageText(event.message);
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
    await this.emitExtensionEvent(event);

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
        this.sessionManager.appendMessage(event.message);
      }
      // Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

      // Track assistant message for auto-compaction (checked on agent_end)
      if (event.message.role === "assistant") {
        this.lastAssistantMessage = event.message;

        const assistantMsg = event.message;
        if (assistantMsg.stopReason !== "error") {
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

    for (let i = event.messages.length - 1; i >= 0; i--) {
      const message = event.messages[i];
      if (message.role === "assistant") {
        return this.isRetryableError(message);
      }
    }
    return false;
  }

  /** Extract text content from a message */
  private getUserMessageText(message: Message): string {
    if (message.role !== "user") {
      return "";
    }
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    const textBlocks = content.filter((c) => c.type === "text");
    return textBlocks.map((c) => c.text).join("");
  }

  /** Find the last assistant message in agent state (including aborted ones) */
  private findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
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
  private async emitExtensionEvent(event: AgentEvent): Promise<void> {
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
  private disconnectFromAgent(): void {
    if (this.unsubscribeAgent) {
      this.unsubscribeAgent();
      this.unsubscribeAgent = undefined;
    }
  }

  /**
   * Reconnect to agent events after disconnectFromAgent().
   * Preserves all existing listeners.
   */
  private reconnectToAgent(): void {
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
    this.agent.state.systemPrompt = this.baseSystemPrompt;
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

  private normalizePromptSnippet(text: string | undefined): string | undefined {
    if (!text) {
      return undefined;
    }
    const oneLine = text
      .replace(/[\r\n]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return oneLine.length > 0 ? oneLine : undefined;
  }

  private normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
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

  private rebuildSystemPrompt(toolNames: string[]): string {
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

  // =========================================================================
  // Prompting
  // =========================================================================

  private async runAgentPrompt(messages: AgentMessage | AgentMessage[]): Promise<void> {
    try {
      await this.agent.prompt(messages);
      while (await this.handlePostAgentRun()) {
        await this.agent.continue();
      }
    } finally {
      this.flushPendingBashMessages();
    }
  }

  private async handlePostAgentRun(): Promise<boolean> {
    const msg = this.lastAssistantMessage;
    this.lastAssistantMessage = undefined;
    if (!msg) {
      return false;
    }

    if (this.isRetryableError(msg) && (await this.prepareRetry(msg))) {
      return true;
    }

    if (msg.stopReason === "error" && this.retryCount > 0) {
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt: this.retryCount,
        finalError: msg.errorMessage,
      });
      this.retryCount = 0;
    }

    return await this.checkCompaction(msg);
  }

  /**
   * Send a prompt to the agent.
   * - Handles extension commands immediately, even during streaming
   * - Expands file-based prompt templates by default
   * - During streaming, queues via steer() or followUp() based on streamingBehavior option
   * - Validates model and API key before sending (when not streaming)
   * @throws Error if streaming and no streamingBehavior specified
   * @throws Error if no model selected or no API key available (when not streaming)
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    const expandPromptTemplates = options?.expandPromptTemplates ?? true;
    const preflightResult = options?.preflightResult;
    let messages: AgentMessage[] | undefined;

    try {
      // Handle extension commands first (execute immediately, even during streaming)
      // Extension commands manage their own LLM interaction via the session API.
      if (expandPromptTemplates && text.startsWith("/")) {
        const handled = await this.tryExecuteExtensionCommand(text);
        if (handled) {
          // Extension command executed, no prompt to send
          preflightResult?.(true);
          return;
        }
      }

      // Emit input event for extension interception (before skill/template expansion)
      let currentText = text;
      let currentImages = options?.images;
      if (this.currentExtensionRunner.hasHandlers("input")) {
        const inputResult = await this.currentExtensionRunner.emitInput(
          currentText,
          currentImages,
          options?.source ?? "interactive",
        );
        if (inputResult.action === "handled") {
          preflightResult?.(true);
          return;
        }
        if (inputResult.action === "transform") {
          currentText = inputResult.text;
          currentImages = inputResult.images ?? currentImages;
        }
      }

      // Expand skill commands (/skill:name args) and prompt templates (/template args)
      let expandedText = currentText;
      if (expandPromptTemplates) {
        expandedText = this.expandSkillCommand(expandedText);
        expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
      }

      // If streaming, queue via steer() or followUp() based on option
      if (this.isStreaming) {
        if (!options?.streamingBehavior) {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          );
        }
        if (options.streamingBehavior === "followUp") {
          await this.queueFollowUp(expandedText, currentImages);
        } else {
          await this.queueSteer(expandedText, currentImages);
        }
        preflightResult?.(true);
        return;
      }

      // Flush any pending bash messages before the new prompt
      this.flushPendingBashMessages();

      // Validate model
      if (!this.model) {
        throw new Error(formatNoModelSelectedMessage());
      }

      if (!this.sessionModelRegistry.hasConfiguredAuth(this.model)) {
        const isOAuth = this.sessionModelRegistry.isUsingOAuth(this.model);
        if (isOAuth) {
          throw new Error(
            `Authentication failed for "${this.model.provider}". ` +
              `Credentials may have expired or network is unavailable. ` +
              `Run '/login ${this.model.provider}' to re-authenticate.`,
          );
        }
        throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
      }

      // Check if we need to compact before sending (catches aborted responses)
      const lastAssistant = this.findLastAssistantMessage();
      if (lastAssistant && (await this.checkCompaction(lastAssistant, false))) {
        try {
          await this.agent.continue();
          while (await this.handlePostAgentRun()) {
            await this.agent.continue();
          }
        } finally {
          this.flushPendingBashMessages();
        }
      }

      // Build messages array (custom message if any, then user message)
      messages = [];

      // Add user message
      const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
      if (currentImages) {
        userContent.push(...currentImages);
      }
      messages.push({
        role: "user",
        content: userContent,
        timestamp: Date.now(),
      });

      // Inject any pending "nextTurn" messages as context alongside the user message
      for (const msg of this.pendingNextTurnMessages) {
        messages.push(msg);
      }
      this.pendingNextTurnMessages = [];

      // Emit before_agent_start extension event
      const result = await this.currentExtensionRunner.emitBeforeAgentStart(
        expandedText,
        currentImages,
        this.baseSystemPrompt,
        this.baseSystemPromptOptions,
      );
      // Add all custom messages from extensions
      if (result?.messages) {
        for (const msg of result.messages) {
          messages.push({
            role: "custom",
            customType: msg.customType,
            content: msg.content,
            display: msg.display,
            details: msg.details,
            timestamp: Date.now(),
          });
        }
      }
      // Apply extension-modified system prompt, or reset to base
      if (result?.systemPrompt) {
        this.agent.state.systemPrompt = result.systemPrompt;
      } else {
        // Ensure we're using the base prompt (in case previous turn had modifications)
        this.agent.state.systemPrompt = this.baseSystemPrompt;
      }
    } catch (error) {
      preflightResult?.(false);
      throw error;
    }

    if (!messages) {
      return;
    }

    preflightResult?.(true);
    await this.runAgentPrompt(messages);
  }

  /**
   * Try to execute an extension command. Returns true if command was found and executed.
   */
  private async tryExecuteExtensionCommand(text: string): Promise<boolean> {
    // Parse command name and args
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

    const command = this.currentExtensionRunner.getCommand(commandName);
    if (!command) {
      return false;
    }

    // Get command context from extension runner (includes session control methods)
    const ctx = this.currentExtensionRunner.createCommandContext();

    try {
      await command.handler(args, ctx);
      return true;
    } catch (err) {
      // Emit error via extension runner
      this.currentExtensionRunner.emitError({
        extensionPath: `command:${commandName}`,
        event: "command",
        error: err instanceof Error ? err.message : String(err),
      });
      return true;
    }
  }

  /**
   * Expand skill commands (/skill:name args) to their full content.
   * Returns the expanded text, or the original text if not a skill command or skill not found.
   * Emits errors via extension runner if file read fails.
   */
  private expandSkillCommand(text: string): string {
    if (!text.startsWith("/skill:")) {
      return text;
    }

    const spaceIndex = text.indexOf(" ");
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

    const skill = this.sessionResourceLoader.getSkills().skills.find((s) => s.name === skillName);
    if (!skill) {
      return text;
    } // Unknown skill, pass through

    try {
      const content = readFileSync(skill.filePath, "utf-8");
      const body = stripFrontmatter(content).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    } catch (err) {
      // Emit error like extension commands do
      this.currentExtensionRunner.emitError({
        extensionPath: skill.filePath,
        event: "skill_expansion",
        error: err instanceof Error ? err.message : String(err),
      });
      return text; // Return original on error
    }
  }

  /**
   * Queue a steering message while the agent is running.
   * Delivered after the current assistant turn finishes executing its tool calls,
   * before the next LLM call.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async steer(text: string, images?: ImageContent[]): Promise<void> {
    // Check for extension commands (cannot be queued)
    if (text.startsWith("/")) {
      this.throwIfExtensionCommand(text);
    }

    // Expand skill commands and prompt templates
    let expandedText = this.expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

    await this.queueSteer(expandedText, images);
  }

  /**
   * Queue a follow-up message to be processed after the agent finishes.
   * Delivered only when agent has no more tool calls or steering messages.
   * Expands skill commands and prompt templates. Errors on extension commands.
   * @param images Optional image attachments to include with the message
   * @throws Error if text is an extension command
   */
  async followUp(text: string, images?: ImageContent[]): Promise<void> {
    // Check for extension commands (cannot be queued)
    if (text.startsWith("/")) {
      this.throwIfExtensionCommand(text);
    }

    // Expand skill commands and prompt templates
    let expandedText = this.expandSkillCommand(text);
    expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

    await this.queueFollowUp(expandedText, images);
  }

  /**
   * Internal: Queue a steering message (already expanded, no extension command check).
   */
  private async queueSteer(text: string, images?: ImageContent[]): Promise<void> {
    this.steeringMessages.push(text);
    this.emitQueueUpdate();
    const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
    if (images) {
      content.push(...images);
    }
    this.agent.steer({
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Internal: Queue a follow-up message (already expanded, no extension command check).
   */
  private async queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
    this.followUpMessages.push(text);
    this.emitQueueUpdate();
    const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
    if (images) {
      content.push(...images);
    }
    this.agent.followUp({
      role: "user",
      content,
      timestamp: Date.now(),
    });
  }

  /**
   * Throw an error if the text is an extension command.
   */
  private throwIfExtensionCommand(text: string): void {
    const spaceIndex = text.indexOf(" ");
    const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
    const command = this.currentExtensionRunner.getCommand(commandName);

    if (command) {
      throw new Error(
        `Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
      );
    }
  }

  /**
   * Send a custom message to the session. Creates a CustomMessageEntry.
   *
   * Handles three cases:
   * - Streaming: queues message, processed when loop pulls from queue
   * - Not streaming + triggerTurn: appends to state/session, starts new turn
   * - Not streaming + no trigger: appends to state/session, no turn
   *
   * @param message Custom message with customType, content, display, details
   * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
   * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
   */
  async sendCustomMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void> {
    const appMessage = {
      role: "custom" as const,
      customType: message.customType,
      content: message.content,
      display: message.display,
      details: message.details,
      timestamp: Date.now(),
    } satisfies CustomMessage<T>;
    if (options?.deliverAs === "nextTurn") {
      this.pendingNextTurnMessages.push(appMessage);
    } else if (this.isStreaming) {
      if (options?.deliverAs === "followUp") {
        this.agent.followUp(appMessage);
      } else {
        this.agent.steer(appMessage);
      }
    } else if (options?.triggerTurn) {
      await this.runAgentPrompt(appMessage);
    } else {
      this.agent.state.messages.push(appMessage);
      this.sessionManager.appendCustomMessageEntry(
        message.customType,
        message.content,
        message.display,
        message.details,
      );
      this.emit({ type: "message_start", message: appMessage });
      this.emit({ type: "message_end", message: appMessage });
    }
  }

  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   *
   * @param content User message content (string or content array)
   * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
   */
  async sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> {
    // Normalize content to text string + optional images
    let text: string;
    let images: ImageContent[] | undefined;

    if (typeof content === "string") {
      text = content;
    } else {
      const textParts: string[] = [];
      images = [];
      for (const part of content) {
        if (part.type === "text") {
          textParts.push(part.text);
        } else {
          images.push(part);
        }
      }
      text = textParts.join("\n");
      if (images.length === 0) {
        images = undefined;
      }
    }

    // Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
    await this.prompt(text, {
      expandPromptTemplates: false,
      streamingBehavior: options?.deliverAs,
      images,
      source: "extension",
    });
  }

  /**
   * Clear all queued messages and return them.
   * Useful for restoring to editor when user aborts.
   * @returns Object with steering and followUp arrays
   */
  clearQueue(): { steering: string[]; followUp: string[] } {
    const steering = [...this.steeringMessages];
    const followUp = [...this.followUpMessages];
    this.steeringMessages = [];
    this.followUpMessages = [];
    this.agent.clearAllQueues();
    this.emitQueueUpdate();
    return { steering, followUp };
  }

  /** Number of pending messages (includes both steering and follow-up) */
  get pendingMessageCount(): number {
    return this.steeringMessages.length + this.followUpMessages.length;
  }

  /** Get pending steering messages (read-only) */
  getSteeringMessages(): readonly string[] {
    return this.steeringMessages;
  }

  /** Get pending follow-up messages (read-only) */
  getFollowUpMessages(): readonly string[] {
    return this.followUpMessages;
  }

  get resourceLoader(): ResourceLoader {
    return this.sessionResourceLoader;
  }

  /**
   * Abort current operation and wait for agent to become idle.
   */
  async abort(): Promise<void> {
    this.abortRetry();
    this.agent.abort();
    await this.agent.waitForIdle();
  }

  // =========================================================================
  // Model Management
  // =========================================================================

  private async emitModelSelect(
    nextModel: Model,
    previousModel: Model | undefined,
    source: "set" | "cycle" | "restore",
  ): Promise<void> {
    if (modelsAreEqual(previousModel, nextModel)) {
      return;
    }
    await this.currentExtensionRunner.emit({
      type: "model_select",
      model: nextModel,
      previousModel,
      source,
    });
  }

  /**
   * Set model directly.
   * Validates that auth is configured, saves to session and settings.
   * @throws Error if no auth is configured for the model
   */
  async setModel(model: Model): Promise<void> {
    if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
      throw new Error(`No API key for ${model.provider}/${model.id}`);
    }

    const previousModel = this.model;
    const thinkingLevel = this.getThinkingLevelForModelSwitch();
    this.agent.state.model = model;
    this.sessionManager.appendModelChange(model.provider, model.id);
    this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

    // Re-clamp thinking level for new model's capabilities
    this.setThinkingLevel(thinkingLevel);

    await this.emitModelSelect(model, previousModel, "set");
  }

  /**
   * Cycle to next/previous model.
   * Uses scoped models (from --models flag) if available, otherwise all available models.
   * @param direction - "forward" (default) or "backward"
   * @returns The new model info, or undefined if only one model available
   */
  async cycleModel(
    direction: "forward" | "backward" = "forward",
  ): Promise<ModelCycleResult | undefined> {
    if (this.scopedModelEntries.length > 0) {
      return this.cycleScopedModel(direction);
    }
    return this.cycleAvailableModel(direction);
  }

  private async cycleScopedModel(
    direction: "forward" | "backward",
  ): Promise<ModelCycleResult | undefined> {
    const scopedModels = this.scopedModelEntries.filter((scoped) =>
      this.sessionModelRegistry.hasConfiguredAuth(scoped.model),
    );
    if (scopedModels.length <= 1) {
      return undefined;
    }

    const currentModel = this.model;
    let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

    if (currentIndex === -1) {
      currentIndex = 0;
    }
    const len = scopedModels.length;
    const nextIndex =
      direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const next = scopedModels[nextIndex];
    const thinkingLevel = this.getThinkingLevelForModelSwitch(next.thinkingLevel);

    // Apply model
    this.agent.state.model = next.model;
    this.sessionManager.appendModelChange(next.model.provider, next.model.id);
    this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

    // Apply thinking level.
    // - Explicit scoped model thinking level overrides current session level
    // - Undefined scoped model thinking level inherits the current session preference
    // setThinkingLevel clamps to model capabilities.
    this.setThinkingLevel(thinkingLevel);

    await this.emitModelSelect(next.model, currentModel, "cycle");

    return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
  }

  private async cycleAvailableModel(
    direction: "forward" | "backward",
  ): Promise<ModelCycleResult | undefined> {
    const availableModels = this.sessionModelRegistry.getAvailable();
    if (availableModels.length <= 1) {
      return undefined;
    }

    const currentModel = this.model;
    let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

    if (currentIndex === -1) {
      currentIndex = 0;
    }
    const len = availableModels.length;
    const nextIndex =
      direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
    const nextModel = availableModels[nextIndex];

    const thinkingLevel = this.getThinkingLevelForModelSwitch();
    this.agent.state.model = nextModel;
    this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
    this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

    // Re-clamp thinking level for new model's capabilities
    this.setThinkingLevel(thinkingLevel);

    await this.emitModelSelect(nextModel, currentModel, "cycle");

    return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
  }

  // =========================================================================
  // Thinking Level Management
  // =========================================================================

  /**
   * Set thinking level.
   * Clamps to model capabilities based on available thinking levels.
   * Saves to session and settings only if the level actually changes.
   */
  setThinkingLevel(level: ThinkingLevel): void {
    const availableLevels = this.getAvailableThinkingLevels();
    const effectiveLevel = availableLevels.includes(level) ? level : this.clampThinkingLevel(level);

    // Only persist if actually changing
    const previousLevel = this.agent.state.thinkingLevel;
    const isChanging = effectiveLevel !== previousLevel;

    this.agent.state.thinkingLevel = effectiveLevel;

    if (isChanging) {
      this.sessionManager.appendThinkingLevelChange(effectiveLevel);
      if (this.supportsThinking() || effectiveLevel !== "off") {
        this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
      }
      this.emit({ type: "thinking_level_changed", level: effectiveLevel });
      void this.currentExtensionRunner.emit({
        type: "thinking_level_select",
        level: effectiveLevel,
        previousLevel,
      });
    }
  }

  /**
   * Cycle to next thinking level.
   * @returns New level, or undefined if model doesn't support thinking
   */
  cycleThinkingLevel(): ThinkingLevel | undefined {
    if (!this.supportsThinking()) {
      return undefined;
    }

    const levels = this.getAvailableThinkingLevels();
    const currentIndex = levels.indexOf(this.thinkingLevel);
    const nextIndex = (currentIndex + 1) % levels.length;
    const nextLevel = levels[nextIndex];

    this.setThinkingLevel(nextLevel);
    return nextLevel;
  }

  /**
   * Get available thinking levels for current model.
   * The provider will clamp to what the specific model supports internally.
   */
  getAvailableThinkingLevels(): ThinkingLevel[] {
    if (!this.model) {
      return THINKING_LEVELS;
    }
    return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
  }

  /**
   * Check if current model supports thinking/reasoning.
   */
  supportsThinking(): boolean {
    return !!this.model?.reasoning;
  }

  private getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
    if (explicitLevel !== undefined) {
      return explicitLevel;
    }
    if (!this.supportsThinking()) {
      return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
    }
    return this.thinkingLevel;
  }

  private clampThinkingLevel(level: ThinkingLevel): ThinkingLevel {
    return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
  }

  // =========================================================================
  // Queue Mode Management
  // =========================================================================

  /**
   * Set steering message mode.
   * Saves to settings.
   */
  setSteeringMode(mode: "all" | "one-at-a-time"): void {
    this.agent.steeringMode = mode;
    this.settingsManager.setSteeringMode(mode);
  }

  /**
   * Set follow-up message mode.
   * Saves to settings.
   */
  setFollowUpMode(mode: "all" | "one-at-a-time"): void {
    this.agent.followUpMode = mode;
    this.settingsManager.setFollowUpMode(mode);
  }

  // =========================================================================
  // Compaction
  // =========================================================================

  /**
   * Manually compact the session context.
   * Aborts current agent operation first.
   * @param customInstructions Optional instructions for the compaction summary
   */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    return await this.runWithSessionWriteLock(
      async () => await this.compactWithSessionWriteLock(customInstructions),
    );
  }

  private async compactWithSessionWriteLock(
    customInstructions?: string,
  ): Promise<CompactionResult> {
    this.disconnectFromAgent();
    await this.abort();
    this.compactionAbortController = new AbortController();
    this.emit({ type: "compaction_start", reason: "manual" });

    try {
      const settings = this.settingsManager.getCompactionSettings();
      const outcome = await this.runCompactionWork({
        customInstructions,
        mode: "manual",
        settings,
        signal: this.compactionAbortController.signal,
      });
      if (outcome.status !== "compacted") {
        throw new Error("Compaction cancelled");
      }

      this.emit({
        type: "compaction_end",
        reason: "manual",
        result: outcome.result,
        aborted: false,
        willRetry: false,
      });
      return outcome.result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted =
        message === "Compaction cancelled" ||
        (error instanceof Error && error.name === "AbortError");
      this.emit({
        type: "compaction_end",
        reason: "manual",
        result: undefined,
        aborted,
        willRetry: false,
        errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
      });
      throw error;
    } finally {
      this.compactionAbortController = undefined;
      this.reconnectToAgent();
    }
  }

  /**
   * Cancel in-progress compaction (manual or auto).
   */
  abortCompaction(): void {
    this.compactionAbortController?.abort();
    this.autoCompactionAbortController?.abort();
  }

  /**
   * Cancel in-progress branch summarization.
   */
  abortBranchSummary(): void {
    this.branchSummaryAbortController?.abort();
  }

  private async getAutoCompactionRequestAuth(model: Model): Promise<
    | {
        apiKey?: string;
        headers?: Record<string, string>;
      }
    | undefined
  > {
    if (this.agent.streamFn !== streamSimple) {
      return this.getCompactionRequestAuth(model);
    }

    const authResult = await this.sessionModelRegistry.getApiKeyAndHeaders(model);
    if (!authResult.ok || !authResult.apiKey) {
      return undefined;
    }
    return { apiKey: authResult.apiKey, headers: authResult.headers };
  }

  private async runCompactionWork(options: {
    settings: ReturnType<SettingsManager["getCompactionSettings"]>;
    signal: AbortSignal;
    customInstructions?: string;
    mode: "manual" | "auto";
  }): Promise<CompactionWorkOutcome> {
    const isManual = options.mode === "manual";
    if (!this.model) {
      if (isManual) {
        throw new Error(formatNoModelSelectedMessage());
      }
      return { status: "skipped" };
    }

    const auth = isManual
      ? await this.getCompactionRequestAuth(this.model)
      : await this.getAutoCompactionRequestAuth(this.model);
    if (!auth) {
      return { status: "skipped" };
    }

    const pathEntries = this.sessionManager.getBranch();
    const preparation = unwrapCoreResult(prepareCompaction(pathEntries, options.settings));
    if (!preparation) {
      if (isManual) {
        const lastEntry = pathEntries[pathEntries.length - 1];
        throw new Error(
          lastEntry?.type === "compaction"
            ? "Already compacted"
            : "Nothing to compact (session too small)",
        );
      }
      return { status: "skipped" };
    }

    let compactionResult: CompactionResult | undefined;
    let fromExtension = false;
    if (this.currentExtensionRunner.hasHandlers("session_before_compact")) {
      const extensionResult = await this.currentExtensionRunner.emit({
        type: "session_before_compact",
        preparation,
        branchEntries: pathEntries,
        customInstructions: options.customInstructions,
        signal: options.signal,
      });

      if (extensionResult?.cancel) {
        return { status: "aborted" };
      }

      if (extensionResult?.compaction) {
        compactionResult = extensionResult.compaction;
        fromExtension = true;
      }
    }

    compactionResult ??= unwrapCoreResult(
      await compact(
        preparation,
        this.model,
        auth.apiKey,
        auth.headers,
        options.customInstructions,
        options.signal,
        this.thinkingLevel,
        this.agent.streamFn,
      ),
    );

    if (options.signal.aborted) {
      return { status: "aborted" };
    }

    this.sessionManager.appendCompaction(
      compactionResult.summary,
      compactionResult.firstKeptEntryId,
      compactionResult.tokensBefore,
      compactionResult.details,
      fromExtension,
    );
    const newEntries = this.sessionManager.getEntries();
    const sessionContext = this.sessionManager.buildSessionContext();
    this.agent.state.messages = sessionContext.messages;

    const savedCompactionEntry = newEntries.find(
      (e) => e.type === "compaction" && e.summary === compactionResult.summary,
    ) as CompactionEntry | undefined;

    if (this.currentExtensionRunner && savedCompactionEntry) {
      await this.currentExtensionRunner.emit({
        type: "session_compact",
        compactionEntry: savedCompactionEntry,
        fromExtension,
      });
    }

    return { status: "compacted", result: compactionResult };
  }

  /**
   * Check if compaction is needed and run it.
   * Called after agent_end and before prompt submission.
   *
   * Two cases:
   * 1. Overflow: LLM returned context overflow error, remove error message from agent state, compact, auto-retry
   * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
   *
   * @param assistantMessage The assistant message to check
   * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
   */
  private async checkCompaction(
    assistantMessage: AssistantMessage,
    skipAbortedCheck = true,
  ): Promise<boolean> {
    const settings = this.settingsManager.getCompactionSettings();
    if (!settings.enabled) {
      return false;
    }

    // Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
    if (skipAbortedCheck && assistantMessage.stopReason === "aborted") {
      return false;
    }

    const contextWindow = this.model?.contextWindow ?? 0;

    // Skip overflow check if the message came from a different model.
    // This handles the case where user switched from a smaller-context model (e.g. opus)
    // to a larger-context model (e.g. codex) - the overflow error from the old model
    // shouldn't trigger compaction for the new model.
    const sameModel =
      this.model &&
      assistantMessage.provider === this.model.provider &&
      assistantMessage.model === this.model.id;

    // Skip compaction checks if this assistant message is older than the latest
    // compaction boundary. This prevents a stale pre-compaction usage/error
    // from retriggering compaction on the first prompt after compaction.
    const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
    const assistantIsFromBeforeCompaction =
      compactionEntry !== null &&
      assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
    if (assistantIsFromBeforeCompaction) {
      return false;
    }

    // Case 1: Overflow - LLM returned context overflow error
    if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
      if (this.overflowRecoveryAttempted) {
        this.emit({
          type: "compaction_end",
          reason: "overflow",
          result: undefined,
          aborted: false,
          willRetry: false,
          errorMessage:
            "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
        });
        return false;
      }

      this.overflowRecoveryAttempted = true;
      // Remove the error message from agent state (it IS saved to session for history,
      // but we don't want it in context for the retry)
      const messages = this.agent.state.messages;
      if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
        this.agent.state.messages = messages.slice(0, -1);
      }
      return await this.runAutoCompaction("overflow", true);
    }

    // Case 2: Threshold - context is getting large
    // For error messages (no usage data), estimate from last successful response.
    // This ensures sessions that hit persistent API errors (e.g. 529) can still compact.
    let contextTokens: number;
    if (assistantMessage.stopReason === "error") {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex === null) {
        return false;
      } // No usage data at all
      // Verify the usage source is post-compaction. Kept pre-compaction messages
      // have stale usage reflecting the old (larger) context and would falsely
      // trigger compaction right after one just finished.
      const usageMsg = messages[estimate.lastUsageIndex];
      if (
        compactionEntry &&
        usageMsg.role === "assistant" &&
        usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()
      ) {
        return false;
      }
      contextTokens = estimate.tokens;
    } else {
      contextTokens = calculateContextTokens(assistantMessage.usage);
    }
    if (shouldCompact(contextTokens, contextWindow, settings)) {
      return await this.runAutoCompaction("threshold", false);
    }
    return false;
  }

  /**
   * Internal: Run auto-compaction with events.
   */
  private async runAutoCompaction(
    reason: Exclude<CompactionReason, "manual">,
    willRetry: boolean,
  ): Promise<boolean> {
    const settings = this.settingsManager.getCompactionSettings();

    this.emit({ type: "compaction_start", reason });
    this.autoCompactionAbortController = new AbortController();

    try {
      const outcome = await this.runCompactionWork({
        mode: "auto",
        settings,
        signal: this.autoCompactionAbortController.signal,
      });
      if (outcome.status === "skipped") {
        this.emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: false,
          willRetry: false,
        });
        return false;
      }
      if (outcome.status === "aborted") {
        this.emit({
          type: "compaction_end",
          reason,
          result: undefined,
          aborted: true,
          willRetry: false,
        });
        return false;
      }
      this.emit({
        type: "compaction_end",
        reason,
        result: outcome.result,
        aborted: false,
        willRetry,
      });

      if (willRetry) {
        const messages = this.agent.state.messages;
        const lastMsg = messages[messages.length - 1];
        if (lastMsg?.role === "assistant" && lastMsg.stopReason === "error") {
          this.agent.state.messages = messages.slice(0, -1);
        }
        return true;
      }

      // Auto-compaction can complete while follow-up/steering/custom messages are waiting.
      // Continue once so queued messages are delivered.
      return this.agent.hasQueuedMessages();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "compaction failed";
      this.emit({
        type: "compaction_end",
        reason,
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage:
          reason === "overflow"
            ? `Context overflow recovery failed: ${errorMessage}`
            : `Auto-compaction failed: ${errorMessage}`,
      });
      return false;
    } finally {
      this.autoCompactionAbortController = undefined;
    }
  }

  /**
   * Toggle auto-compaction setting.
   */
  setAutoCompactionEnabled(enabled: boolean): void {
    this.settingsManager.setCompactionEnabled(enabled);
  }

  /** Whether auto-compaction is enabled */
  get autoCompactionEnabled(): boolean {
    return this.settingsManager.getCompactionEnabled();
  }

  async bindExtensions(bindings: ExtensionBindings): Promise<void> {
    if (bindings.uiContext !== undefined) {
      this.extensionUIContext = bindings.uiContext;
    }
    if (bindings.commandContextActions !== undefined) {
      this.extensionCommandContextActions = bindings.commandContextActions;
    }
    if (bindings.abortHandler !== undefined) {
      this.extensionAbortHandler = bindings.abortHandler;
    }
    if (bindings.shutdownHandler !== undefined) {
      this.extensionShutdownHandler = bindings.shutdownHandler;
    }
    if (bindings.onError !== undefined) {
      this.extensionErrorListener = bindings.onError;
    }

    this.applyExtensionBindings(this.currentExtensionRunner);
    await this.currentExtensionRunner.emit(this.sessionStartEvent);
    await this.extendResourcesFromExtensions(
      this.sessionStartEvent.reason === "reload" ? "reload" : "startup",
    );
  }

  private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
    if (!this.currentExtensionRunner.hasHandlers("resources_discover")) {
      return;
    }

    const { skillPaths, promptPaths, themePaths } =
      await this.currentExtensionRunner.emitResourcesDiscover(this.cwd, reason);

    if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
      return;
    }

    const extensionPaths: ResourceExtensionPaths = {
      skillPaths: this.buildExtensionResourcePaths(skillPaths),
      promptPaths: this.buildExtensionResourcePaths(promptPaths),
      themePaths: this.buildExtensionResourcePaths(themePaths),
    };

    this.sessionResourceLoader.extendResources(extensionPaths);
    this.baseSystemPrompt = this.rebuildSystemPrompt(this.getActiveToolNames());
    this.agent.state.systemPrompt = this.baseSystemPrompt;
  }

  private buildExtensionResourcePaths(
    entries: Array<{ path: string; extensionPath: string }>,
  ): Array<{
    path: string;
    metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
  }> {
    return entries.map((entry) => {
      const source = this.getExtensionSourceLabel(entry.extensionPath);
      const baseDir = entry.extensionPath.startsWith("<")
        ? undefined
        : dirname(entry.extensionPath);
      return {
        path: entry.path,
        metadata: {
          source,
          scope: "temporary",
          origin: "top-level",
          baseDir,
        },
      };
    });
  }

  private getExtensionSourceLabel(extensionPath: string): string {
    if (extensionPath.startsWith("<")) {
      return `extension:${extensionPath.replace(/[<>]/g, "")}`;
    }
    const base = basename(extensionPath);
    const name = base.replace(/\.(ts|js)$/, "");
    return `extension:${name}`;
  }

  private applyExtensionBindings(runner: ExtensionRunner): void {
    runner.setUIContext(this.extensionUIContext);
    runner.bindCommandContext(this.extensionCommandContextActions);

    this.extensionErrorUnsubscriber?.();
    this.extensionErrorUnsubscriber = this.extensionErrorListener
      ? runner.onError(this.extensionErrorListener)
      : undefined;
  }

  private refreshCurrentModelFromRegistry(): void {
    const currentModel = this.model;
    if (!currentModel) {
      return;
    }

    const refreshedModel = this.sessionModelRegistry.find(currentModel.provider, currentModel.id);
    if (!refreshedModel || refreshedModel === currentModel) {
      return;
    }

    this.agent.state.model = refreshedModel;
  }

  private bindExtensionCore(runner: ExtensionRunner): void {
    const getCommands = (): SlashCommandInfo[] => {
      const extensionCommands: SlashCommandInfo[] = runner
        .getRegisteredCommands()
        .map((command) => ({
          name: command.invocationName,
          description: command.description,
          source: "extension",
          sourceInfo: command.sourceInfo,
        }));

      const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
        name: template.name,
        description: template.description,
        source: "prompt",
        sourceInfo: template.sourceInfo,
      }));

      const skills: SlashCommandInfo[] = this.sessionResourceLoader
        .getSkills()
        .skills.map((skill) => ({
          name: `skill:${skill.name}`,
          description: skill.description,
          source: "skill",
          sourceInfo: skill.sourceInfo,
        }));

      return [...extensionCommands, ...templates, ...skills];
    };

    runner.bindCore(
      {
        sendMessage: (message, options) => {
          this.sendCustomMessage(message, options).catch((err) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_message",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        sendUserMessage: (content, options) => {
          this.sendUserMessage(content, options).catch((err) => {
            runner.emitError({
              extensionPath: "<runtime>",
              event: "send_user_message",
              error: err instanceof Error ? err.message : String(err),
            });
          });
        },
        appendEntry: (customType, data) => {
          this.sessionManager.appendCustomEntry(customType, data);
        },
        setSessionName: (name) => {
          this.setSessionName(name);
        },
        getSessionName: () => {
          return this.sessionManager.getSessionName();
        },
        setLabel: (entryId, label) => {
          this.sessionManager.appendLabelChange(entryId, label);
        },
        getActiveTools: () => this.getActiveToolNames(),
        getAllTools: () => this.getAllTools(),
        setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
        refreshTools: () => this.refreshToolRegistry(),
        getCommands,
        setModel: async (model) => {
          if (!this.sessionModelRegistry.hasConfiguredAuth(model)) {
            return false;
          }
          await this.setModel(model);
          return true;
        },
        getThinkingLevel: () => this.thinkingLevel,
        setThinkingLevel: (level) => this.setThinkingLevel(level),
      },
      {
        getModel: () => this.model,
        isIdle: () => !this.isStreaming,
        getSignal: () => this.agent.signal,
        abort: () => {
          if (this.extensionAbortHandler) {
            this.extensionAbortHandler();
            return;
          }
          void this.abort();
        },
        hasPendingMessages: () => this.pendingMessageCount > 0,
        shutdown: () => {
          this.extensionShutdownHandler?.();
        },
        getContextUsage: () => this.getContextUsage(),
        compact: (options) => {
          void (async () => {
            try {
              const result = await this.compact(options?.customInstructions);
              options?.onComplete?.(result);
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              options?.onError?.(err);
            }
          })();
        },
        getSystemPrompt: () => this.systemPrompt,
      },
      {
        registerProvider: (name, config) => {
          this.sessionModelRegistry.registerProvider(name, config);
          this.refreshCurrentModelFromRegistry();
        },
        unregisterProvider: (name) => {
          this.sessionModelRegistry.unregisterProvider(name);
          this.refreshCurrentModelFromRegistry();
        },
      },
    );
  }

  private refreshToolRegistry(options?: {
    activeToolNames?: string[];
    includeAllExtensionTools?: boolean;
  }): void {
    const previousRegistryNames = new Set(this.toolRegistry.keys());
    const previousActiveToolNames = this.getActiveToolNames();
    const allowedToolNames = this.allowedToolNames;
    const isDisabledBuiltInToolName = (name: string): boolean =>
      this.disableBuiltInTools && this.baseToolDefinitions.has(name);
    const isAllowedTool = (name: string): boolean =>
      !isDisabledBuiltInToolName(name) && (!allowedToolNames || allowedToolNames.has(name));

    const registeredTools = this.currentExtensionRunner.getAllRegisteredTools();
    const allCustomTools = [
      ...registeredTools,
      ...this.customTools.map((definition) => ({
        definition,
        sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
      })),
    ].filter((tool) => isAllowedTool(tool.definition.name));
    const definitionRegistry = new Map<string, ToolDefinitionEntry>(
      Array.from(this.baseToolDefinitions.entries())
        .filter(([name]) => isAllowedTool(name))
        .map(([name, definition]) => [
          name,
          {
            definition,
            sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
          },
        ]),
    );
    for (const tool of allCustomTools) {
      definitionRegistry.set(tool.definition.name, {
        definition: tool.definition,
        sourceInfo: tool.sourceInfo,
      });
    }
    this.toolDefinitions = definitionRegistry;
    this.toolPromptSnippets = new Map(
      Array.from(definitionRegistry.values())
        .map(({ definition }) => {
          const snippet = this.normalizePromptSnippet(definition.promptSnippet);
          return snippet ? ([definition.name, snippet] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, string] => entry !== undefined),
    );
    this.toolPromptGuidelines = new Map(
      Array.from(definitionRegistry.values())
        .map(({ definition }) => {
          const guidelines = this.normalizePromptGuidelines(definition.promptGuidelines);
          return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
        })
        .filter((entry): entry is readonly [string, string[]] => entry !== undefined),
    );
    const runner = this.currentExtensionRunner;
    const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner);
    const wrappedBuiltInTools = wrapRegisteredTools(
      Array.from(this.baseToolDefinitions.values())
        .filter((definition) => isAllowedTool(definition.name))
        .map((definition) => ({
          definition,
          sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, {
            source: "builtin",
          }),
        })),
      runner,
    );

    const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
    for (const tool of wrappedExtensionTools) {
      toolRegistry.set(tool.name, tool);
    }
    this.toolRegistry = toolRegistry;

    const nextActiveToolNames = (
      options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
    ).filter((name) => isAllowedTool(name));

    if (allowedToolNames) {
      for (const toolName of this.toolRegistry.keys()) {
        if (allowedToolNames.has(toolName)) {
          nextActiveToolNames.push(toolName);
        }
      }
    } else if (options?.includeAllExtensionTools) {
      for (const tool of wrappedExtensionTools) {
        nextActiveToolNames.push(tool.name);
      }
    } else if (!options?.activeToolNames) {
      for (const toolName of this.toolRegistry.keys()) {
        if (!previousRegistryNames.has(toolName)) {
          nextActiveToolNames.push(toolName);
        }
      }
    }

    this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
  }

  private buildRuntime(options: {
    activeToolNames?: string[];
    flagValues?: Map<string, boolean | string>;
    includeAllExtensionTools?: boolean;
  }): void {
    const autoResizeImages = this.settingsManager.getImageAutoResize();
    const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
    const shellPath = this.settingsManager.getShellPath();
    const baseToolDefinitions = this.baseToolsOverride
      ? Object.fromEntries(
          Object.entries(this.baseToolsOverride).map(([name, tool]) => [
            name,
            createToolDefinitionFromAgentTool(tool),
          ]),
        )
      : createAllToolDefinitions(this.cwd, {
          read: { autoResizeImages },
          bash: { commandPrefix: shellCommandPrefix, shellPath },
        });

    this.baseToolDefinitions = new Map(
      Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
    );

    const extensionsResult = this.sessionResourceLoader.getExtensions();
    if (options.flagValues) {
      for (const [name, value] of options.flagValues) {
        extensionsResult.runtime.flagValues.set(name, value);
      }
    }

    this.currentExtensionRunner = new ExtensionRunner(
      extensionsResult.extensions,
      extensionsResult.runtime,
      this.cwd,
      this.sessionManager,
      this.sessionModelRegistry,
    );
    if (this.extensionRunnerRef) {
      this.extensionRunnerRef.current = this.currentExtensionRunner;
    }
    this.bindExtensionCore(this.currentExtensionRunner);
    this.applyExtensionBindings(this.currentExtensionRunner);

    const defaultActiveToolNames = this.baseToolsOverride
      ? Object.keys(this.baseToolsOverride)
      : ["read", "bash", "edit", "write"];
    const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
    this.refreshToolRegistry({
      activeToolNames: baseActiveToolNames,
      includeAllExtensionTools: options.includeAllExtensionTools,
    });
  }

  async reload(): Promise<void> {
    const previousFlagValues = this.currentExtensionRunner.getFlagValues();
    await emitSessionShutdownEvent(this.currentExtensionRunner, {
      type: "session_shutdown",
      reason: "reload",
    });
    await this.settingsManager.reload();
    resetApiProviders();
    await this.sessionResourceLoader.reload();
    this.buildRuntime({
      activeToolNames: this.getActiveToolNames(),
      flagValues: previousFlagValues,
      includeAllExtensionTools: true,
    });

    const hasBindings =
      this.extensionUIContext ||
      this.extensionCommandContextActions ||
      this.extensionShutdownHandler ||
      this.extensionErrorListener;
    if (hasBindings) {
      await this.currentExtensionRunner.emit({ type: "session_start", reason: "reload" });
      await this.extendResourcesFromExtensions("reload");
    }
  }

  // =========================================================================
  // Auto-Retry
  // =========================================================================

  /**
   * Check if an error is retryable (overloaded, rate limit, server errors).
   * Context overflow errors are NOT retryable (handled by compaction instead).
   */
  private isRetryableError(message: AssistantMessage): boolean {
    if (message.stopReason !== "error" || !message.errorMessage) {
      return false;
    }

    // Context overflow is handled by compaction, not retry
    const contextWindow = this.model?.contextWindow ?? 0;
    if (isContextOverflow(message, contextWindow)) {
      return false;
    }

    const err = message.errorMessage;
    // Match: overloaded_error, provider returned error, rate limit, 429, 500, 502, 503, 504, service unavailable, network/connection errors (including connection lost), WebSocket transport closes/errors, fetch failed, premature stream endings, HTTP/2 closed before response, terminated, retry delay exceeded
    return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i.test(
      err,
    );
  }

  /**
   * Prepare a retryable error for continuation with exponential backoff.
   * @returns true if the caller should continue the agent, false otherwise
   */
  private async prepareRetry(message: AssistantMessage): Promise<boolean> {
    const settings = this.settingsManager.getRetrySettings();
    if (!settings.enabled) {
      return false;
    }

    this.retryCount++;

    if (this.retryCount > settings.maxRetries) {
      // Preserve the completed attempt count so post-run handling can emit the final failure.
      this.retryCount--;
      return false;
    }

    const delayMs = settings.baseDelayMs * 2 ** (this.retryCount - 1);

    this.emit({
      type: "auto_retry_start",
      attempt: this.retryCount,
      maxAttempts: settings.maxRetries,
      delayMs,
      errorMessage: message.errorMessage || "Unknown error",
    });

    // Remove error message from agent state (keep in session for history)
    const messages = this.agent.state.messages;
    if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
      this.agent.state.messages = messages.slice(0, -1);
    }

    // Wait with exponential backoff (abortable)
    this.retryAbortController = new AbortController();
    try {
      await sleep(delayMs, this.retryAbortController.signal);
    } catch {
      // Aborted during sleep - emit end event so UI can clean up
      const attempt = this.retryCount;
      this.retryCount = 0;
      this.emit({
        type: "auto_retry_end",
        success: false,
        attempt,
        finalError: "Retry cancelled",
      });
      return false;
    } finally {
      this.retryAbortController = undefined;
    }

    return true;
  }

  /**
   * Cancel in-progress retry.
   */
  abortRetry(): void {
    this.retryAbortController?.abort();
  }

  /** Whether auto-retry is currently in progress */
  get isRetrying(): boolean {
    return this.retryAbortController !== undefined;
  }

  /** Whether auto-retry is enabled */
  get autoRetryEnabled(): boolean {
    return this.settingsManager.getRetryEnabled();
  }

  /**
   * Toggle auto-retry setting.
   */
  setAutoRetryEnabled(enabled: boolean): void {
    this.settingsManager.setRetryEnabled(enabled);
  }

  // =========================================================================
  // Bash Execution
  // =========================================================================

  /**
   * Execute a bash command.
   * Adds result to agent context and session.
   * @param command The bash command to execute
   * @param onChunk Optional streaming callback for output
   * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
   * @param options.operations Custom BashOperations for remote execution
   */
  async executeBash(
    command: string,
    onChunk?: (chunk: string) => void,
    options?: { excludeFromContext?: boolean; operations?: BashOperations },
  ): Promise<BashResult> {
    this.bashAbortController = new AbortController();

    // Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
    const prefix = this.settingsManager.getShellCommandPrefix();
    const shellPath = this.settingsManager.getShellPath();
    const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

    try {
      const result = await executeBashWithOperations(
        resolvedCommand,
        this.sessionManager.getCwd(),
        options?.operations ?? createLocalBashOperations({ shellPath }),
        {
          onChunk,
          signal: this.bashAbortController.signal,
        },
      );

      this.recordBashResult(command, result, options);
      return result;
    } finally {
      this.bashAbortController = undefined;
    }
  }

  /**
   * Record a bash execution result in session history.
   * Used by executeBash and by extensions that handle bash execution themselves.
   */
  recordBashResult(
    command: string,
    result: BashResult,
    options?: { excludeFromContext?: boolean },
  ): void {
    const bashMessage: BashExecutionMessage = {
      role: "bashExecution",
      command,
      output: result.output,
      exitCode: result.exitCode,
      cancelled: result.cancelled,
      truncated: result.truncated,
      fullOutputPath: result.fullOutputPath,
      timestamp: Date.now(),
      excludeFromContext: options?.excludeFromContext,
    };

    // If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
    if (this.isStreaming) {
      // Queue for later - will be flushed on agent_end
      this.pendingBashMessages.push(bashMessage);
    } else {
      // Add to agent state immediately
      this.agent.state.messages.push(bashMessage);

      // Save to session
      this.sessionManager.appendMessage(bashMessage);
    }
  }

  /**
   * Cancel running bash command.
   */
  abortBash(): void {
    this.bashAbortController?.abort();
  }

  /** Whether a bash command is currently running */
  get isBashRunning(): boolean {
    return this.bashAbortController !== undefined;
  }

  /** Whether there are pending bash messages waiting to be flushed */
  get hasPendingBashMessages(): boolean {
    return this.pendingBashMessages.length > 0;
  }

  /**
   * Flush pending bash messages to agent state and session.
   * Called after agent turn completes to maintain proper message ordering.
   */
  private flushPendingBashMessages(): void {
    if (this.pendingBashMessages.length === 0) {
      return;
    }

    for (const bashMessage of this.pendingBashMessages) {
      // Add to agent state
      this.agent.state.messages.push(bashMessage);

      // Save to session
      this.sessionManager.appendMessage(bashMessage);
    }

    this.pendingBashMessages = [];
  }

  // =========================================================================
  // Session Management
  // =========================================================================

  /**
   * Set a display name for the current session.
   */
  setSessionName(name: string): void {
    this.sessionManager.appendSessionInfo(name);
    this.emit({ type: "session_info_changed", name: this.sessionManager.getSessionName() });
  }

  // =========================================================================
  // Tree Navigation
  // =========================================================================

  /**
   * Navigate to a different node in the session tree.
   * Unlike fork() which creates a new session file, this stays in the same file.
   *
   * @param targetId The entry ID to navigate to
   * @param options.summarize Whether user wants to summarize abandoned branch
   * @param options.customInstructions Custom instructions for summarizer
   * @param options.replaceInstructions If true, customInstructions replaces the default prompt
   * @param options.label Label to attach to the branch summary entry
   * @returns Result with editorText (if user message) and cancelled status
   */
  async navigateTree(
    targetId: string,
    options: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    } = {},
  ): Promise<{
    editorText?: string;
    cancelled: boolean;
    aborted?: boolean;
    summaryEntry?: BranchSummaryEntry;
  }> {
    const oldLeafId = this.sessionManager.getLeafId();

    // No-op if already at target
    if (targetId === oldLeafId) {
      return { cancelled: false };
    }

    // Model required for summarization
    if (options.summarize && !this.model) {
      throw new Error("No model available for summarization");
    }

    const targetEntry = this.sessionManager.getEntry(targetId);
    if (!targetEntry) {
      throw new Error(`Entry ${targetId} not found`);
    }

    // Collect entries to summarize (from old leaf to common ancestor)
    const { entries: entriesToSummarize, commonAncestorId } = oldLeafId
      ? collectEntriesForBranchSummaryFromBranches(
          this.sessionManager.getBranch(oldLeafId),
          this.sessionManager.getBranch(targetId),
        )
      : { entries: [], commonAncestorId: null };

    // Prepare event data - mutable so extensions can override
    let customInstructions = options.customInstructions;
    let replaceInstructions = options.replaceInstructions;
    let label = options.label;

    const preparation: TreePreparation = {
      targetId,
      oldLeafId,
      commonAncestorId,
      entriesToSummarize,
      userWantsSummary: options.summarize ?? false,
      customInstructions,
      replaceInstructions,
      label,
    };

    // Set up abort controller for summarization
    this.branchSummaryAbortController = new AbortController();

    try {
      let extensionSummary: { summary: string; details?: unknown } | undefined;
      let fromExtension = false;

      // Emit session_before_tree event
      if (this.currentExtensionRunner.hasHandlers("session_before_tree")) {
        const result = await this.currentExtensionRunner.emit({
          type: "session_before_tree",
          preparation,
          signal: this.branchSummaryAbortController.signal,
        });

        if (result?.cancel) {
          return { cancelled: true };
        }

        if (result?.summary && options.summarize) {
          extensionSummary = result.summary;
          fromExtension = true;
        }

        // Allow extensions to override instructions and label
        if (result?.customInstructions !== undefined) {
          customInstructions = result.customInstructions;
        }
        if (result?.replaceInstructions !== undefined) {
          replaceInstructions = result.replaceInstructions;
        }
        if (result?.label !== undefined) {
          label = result.label;
        }
      }

      // Run default summarizer if needed
      let summaryText: string | undefined;
      let summaryDetails: unknown;
      if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
        const model = this.model!;
        const { apiKey, headers } = await this.getRequiredRequestAuth(model);
        const branchSummarySettings = this.settingsManager.getBranchSummarySettings();
        const result = normalizeBranchSummaryResult(
          await generateBranchSummary(entriesToSummarize, {
            model,
            apiKey,
            headers,
            signal: this.branchSummaryAbortController.signal,
            customInstructions,
            replaceInstructions,
            reserveTokens: branchSummarySettings.reserveTokens,
            streamFn: this.agent.streamFn,
          }),
        );
        if (result.aborted) {
          return { cancelled: true, aborted: true };
        }
        if (result.error) {
          throw new Error(result.error);
        }
        summaryText = result.summary;
        summaryDetails = {
          readFiles: result.readFiles || [],
          modifiedFiles: result.modifiedFiles || [],
        };
      } else if (extensionSummary) {
        summaryText = extensionSummary.summary;
        summaryDetails = extensionSummary.details;
      }

      // Determine the new leaf position based on target type
      let newLeafId: string | null;
      let editorText: string | undefined;

      if (targetEntry.type === "message" && targetEntry.message.role === "user") {
        // User message: leaf = parent (null if root), text goes to editor
        newLeafId = targetEntry.parentId;
        editorText = this.extractUserMessageText(targetEntry.message.content);
      } else if (targetEntry.type === "custom_message") {
        // Custom message: leaf = parent (null if root), text goes to editor
        newLeafId = targetEntry.parentId;
        editorText =
          typeof targetEntry.content === "string"
            ? targetEntry.content
            : targetEntry.content
                .filter((c): c is { type: "text"; text: string } => c.type === "text")
                .map((c) => c.text)
                .join("");
      } else {
        // Non-user message: leaf = selected node
        newLeafId = targetId;
      }

      // Switch leaf (with or without summary)
      // Summary is attached at the navigation target position (newLeafId), not the old branch
      let summaryEntry: BranchSummaryEntry | undefined;
      if (summaryText) {
        // Create summary at target position (can be null for root)
        const summaryId = this.sessionManager.branchWithSummary(
          newLeafId,
          summaryText,
          summaryDetails,
          fromExtension,
        );
        summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

        // Attach label to the summary entry
        if (label) {
          this.sessionManager.appendLabelChange(summaryId, label);
        }
      } else if (newLeafId === null) {
        // No summary, navigating to root - reset leaf
        this.sessionManager.resetLeaf();
      } else {
        // No summary, navigating to non-root
        this.sessionManager.branch(newLeafId);
      }

      // Attach label to target entry when not summarizing (no summary entry to label)
      if (label && !summaryText) {
        this.sessionManager.appendLabelChange(targetId, label);
      }

      // Update agent state
      const sessionContext = this.sessionManager.buildSessionContext();
      this.agent.state.messages = sessionContext.messages;

      // Emit session_tree event
      await this.currentExtensionRunner.emit({
        type: "session_tree",
        newLeafId: this.sessionManager.getLeafId(),
        oldLeafId,
        summaryEntry,
        fromExtension: summaryText ? fromExtension : undefined,
      });

      // Emit to custom tools

      return { editorText, cancelled: false, summaryEntry };
    } finally {
      this.branchSummaryAbortController = undefined;
    }
  }

  /**
   * Get all user messages from session for fork selector.
   */
  getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
    const entries = this.sessionManager.getEntries();
    const result: Array<{ entryId: string; text: string }> = [];

    for (const entry of entries) {
      if (entry.type !== "message") {
        continue;
      }
      if (entry.message.role !== "user") {
        continue;
      }

      const text = this.extractUserMessageText(entry.message.content);
      if (text) {
        result.push({ entryId: entry.id, text });
      }
    }

    return result;
  }

  private extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      return content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("");
    }
    return "";
  }

  /**
   * Get session statistics.
   */
  getSessionStats(): SessionStats {
    const state = this.state;
    const userMessages = state.messages.filter((m) => m.role === "user").length;
    const assistantMessages = state.messages.filter((m) => m.role === "assistant").length;
    const toolResults = state.messages.filter((m) => m.role === "toolResult").length;

    let toolCalls = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalCost = 0;

    for (const message of state.messages) {
      if (message.role === "assistant") {
        const assistantMsg = message;
        toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
        totalInput += assistantMsg.usage.input;
        totalOutput += assistantMsg.usage.output;
        totalCacheRead += assistantMsg.usage.cacheRead;
        totalCacheWrite += assistantMsg.usage.cacheWrite;
        totalCost += assistantMsg.usage.cost.total;
      }
    }

    return {
      sessionFile: this.sessionFile,
      sessionId: this.sessionId,
      userMessages,
      assistantMessages,
      toolCalls,
      toolResults,
      totalMessages: state.messages.length,
      tokens: {
        input: totalInput,
        output: totalOutput,
        cacheRead: totalCacheRead,
        cacheWrite: totalCacheWrite,
        total: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
      },
      cost: totalCost,
      contextUsage: this.getContextUsage(),
    };
  }

  getContextUsage(): ContextUsage | undefined {
    const model = this.model;
    if (!model) {
      return undefined;
    }

    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) {
      return undefined;
    }

    // After compaction, the last assistant usage reflects pre-compaction context size.
    // We can only trust usage from an assistant that responded after the latest compaction.
    // If no such assistant exists, context token count is unknown until the next LLM response.
    const branchEntries = this.sessionManager.getBranch();
    const latestCompaction = getLatestCompactionEntry(branchEntries);

    if (latestCompaction) {
      // Check if there's a valid assistant usage after the compaction boundary
      const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
      let hasPostCompactionUsage = false;
      for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
        const entry = branchEntries[i];
        if (entry.type === "message" && entry.message.role === "assistant") {
          const assistant = entry.message;
          if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
            const contextTokens = calculateContextTokens(assistant.usage);
            if (contextTokens > 0) {
              hasPostCompactionUsage = true;
            }
            break;
          }
        }
      }

      if (!hasPostCompactionUsage) {
        return { tokens: null, contextWindow, percent: null };
      }
    }

    const estimate = estimateContextTokens(this.messages);
    const percent = (estimate.tokens / contextWindow) * 100;

    return {
      tokens: estimate.tokens,
      contextWindow,
      percent,
    };
  }

  /**
   * @deprecated Use the OpenClaw session export command instead.
   * @param outputPath Optional output path (defaults to session directory)
   * @returns Path to exported file
   */
  async exportToHtml(_outputPath?: string): Promise<string> {
    throw new Error(
      "AgentSession.exportToHtml is deprecated; use the OpenClaw session export command.",
    );
  }

  /**
   * Export the current session branch to a JSONL file.
   * Writes the session header followed by all entries on the current branch path.
   * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
   * @returns The resolved output file path.
   */
  exportToJsonl(outputPath?: string): string {
    const filePath = resolve(
      outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
    );
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const header: SessionHeader = {
      type: "session",
      version: CURRENT_SESSION_VERSION,
      id: this.sessionManager.getSessionId(),
      timestamp: new Date().toISOString(),
      cwd: this.sessionManager.getCwd(),
    };

    const branchEntries = this.sessionManager.getBranch();
    const lines = [JSON.stringify(header)];

    // Re-chain parentIds to form a linear sequence
    let prevId: string | null = null;
    for (const entry of branchEntries) {
      const linear = { ...entry, parentId: prevId };
      lines.push(JSON.stringify(linear));
      prevId = entry.id;
    }

    writeFileSync(filePath, `${lines.join("\n")}\n`);
    return filePath;
  }

  // =========================================================================
  // Utilities
  // =========================================================================

  /**
   * Get text content of last assistant message.
   * Useful for /copy command.
   * @returns Text content, or undefined if no assistant message exists
   */
  getLastAssistantText(): string | undefined {
    const lastAssistant = this.messages
      .slice()
      .toReversed()
      .find((m) => {
        if (m.role !== "assistant") {
          return false;
        }
        const msg = m;
        // Skip aborted messages with no content
        if (msg.stopReason === "aborted" && msg.content.length === 0) {
          return false;
        }
        return true;
      });

    if (!lastAssistant) {
      return undefined;
    }

    let text = "";
    for (const content of (lastAssistant as AssistantMessage).content) {
      if (content.type === "text") {
        text += content.text;
      }
    }

    return text.trim() || undefined;
  }

  // =========================================================================
  // Extension System
  // =========================================================================

  createReplacedSessionContext(): ReplacedSessionContext {
    const context = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(this.currentExtensionRunner.createCommandContext()),
    ) as ReplacedSessionContext;
    context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
    context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
    return context;
  }

  /**
   * Check if extensions have handlers for a specific event type.
   */
  hasExtensionHandlers(eventType: string): boolean {
    return this.currentExtensionRunner.hasHandlers(eventType);
  }

  /**
   * Get the extension runner (for setting UI context and error handlers).
   */
  get extensionRunner(): ExtensionRunner {
    return this.currentExtensionRunner;
  }
}
