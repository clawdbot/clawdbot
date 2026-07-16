/**
 * Extension system types.
 *
 * Extensions are TypeScript modules that can:
 * - Subscribe to agent lifecycle events
 * - Register LLM-callable tools
 * - Register commands, keyboard shortcuts, and CLI flags
 * - Interact with the user via UI primitives
 */

import type {
  AutocompleteItem,
  AutocompleteProvider,
  Component,
  EditorComponent,
  EditorTheme,
  KeyId,
  OverlayHandle,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import type {
  Api,
  AssistantMessageEvent,
  AssistantMessageEventStreamContract,
  Context,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TextContent,
  ToolResultMessage,
} from "openclaw/plugin-sdk/llm";
import type { Static, TSchema } from "typebox";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type {
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  ThinkingLevel,
  ToolExecutionMode,
} from "../../runtime/index.js";
import type { BashResult } from "../bash-executor.js";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.js";
import type { EventBus } from "../event-bus.js";
import type { ExecOptions, ExecResult } from "../exec.js";
import type { ReadonlyFooterDataProvider } from "../footer-data-provider.js";
import type { KeybindingsManager } from "../keybindings.js";
import type { CustomMessage } from "../messages.js";
import type { ModelRegistry } from "../model-registry.js";
import type {
  BranchSummaryEntry,
  CompactionEntry,
  ReadonlySessionManager,
  SessionEntry,
  SessionManager,
} from "../session-manager.js";
import type { SlashCommandInfo } from "../slash-commands.js";
import type { SourceInfo } from "../source-info.js";
import type { BuildSystemPromptOptions } from "../system-prompt.js";
import type { BashOperations } from "../tools/bash-operations.js";
import type {
  BashToolDetails,
  BashToolInput,
  EditToolDetails,
  EditToolInput,
  FindToolDetails,
  FindToolInput,
  GrepToolDetails,
  GrepToolInput,
  LsToolDetails,
  LsToolInput,
  ReadToolDetails,
  ReadToolInput,
  WriteToolInput,
} from "../tools/tool-contracts.js";

export type { ExecOptions, ExecResult } from "../exec.js";
export type { BuildSystemPromptOptions } from "../system-prompt.js";
export type { AgentToolResult, AgentToolUpdateCallback, ToolExecutionMode };
export type { AppKeybinding, KeybindingsManager } from "../keybindings.js";

export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;
  [key: string]: unknown;
};

export type OAuthPrompt = {
  message: string;
  placeholder?: string;
  allowEmpty?: boolean;
};

export type OAuthAuthInfo = {
  url: string;
  instructions?: string;
};

export type OAuthSelectOption = {
  id: string;
  label: string;
};

export type OAuthSelectPrompt = {
  message: string;
  options: OAuthSelectOption[];
};

export interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  /** Show an interactive selector and return the selected option id, or undefined on cancel. */
  onSelect?: (prompt: OAuthSelectPrompt) => Promise<string | undefined>;
  signal?: AbortSignal;
}

// ============================================================================
// UI Context
// ============================================================================

/** Options for extension UI dialogs. */
export interface ExtensionUIDialogOptions {
  /** AbortSignal to programmatically dismiss the dialog. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. Dialog auto-dismisses with live countdown display. */
  timeout?: number;
}

/** Placement for extension widgets. */
export type WidgetPlacement = "aboveEditor" | "belowEditor";

/** Options for extension widgets. */
export interface ExtensionWidgetOptions {
  /** Where the widget is rendered. Defaults to "aboveEditor". */
  placement?: WidgetPlacement;
}

/** Raw terminal input listener for extensions. */
export type TerminalInputHandler = (
  data: string,
) => { consume?: boolean; data?: string } | undefined;

/** Working indicator configuration for the interactive streaming loader. */
export interface WorkingIndicatorOptions {
  /** Animation frames. Use an empty array to hide the indicator entirely. Custom frames are rendered verbatim. */
  frames?: string[];
  /** Frame interval in milliseconds for animated indicators. */
  intervalMs?: number;
}

/** Wrap the current autocomplete provider with additional behavior. */
export type AutocompleteProviderFactory = (current: AutocompleteProvider) => AutocompleteProvider;
export type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

/**
 * UI context for extensions to request interactive UI.
 * Each mode (interactive, RPC, print) provides its own implementation.
 */
export interface ExtensionUIContext {
  /** Show a selector and return the user's choice. */
  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;

  /** Show a confirmation dialog. */
  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;

  /** Show a text input dialog. */
  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;

  /** Show a notification to the user. */
  notify(message: string, type?: "info" | "warning" | "error"): void;

  /** Listen to raw terminal input (interactive mode only). Returns an unsubscribe function. */
  onTerminalInput(handler: TerminalInputHandler): () => void;

  /** Set status text in the footer/status bar. Pass undefined to clear. */
  setStatus(key: string, text: string | undefined): void;

  /** Set the working/loading message shown during streaming. Call with no argument to restore default. */
  setWorkingMessage(message?: string): void;

  /** Show or hide the built-in interactive working loader row during streaming. */
  setWorkingVisible(visible: boolean): void;

  /**
   * Configure the interactive working indicator shown during streaming.
   *
   * - Omit the argument to restore the default animated spinner.
   * - Use `frames: ["●"]` for a static indicator.
   * - Use `frames: []` to hide the indicator entirely.
   * - Custom frames are rendered as provided, so extensions must add their own colors.
   */
  setWorkingIndicator(options?: WorkingIndicatorOptions): void;

  /** Set the label shown for hidden thinking blocks. Call with no argument to restore default. */
  setHiddenThinkingLabel(label?: string): void;

  /** Set a widget to display above or below the editor. Accepts string array or component factory. */
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setWidget(
    key: string,
    content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
    options?: ExtensionWidgetOptions,
  ): void;

  /** Set a custom footer component, or undefined to restore the built-in footer.
   *
   * The factory receives a FooterDataProvider for data not otherwise accessible:
   * git branch and extension statuses from setStatus(). Token stats, model info,
   * etc. are available via ctx.sessionManager and ctx.model.
   */
  setFooter(
    factory:
      | ((
          tui: TUI,
          theme: Theme,
          footerData: ReadonlyFooterDataProvider,
        ) => Component & { dispose?(): void })
      | undefined,
  ): void;

  /** Set a custom header component (shown at startup, above chat), or undefined to restore the built-in header. */
  setHeader(
    factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
  ): void;

  /** Set the terminal window/tab title. */
  setTitle(title: string): void;

  /** Show a custom component with keyboard focus. */
  custom<T>(
    factory: (
      tui: TUI,
      theme: Theme,
      keybindings: KeybindingsManager,
      done: (result: T) => void,
    ) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
    options?: {
      overlay?: boolean;
      /** Overlay positioning/sizing options. Can be static or a function for dynamic updates. */
      overlayOptions?: OverlayOptions | (() => OverlayOptions);
      /** Called with the overlay handle after the overlay is shown. Use to control visibility. */
      onHandle?: (handle: OverlayHandle) => void;
    },
  ): Promise<T>;

  /** Paste text into the editor, triggering paste handling (collapse for large content). */
  pasteToEditor(text: string): void;

  /** Set the text in the core input editor. */
  setEditorText(text: string): void;

  /** Get the current text from the core input editor. */
  getEditorText(): string;

  /** Show a multi-line editor for text editing. */
  editor(title: string, prefill?: string): Promise<string | undefined>;

  /** Stack additional autocomplete behavior on top of the built-in provider. */
  addAutocompleteProvider(factory: AutocompleteProviderFactory): void;

  /**
   * Set a custom editor component via factory function.
   * Pass undefined to restore the default editor.
   *
   * The factory receives:
   * - `theme`: EditorTheme for styling borders and autocomplete
   * - `keybindings`: KeybindingsManager for app-level keybindings
   *
   * For full app keybinding support (escape, ctrl+d, model switching, etc.),
   * extend `CustomEditor` from `openclaw/plugin-sdk/agent-sessions` and call
   * `super.handleInput(data)` for keys you don't handle.
   *
   * @example
   * ```ts
   * import { CustomEditor } from "openclaw/plugin-sdk/agent-sessions";
   *
   * class VimEditor extends CustomEditor {
   *   private mode: "normal" | "insert" = "insert";
   *
   *   handleInput(data: string): void {
   *     if (this.mode === "normal") {
   *       // Handle vim normal mode keys...
   *       if (data === "i") { this.mode = "insert"; return; }
   *     }
   *     super.handleInput(data);  // App keybindings + text editing
   *   }
   * }
   *
   * ctx.ui.setEditorComponent((tui, theme, keybindings) =>
   *   new VimEditor(tui, theme, keybindings)
   * );
   * ```
   */
  setEditorComponent(factory: EditorFactory | undefined): void;

  /** Get the currently configured custom editor factory, or undefined when using the default editor. */
  getEditorComponent(): EditorFactory | undefined;

  /** Get the current theme for styling. */
  readonly theme: Theme;

  /** Get all available themes with their names and file paths. */
  getAllThemes(): { name: string; path: string | undefined }[];

  /** Load a theme by name without switching to it. Returns undefined if not found. */
  getTheme(name: string): Theme | undefined;

  /** Set the current theme by name or Theme object. */
  setTheme(theme: string | Theme): { success: boolean; error?: string };

  /** Get current tool output expansion state. */
  getToolsExpanded(): boolean;

  /** Set tool output expansion state. */
  setToolsExpanded(expanded: boolean): void;
}

// ============================================================================
// Extension Context
// ============================================================================

export interface ContextUsage {
  /** Estimated context tokens, or null if any (e.g. right after compaction, before next LLM response). */
  tokens: number | null;
  contextWindow: number;
  /** Context usage as percentage of context window, or null if tokens is unknown. */
  percent: number | null;
}

export interface CompactOptions {
  customInstructions?: string;
  onComplete?: (result: CompactionResult) => void;
  onError?: (error: Error) => void;
}

/**
 * Context passed to extension event handlers.
 */
export interface ExtensionContext {
  /** UI methods for user interaction */
  ui: ExtensionUIContext;
  /** Whether UI is available (false in print/RPC mode) */
  hasUI: boolean;
  /** Current working directory */
  cwd: string;
  /** Session manager (read-only) */
  sessionManager: ReadonlySessionManager;
  /** Model registry for API key resolution */
  modelRegistry: ModelRegistry;
  /** Current model (may be undefined) */
  model: Model | undefined;
  /** Whether the agent is idle (not streaming) */
  isIdle(): boolean;
  /** The current abort signal, or undefined when the agent is not streaming. */
  signal: AbortSignal | undefined;
  /** Abort the current agent operation */
  abort(): void;
  /** Whether there are queued messages waiting */
  hasPendingMessages(): boolean;
  /** Gracefully shut down OpenClaw and exit. Available in all contexts. */
  shutdown(): void;
  /** Get current context usage for the active model. */
  getContextUsage(): ContextUsage | undefined;
  /** Trigger compaction without awaiting completion. */
  compact(options?: CompactOptions): void;
  /** Get the current effective system prompt. */
  getSystemPrompt(): string;
}

/**
 * Extended context for command handlers.
 * Includes session control methods only safe in user-initiated commands.
 */
export interface ExtensionCommandContext extends ExtensionContext {
  /** Wait for the agent to finish streaming */
  waitForIdle(): Promise<void>;

  /** Start a new session, optionally with initialization. */
  newSession(options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  }): Promise<{ cancelled: boolean }>;

  /** Fork from a specific entry, creating a new session file. */
  fork(
    entryId: string,
    options?: {
      position?: "before" | "at";
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean }>;

  /** Navigate to a different point in the session tree. */
  navigateTree(
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ): Promise<{ cancelled: boolean }>;

  /** Switch to a different session file. */
  switchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }>;

  /** Reload extensions, skills, prompts, and themes. */
  reload(): Promise<void>;
}

/**
 * Fresh command-capable context bound to the replacement session after a session switch.
 *
 * This is passed to `withSession()` callbacks on `newSession()`, `fork()`, and `switchSession()`.
 */
export interface ReplacedSessionContext extends ExtensionCommandContext {
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): Promise<void>;

  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void>;
}

// ============================================================================
// Tool Types
// ============================================================================

/** Rendering options for tool results */
export interface ToolRenderResultOptions {
  /** Whether the result view is expanded */
  expanded: boolean;
  /** Whether this is a partial/streaming result */
  isPartial: boolean;
}

/** Context passed to tool renderers. */
export interface ToolRenderContext<TState = unknown, TArgs = unknown> {
  /** Current tool call arguments. Shared across call/result renders for the same tool call. */
  args: TArgs;
  /** Unique id for this tool execution. Stable across call/result renders for the same tool call. */
  toolCallId: string;
  /** Invalidate just this tool execution component for redraw. */
  invalidate: () => void;
  /** Previously returned component for this render slot, if any. */
  lastComponent: Component | undefined;
  /** Shared renderer state for this tool row. Initialized by tool-execution.ts. */
  state: TState;
  /** Working directory for this tool execution. */
  cwd: string;
  /** Whether the tool execution has started. */
  executionStarted: boolean;
  /** Whether the tool call arguments are complete. */
  argsComplete: boolean;
  /** Whether the tool result is partial/streaming. */
  isPartial: boolean;
  /** Whether the result view is expanded. */
  expanded: boolean;
  /** Whether inline images are currently shown in the TUI. */
  showImages: boolean;
  /** Whether the current result is an error. */
  isError: boolean;
}

type BivariantCallback<TArgs extends unknown[], TResult> = {
  bivarianceHack(...args: TArgs): TResult;
}["bivarianceHack"];

/**
 * Tool definition for registerTool().
 */
export interface ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = unknown,
> {
  /** Tool name (used in LLM tool calls) */
  name: string;
  /** Human-readable label for UI */
  label: string;
  /** Preserve lifecycle telemetry without rendering transient channel progress. */
  hideFromChannelProgress?: boolean;
  /** Description for LLM */
  description: string;
  /** Optional one-line snippet for the Available tools section in the default system prompt. Custom tools are omitted from that section when this is not provided. */
  promptSnippet?: string;
  /** Optional guideline bullets appended to the default system prompt Guidelines section when this tool is active. */
  promptGuidelines?: string[];
  /** Parameter schema (TypeBox) */
  parameters: TParams;
  /** Controls whether ToolExecutionComponent renders the standard colored shell or the tool renders its own framing. */
  renderShell?: "default" | "self";

  /** Optional compatibility shim to prepare raw tool call arguments before schema validation. Must return an object conforming to TParams. */
  prepareArguments?: (args: unknown) => Static<TParams>;

  /**
   * Per-tool execution mode override.
   * - "sequential": this tool must execute one at a time with other tool calls.
   * - "parallel": this tool can execute concurrently with other tool calls.
   *
   * If omitted, the default execution mode applies.
   */
  executionMode?: ToolExecutionMode;

  /** Execute the tool. */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;

  /** Custom rendering for tool call display */
  renderCall?: BivariantCallback<
    [args: Static<TParams>, theme: Theme, context: ToolRenderContext<TState, Static<TParams>>],
    Component
  >;

  /** Custom rendering for tool result display */
  renderResult?: BivariantCallback<
    [
      result: AgentToolResult<TDetails>,
      options: ToolRenderResultOptions,
      theme: Theme,
      context: ToolRenderContext<TState, Static<TParams>>,
    ],
    Component
  >;
}

type AnyToolDefinition = ToolDefinition;

/**
 * Preserve parameter inference for standalone tool definitions.
 *
 * Use this when assigning a tool to a variable or passing it through arrays such
 * as `customTools`, where contextual typing would otherwise widen params to
 * `unknown`.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown, TState = unknown>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition {
  return tool as ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
}

// ============================================================================
// Resource Events
// ============================================================================

/** Fired after session_start to allow extensions to provide additional resource paths. */
export interface ResourcesDiscoverEvent {
  type: "resources_discover";
  cwd: string;
  reason: "startup" | "reload";
}

/** Result from resources_discover event handler */
export interface ResourcesDiscoverResult {
  skillPaths?: string[];
  promptPaths?: string[];
  themePaths?: string[];
}

// ============================================================================
// Session Events
// ============================================================================

/** Fired when a session is started, loaded, or reloaded */
export interface SessionStartEvent {
  type: "session_start";
  /** Why this session start happened. */
  reason: "startup" | "reload" | "new" | "resume" | "fork";
  /** Previously active session file. Present for "new", "resume", and "fork". */
  previousSessionFile?: string;
}

/** Fired before switching to another session (can be cancelled) */
export interface SessionBeforeSwitchEvent {
  type: "session_before_switch";
  reason: "new" | "resume";
  targetSessionFile?: string;
}

/** Fired before forking a session (can be cancelled) */
export interface SessionBeforeForkEvent {
  type: "session_before_fork";
  entryId: string;
  position: "before" | "at";
}

/** Fired before context compaction (can be cancelled or customized) */
export interface SessionBeforeCompactEvent {
  type: "session_before_compact";
  preparation: CompactionPreparation;
  branchEntries: SessionEntry[];
  customInstructions?: string;
  signal: AbortSignal;
}

/** Fired after context compaction */
export interface SessionCompactEvent {
  type: "session_compact";
  compactionEntry: CompactionEntry;
  fromExtension: boolean;
}

/** Fired before an extension runtime is torn down due to quit, reload, or session replacement. */
export interface SessionShutdownEvent {
  type: "session_shutdown";
  reason: "quit" | "reload" | "new" | "resume" | "fork";
  /** Destination session file when shutting down due to session replacement. */
  targetSessionFile?: string;
}

/** Preparation data for tree navigation */
export interface TreePreparation {
  targetId: string;
  oldLeafId: string | null;
  commonAncestorId: string | null;
  entriesToSummarize: SessionEntry[];
  userWantsSummary: boolean;
  /** Custom instructions for summarization */
  customInstructions?: string;
  /** If true, customInstructions replaces the default prompt instead of being appended */
  replaceInstructions?: boolean;
  /** Label to attach to the branch summary entry */
  label?: string;
}

/** Fired before navigating in the session tree (can be cancelled) */
export interface SessionBeforeTreeEvent {
  type: "session_before_tree";
  preparation: TreePreparation;
  signal: AbortSignal;
}

/** Fired after navigating in the session tree */
export interface SessionTreeEvent {
  type: "session_tree";
  newLeafId: string | null;
  oldLeafId: string | null;
  summaryEntry?: BranchSummaryEntry;
  fromExtension?: boolean;
}

export type SessionEvent =
  | SessionStartEvent
  | SessionBeforeSwitchEvent
  | SessionBeforeForkEvent
  | SessionBeforeCompactEvent
  | SessionCompactEvent
  | SessionShutdownEvent
  | SessionBeforeTreeEvent
  | SessionTreeEvent;

// ============================================================================
// Agent Events
// ============================================================================

/** Fired before each LLM call. Can modify messages. */
export interface ContextEvent {
  type: "context";
  messages: AgentMessage[];
}

/** Fired before a provider request is sent. Can replace the payload. */
export interface BeforeProviderRequestEvent {
  type: "before_provider_request";
  payload: unknown;
}

/** Fired after a provider response is received and before the response stream is consumed. */
export interface AfterProviderResponseEvent {
  type: "after_provider_response";
  status: number;
  headers: Record<string, string>;
}

/** Fired after user submits prompt but before agent loop. */
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  /** The raw user prompt text (after expansion). */
  prompt: string;
  /** Images attached to the user prompt, if any. */
  images?: ImageContent[];
  /** The fully assembled system prompt string. */
  systemPrompt: string;
  /** Structured options used to build the system prompt. Extensions can inspect this without re-discovering resources. */
  systemPromptOptions: BuildSystemPromptOptions;
}

/** Fired when an agent loop starts */
export interface AgentStartEvent {
  type: "agent_start";
}

/** Fired when an agent loop ends */
export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

/** Fired at the start of each turn */
export interface TurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}

/** Fired at the end of each turn */
export interface TurnEndEvent {
  type: "turn_end";
  turnIndex: number;
  message: AgentMessage;
  toolResults: ToolResultMessage[];
}

/** Fired when a message starts (user, assistant, or toolResult) */
export interface MessageStartEvent {
  type: "message_start";
  message: AgentMessage;
}

/** Fired during assistant message streaming with token-by-token updates */
export interface MessageUpdateEvent {
  type: "message_update";
  message: AgentMessage;
  assistantMessageEvent: AssistantMessageEvent;
}

/** Fired when a message ends */
export interface MessageEndEvent {
  type: "message_end";
  message: AgentMessage;
}

/** Fired when a tool starts executing */
export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}

/** Fired during tool execution with partial/streaming output */
export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  args: unknown;
  partialResult: unknown;
}

/** Fired when a tool finishes executing */
export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

// ============================================================================
// Model Events
// ============================================================================

export type ModelSelectSource = "set" | "cycle" | "restore";

/** Fired when a new model is selected */
export interface ModelSelectEvent {
  type: "model_select";
  model: Model;
  previousModel: Model | undefined;
  source: ModelSelectSource;
}

/** Fired when a new thinking level is selected */
export interface ThinkingLevelSelectEvent {
  type: "thinking_level_select";
  level: ThinkingLevel;
  previousLevel: ThinkingLevel;
}

// ============================================================================
// User Bash Events
// ============================================================================

/** Fired when user executes a bash command via ! or !! prefix */
export interface UserBashEvent {
  type: "user_bash";
  /** The command to execute */
  command: string;
  /** True if !! prefix was used (excluded from LLM context) */
  excludeFromContext: boolean;
  /** Current working directory */
  cwd: string;
}

// ============================================================================
// Input Events
// ============================================================================

/** Source of user input */
export type InputSource = "interactive" | "rpc" | "extension";

/** Fired when user input is received, before agent processing */
export interface InputEvent {
  type: "input";
  /** The input text */
  text: string;
  /** Attached images, if any */
  images?: ImageContent[];
  /** Where the input came from */
  source: InputSource;
}

/** Result from input event handler */
export type InputEventResult =
  | { action: "continue" }
  | { action: "transform"; text: string; images?: ImageContent[] }
  | { action: "handled" };

// ============================================================================
// Tool Events
// ============================================================================

interface ToolCallEventBase {
  type: "tool_call";
  toolCallId: string;
}

export interface BashToolCallEvent extends ToolCallEventBase {
  toolName: "bash";
  input: BashToolInput;
}

export interface ReadToolCallEvent extends ToolCallEventBase {
  toolName: "read";
  input: ReadToolInput;
}

export interface EditToolCallEvent extends ToolCallEventBase {
  toolName: "edit";
  input: EditToolInput;
}

export interface WriteToolCallEvent extends ToolCallEventBase {
  toolName: "write";
  input: WriteToolInput;
}

export interface GrepToolCallEvent extends ToolCallEventBase {
  toolName: "grep";
  input: GrepToolInput;
}

export interface FindToolCallEvent extends ToolCallEventBase {
  toolName: "find";
  input: FindToolInput;
}

export interface LsToolCallEvent extends ToolCallEventBase {
  toolName: "ls";
  input: LsToolInput;
}

export interface CustomToolCallEvent extends ToolCallEventBase {
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * Fired before a tool executes. Can block.
 *
 * `event.input` is mutable. Mutate it in place to patch tool arguments before execution.
 * Later `tool_call` handlers see earlier mutations. No re-validation is performed after mutation.
 */
export type ToolCallEvent =
  | BashToolCallEvent
  | ReadToolCallEvent
  | EditToolCallEvent
  | WriteToolCallEvent
  | GrepToolCallEvent
  | FindToolCallEvent
  | LsToolCallEvent
  | CustomToolCallEvent;

interface ToolResultEventBase {
  type: "tool_result";
  toolCallId: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  isError: boolean;
}

export interface BashToolResultEvent extends ToolResultEventBase {
  toolName: "bash";
  details: BashToolDetails | undefined;
}

export interface ReadToolResultEvent extends ToolResultEventBase {
  toolName: "read";
  details: ReadToolDetails | undefined;
}

export interface EditToolResultEvent extends ToolResultEventBase {
  toolName: "edit";
  details: EditToolDetails | undefined;
}

export interface WriteToolResultEvent extends ToolResultEventBase {
  toolName: "write";
  details: undefined;
}

export interface GrepToolResultEvent extends ToolResultEventBase {
  toolName: "grep";
  details: GrepToolDetails | undefined;
}

export interface FindToolResultEvent extends ToolResultEventBase {
  toolName: "find";
  details: FindToolDetails | undefined;
}

export interface LsToolResultEvent extends ToolResultEventBase {
  toolName: "ls";
  details: LsToolDetails | undefined;
}

export interface CustomToolResultEvent extends ToolResultEventBase {
  toolName: string;
  details: unknown;
}

/** Fired after a tool executes. Can modify result. */
export type ToolResultEvent =
  | BashToolResultEvent
  | ReadToolResultEvent
  | EditToolResultEvent
  | WriteToolResultEvent
  | GrepToolResultEvent
  | FindToolResultEvent
  | LsToolResultEvent
  | CustomToolResultEvent;

// Type guards for ToolResultEvent
export function isBashToolResult(e: ToolResultEvent): e is BashToolResultEvent {
  return e.toolName === "bash";
}
export function isReadToolResult(e: ToolResultEvent): e is ReadToolResultEvent {
  return e.toolName === "read";
}
export function isEditToolResult(e: ToolResultEvent): e is EditToolResultEvent {
  return e.toolName === "edit";
}
export function isWriteToolResult(e: ToolResultEvent): e is WriteToolResultEvent {
  return e.toolName === "write";
}
export function isGrepToolResult(e: ToolResultEvent): e is GrepToolResultEvent {
  return e.toolName === "grep";
}
export function isFindToolResult(e: ToolResultEvent): e is FindToolResultEvent {
  return e.toolName === "find";
}
export function isLsToolResult(e: ToolResultEvent): e is LsToolResultEvent {
  return e.toolName === "ls";
}

/**
 * Type guard for narrowing ToolCallEvent by tool name.
 *
 * Built-in tools narrow automatically (no type params needed):
 * ```ts
 * if (isToolCallEventType("bash", event)) {
 *   event.input.command;  // string
 * }
 * ```
 *
 * Custom tools require explicit type parameters:
 * ```ts
 * if (isToolCallEventType<"my_tool", MyToolInput>("my_tool", event)) {
 *   event.input.action;  // typed
 * }
 * ```
 *
 * Note: Direct narrowing via `event.toolName === "bash"` doesn't work because
 * CustomToolCallEvent.toolName is `string` which overlaps with all literals.
 */
export function isToolCallEventType(
  toolName: "bash",
  event: ToolCallEvent,
): event is BashToolCallEvent;
export function isToolCallEventType(
  toolName: "read",
  event: ToolCallEvent,
): event is ReadToolCallEvent;
export function isToolCallEventType(
  toolName: "edit",
  event: ToolCallEvent,
): event is EditToolCallEvent;
export function isToolCallEventType(
  toolName: "write",
  event: ToolCallEvent,
): event is WriteToolCallEvent;
export function isToolCallEventType(
  toolName: "grep",
  event: ToolCallEvent,
): event is GrepToolCallEvent;
export function isToolCallEventType(
  toolName: "find",
  event: ToolCallEvent,
): event is FindToolCallEvent;
export function isToolCallEventType(toolName: "ls", event: ToolCallEvent): event is LsToolCallEvent;
export function isToolCallEventType<TName extends string, TInput extends Record<string, unknown>>(
  toolName: TName,
  event: ToolCallEvent,
): event is ToolCallEvent & { toolName: TName; input: TInput };
export function isToolCallEventType(toolName: string, event: ToolCallEvent): boolean {
  return event.toolName === toolName;
}

/** Union of all event types */
export type ExtensionEvent =
  | ResourcesDiscoverEvent
  | SessionEvent
  | ContextEvent
  | BeforeProviderRequestEvent
  | AfterProviderResponseEvent
  | BeforeAgentStartEvent
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | ModelSelectEvent
  | ThinkingLevelSelectEvent
  | UserBashEvent
  | InputEvent
  | ToolCallEvent
  | ToolResultEvent;

// ============================================================================
// Event Results
// ============================================================================

export interface ContextEventResult {
  messages?: AgentMessage[];
}

export type BeforeProviderRequestEventResult = unknown;

export interface ToolCallEventResult {
  /** Block tool execution. To modify arguments, mutate `event.input` in place instead. */
  block?: boolean;
  reason?: string;
}

/** Result from user_bash event handler */
export interface UserBashEventResult {
  /** Custom operations to use for execution */
  operations?: BashOperations;
  /** Full replacement: extension handled execution, use this result */
  result?: BashResult;
}

export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

export interface MessageEndEventResult {
  /** Replace the finalized message. The replacement must keep the original message role. */
  message?: AgentMessage;
}

export interface BeforeAgentStartEventResult {
  message?: Pick<CustomMessage, "customType" | "content" | "display" | "details">;
  /** Replace the system prompt for this turn. If multiple extensions return this, they are chained. */
  systemPrompt?: string;
}

export interface SessionBeforeSwitchResult {
  cancel?: boolean;
}

export interface SessionBeforeForkResult {
  cancel?: boolean;
  skipConversationRestore?: boolean;
}

export interface SessionBeforeCompactResult {
  cancel?: boolean;
  compaction?: CompactionResult;
}

export interface SessionBeforeTreeResult {
  cancel?: boolean;
  summary?: {
    summary: string;
    details?: unknown;
  };
  /** Override custom instructions for summarization */
  customInstructions?: string;
  /** Override whether customInstructions replaces the default prompt */
  replaceInstructions?: boolean;
  /** Override label to attach to the branch summary entry */
  label?: string;
}

// ============================================================================
// Message Rendering
// ============================================================================

export interface MessageRenderOptions {
  expanded: boolean;
}

export type MessageRenderer<T = unknown> = (
  message: CustomMessage<T>,
  options: MessageRenderOptions,
  theme: Theme,
) => Component | undefined;

// ============================================================================
// Command Registration
// ============================================================================

export interface RegisteredCommand {
  name: string;
  sourceInfo: SourceInfo;
  description?: string;
  getArgumentCompletions?: (
    argumentPrefix: string,
  ) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

export interface ResolvedCommand extends RegisteredCommand {
  invocationName: string;
}

// ============================================================================
// Extension API
// ============================================================================

/** Handler function type for events */
// biome-ignore lint/suspicious/noConfusingVoidType: void allows bare return statements
export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

/**
 * ExtensionAPI passed to extension factory functions.
 */
export interface ExtensionAPI {
  // =========================================================================
  // Event Subscription
  // =========================================================================

  on(
    event: "resources_discover",
    handler: ExtensionHandler<ResourcesDiscoverEvent, ResourcesDiscoverResult>,
  ): void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(
    event: "session_before_switch",
    handler: ExtensionHandler<SessionBeforeSwitchEvent, SessionBeforeSwitchResult>,
  ): void;
  on(
    event: "session_before_fork",
    handler: ExtensionHandler<SessionBeforeForkEvent, SessionBeforeForkResult>,
  ): void;
  on(
    event: "session_before_compact",
    handler: ExtensionHandler<SessionBeforeCompactEvent, SessionBeforeCompactResult>,
  ): void;
  on(event: "session_compact", handler: ExtensionHandler<SessionCompactEvent>): void;
  on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): void;
  on(
    event: "session_before_tree",
    handler: ExtensionHandler<SessionBeforeTreeEvent, SessionBeforeTreeResult>,
  ): void;
  on(event: "session_tree", handler: ExtensionHandler<SessionTreeEvent>): void;
  on(event: "context", handler: ExtensionHandler<ContextEvent, ContextEventResult>): void;
  on(
    event: "before_provider_request",
    handler: ExtensionHandler<BeforeProviderRequestEvent, BeforeProviderRequestEventResult>,
  ): void;
  on(event: "after_provider_response", handler: ExtensionHandler<AfterProviderResponseEvent>): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>,
  ): void;
  on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): void;
  on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  on(event: "turn_end", handler: ExtensionHandler<TurnEndEvent>): void;
  on(event: "message_start", handler: ExtensionHandler<MessageStartEvent>): void;
  on(event: "message_update", handler: ExtensionHandler<MessageUpdateEvent>): void;
  on(event: "message_end", handler: ExtensionHandler<MessageEndEvent, MessageEndEventResult>): void;
  on(event: "tool_execution_start", handler: ExtensionHandler<ToolExecutionStartEvent>): void;
  on(event: "tool_execution_update", handler: ExtensionHandler<ToolExecutionUpdateEvent>): void;
  on(event: "tool_execution_end", handler: ExtensionHandler<ToolExecutionEndEvent>): void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
  on(event: "thinking_level_select", handler: ExtensionHandler<ThinkingLevelSelectEvent>): void;
  on(event: "tool_call", handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent, ToolResultEventResult>): void;
  on(event: "user_bash", handler: ExtensionHandler<UserBashEvent, UserBashEventResult>): void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;

  // =========================================================================
  // Tool Registration
  // =========================================================================

  /** Register a tool that the LLM can call. */
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void;

  // =========================================================================
  // Command, Shortcut, Flag Registration
  // =========================================================================

  /** Register a custom command. */
  registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;

  /** Register a keyboard shortcut. */
  registerShortcut(
    shortcut: KeyId,
    options: {
      description?: string;
      handler: (ctx: ExtensionContext) => Promise<void> | void;
    },
  ): void;

  /** Register a CLI flag. */
  registerFlag(
    name: string,
    options: {
      description?: string;
      type: "boolean" | "string";
      default?: boolean | string;
    },
  ): void;

  /** Get the value of a registered CLI flag. */
  getFlag(name: string): boolean | string | undefined;

  // =========================================================================
  // Message Rendering
  // =========================================================================

  /** Register a custom renderer for CustomMessageEntry. */
  registerMessageRenderer<T = unknown>(customType: string, renderer: MessageRenderer<T>): void;

  // =========================================================================
  // Actions
  // =========================================================================

  /** Send a custom message to the session. */
  sendMessage<T = unknown>(
    message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;

  /**
   * Send a user message to the agent. Always triggers a turn.
   * When the agent is streaming, use deliverAs to specify how to queue the message.
   */
  sendUserMessage(
    content: string | (TextContent | ImageContent)[],
    options?: { deliverAs?: "steer" | "followUp" },
  ): void;

  /** Append a custom entry to the session for state persistence (not sent to LLM). */
  appendEntry(customType: string, data?: unknown): void;

  // =========================================================================
  // Session Metadata
  // =========================================================================

  /** Set the session display name (shown in session selector). */
  setSessionName(name: string): void;

  /** Get the current session name, if set. */
  getSessionName(): string | undefined;

  /** Set or clear a label on an entry. Labels are user-defined markers for bookmarking/navigation. */
  setLabel(entryId: string, label: string | undefined): void;

  /** Execute a shell command. */
  exec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult>;

  /** Get the list of currently active tool names. */
  getActiveTools(): string[];

  /** Get all configured tools with parameter schema and source metadata. */
  getAllTools(): ToolInfo[];

  /** Set the active tools by name. */
  setActiveTools(toolNames: string[]): void;

  /** Get available slash commands in the current session. */
  getCommands(): SlashCommandInfo[];

  // =========================================================================
  // Model and Thinking Level
  // =========================================================================

  /** Set the current model. Returns false if no API key available. */
  setModel(model: Model): Promise<boolean>;

  /** Get current thinking level. */
  getThinkingLevel(): ThinkingLevel;

  /** Set thinking level (clamped to model capabilities). */
  setThinkingLevel(level: ThinkingLevel): void;

  // =========================================================================
  // Provider Registration
  // =========================================================================

  /**
   * Register a model provider.
   *
   * If `models` is provided: replaces all existing models for this provider.
   * If `oauth` is provided: registers OAuth provider for /login support.
   * If `streamSimple` is provided: registers a custom API stream handler.
   *
   * During initial extension load this call is queued and applied once the
   * runner has bound its context. After that it takes effect immediately, so
   * it is safe to call from command handlers or event callbacks without
   * requiring a `/reload`.
   *
   * @example
   * // Register a new provider with custom models
   * api.registerProvider("my-proxy", {
   *   baseUrl: "https://proxy.example.com",
   *   apiKey: "PROXY_API_KEY",
   *   api: "anthropic-messages",
   *   models: [
   *     {
   *       id: "claude-sonnet-4-20250514",
   *       name: "Claude 4 Sonnet (proxy)",
   *       reasoning: false,
   *       input: ["text", "image"],
   *       cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
   *       contextWindow: 200000,
   *       maxTokens: 16384
   *     }
   *   ]
   * });
   *
   * @example
   * // Override baseUrl for an existing provider
   * api.registerProvider("anthropic", {
   *   baseUrl: "https://proxy.example.com"
   * });
   *
   * @example
   * // Register provider with OAuth support
   * api.registerProvider("corporate-ai", {
   *   baseUrl: "https://ai.corp.com",
   *   api: "openai-responses",
   *   models: [...],
   *   oauth: {
   *     name: "Corporate AI (SSO)",
   *     async login(callbacks) { ... },
   *     async refreshToken(credentials) { ... },
   *     getApiKey(credentials) { return credentials.access; }
   *   }
   * });
   */
  registerProvider(name: string, config: ProviderConfig): void;

  /**
   * Unregister a previously registered provider.
   *
   * Removes all models belonging to the named provider and reloads the configured
   * model registry. Has no effect if the provider is not currently registered.
   *
   * Like `registerProvider`, this takes effect immediately when called after
   * the initial load phase.
   *
   * @example
   * api.unregisterProvider("my-proxy");
   */
  unregisterProvider(name: string): void;

  /** Shared event bus for extension communication. */
  events: EventBus;
}

// ============================================================================
// Provider Registration Types
// ============================================================================

/** Configuration for registering a provider via api.registerProvider(). */
export interface ProviderConfig {
  /** Display name for the provider in UI. */
  name?: string;
  /** Base URL for the API endpoint. Required when defining models. */
  baseUrl?: string;
  /** API key or environment variable name. Required when defining models (unless oauth provided). */
  apiKey?: string;
  /** API type. Required at provider or model level when defining models. */
  api?: Api;
  /** Optional streamSimple handler for custom APIs. */
  streamSimple?: (
    model: Model,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStreamContract;
  /** Custom headers to include in requests. */
  headers?: Record<string, string>;
  /** If true, adds Authorization: Bearer header with the resolved API key. */
  authHeader?: boolean;
  /** Models to register. If provided, replaces all existing models for this provider. */
  models?: ProviderModelConfig[];
  /** OAuth provider for /login support. The `id` is set automatically from the provider name. */
  oauth?: {
    /** Display name for the provider in login UI. */
    name: string;
    /** Run the login flow, return credentials to persist. */
    login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
    /** Refresh expired credentials, return updated credentials to persist. */
    refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
    /** Convert credentials to API key string for the provider. */
    getApiKey(credentials: OAuthCredentials): string;
    /** Optional: modify models for this provider (e.g., update baseUrl based on credentials). */
    modifyModels?(models: Model[], credentials: OAuthCredentials): Model[];
  };
}

/** Configuration for a model within a provider. */
export interface ProviderModelConfig {
  /** Model ID (e.g., "claude-sonnet-4-20250514"). */
  id: string;
  /** Display name (e.g., "Claude 4 Sonnet"). */
  name: string;
  /** API type override for this model. */
  api?: Api;
  /** API endpoint URL override for this model. */
  baseUrl?: string;
  /** Whether the model supports extended thinking. */
  reasoning: boolean;
  /** Maps OpenClaw thinking levels to provider/model-specific values; null marks a level unsupported. */
  thinkingLevelMap?: Model["thinkingLevelMap"];
  /** Supported input types. */
  input: ("text" | "image")[];
  /** Cost per token (for tracking, can be 0). */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** Maximum context window size in tokens. */
  contextWindow: number;
  /** Maximum output tokens. */
  maxTokens: number;
  /** Custom headers for this model. */
  headers?: Record<string, string>;
  /** OpenAI compatibility settings. */
  compat?: Model["compat"];
}

/** Extension factory function type. Supports both sync and async initialization. */
export type ExtensionFactory = (api: ExtensionAPI) => void | Promise<void>;

// ============================================================================
// Loaded Extension Types
// ============================================================================

export interface RegisteredTool {
  definition: ToolDefinition;
  sourceInfo: SourceInfo;
}

export interface ExtensionFlag {
  name: string;
  description?: string;
  type: "boolean" | "string";
  default?: boolean | string;
  extensionPath: string;
}

export interface ExtensionShortcut {
  shortcut: KeyId;
  description?: string;
  handler: (ctx: ExtensionContext) => Promise<void> | void;
  extensionPath: string;
}

type HandlerFn = (...args: unknown[]) => Promise<unknown>;

export type SendMessageHandler = <T = unknown>(
  message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
  options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
) => void;

export type SendUserMessageHandler = (
  content: string | (TextContent | ImageContent)[],
  options?: { deliverAs?: "steer" | "followUp" },
) => void;

export type AppendEntryHandler = (customType: string, data?: unknown) => void;

export type SetSessionNameHandler = (name: string) => void;

export type GetSessionNameHandler = () => string | undefined;

export type GetActiveToolsHandler = () => string[];

/** Tool info with name, description, parameter schema, and source metadata */
export type ToolInfo = Pick<ToolDefinition, "name" | "description" | "parameters"> & {
  sourceInfo: SourceInfo;
};

export type GetAllToolsHandler = () => ToolInfo[];

export type GetCommandsHandler = () => SlashCommandInfo[];

export type SetActiveToolsHandler = (toolNames: string[]) => void;

export type RefreshToolsHandler = () => void;

export type SetModelHandler = (model: Model) => Promise<boolean>;

export type GetThinkingLevelHandler = () => ThinkingLevel;

export type SetThinkingLevelHandler = (level: ThinkingLevel) => void;

export type SetLabelHandler = (entryId: string, label: string | undefined) => void;

/**
 * Shared state created by loader, used during registration and runtime.
 * Contains flag values (defaults set during registration, CLI values set after).
 */
export interface ExtensionRuntimeState {
  flagValues: Map<string, boolean | string>;
  /** Provider registrations queued during extension loading, processed when runner binds */
  pendingProviderRegistrations: Array<{
    name: string;
    config: ProviderConfig;
    extensionPath: string;
  }>;
  /** Throws when this extension instance is stale after runtime replacement. */
  assertActive: () => void;
  /** Marks this extension instance as stale after runtime replacement or reload. */
  invalidate: (message?: string) => void;
  /**
   * Register or unregister a provider.
   *
   * Before bindCore(): queues registrations / removes from queue.
   * After bindCore(): calls ModelRegistry directly for immediate effect.
   */
  registerProvider: (name: string, config: ProviderConfig, extensionPath?: string) => void;
  unregisterProvider: (name: string, extensionPath?: string) => void;
}

/**
 * Action implementations for ExtensionAPI methods.
 * Provided to runner.initialize(), copied into the shared runtime.
 */
export interface ExtensionActions {
  sendMessage: SendMessageHandler;
  sendUserMessage: SendUserMessageHandler;
  appendEntry: AppendEntryHandler;
  setSessionName: SetSessionNameHandler;
  getSessionName: GetSessionNameHandler;
  setLabel: SetLabelHandler;
  getActiveTools: GetActiveToolsHandler;
  getAllTools: GetAllToolsHandler;
  setActiveTools: SetActiveToolsHandler;
  refreshTools: RefreshToolsHandler;
  getCommands: GetCommandsHandler;
  setModel: SetModelHandler;
  getThinkingLevel: GetThinkingLevelHandler;
  setThinkingLevel: SetThinkingLevelHandler;
}

/**
 * Actions for ExtensionContext (ctx.* in event handlers).
 * Required by all modes.
 */
export interface ExtensionContextActions {
  getModel: () => Model | undefined;
  isIdle: () => boolean;
  getSignal: () => AbortSignal | undefined;
  abort: () => void;
  hasPendingMessages: () => boolean;
  shutdown: () => void;
  getContextUsage: () => ContextUsage | undefined;
  compact: (options?: CompactOptions) => void;
  getSystemPrompt: () => string;
}

/**
 * Actions for ExtensionCommandContext (ctx.* in command handlers).
 * Only needed for interactive mode where extension commands are invokable.
 */
export interface ExtensionCommandContextActions {
  waitForIdle: () => Promise<void>;
  newSession: (options?: {
    parentSession?: string;
    setup?: (sessionManager: SessionManager) => Promise<void>;
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  }) => Promise<{ cancelled: boolean }>;
  fork: (
    entryId: string,
    options?: {
      position?: "before" | "at";
      withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
    },
  ) => Promise<{ cancelled: boolean }>;
  navigateTree: (
    targetId: string,
    options?: {
      summarize?: boolean;
      customInstructions?: string;
      replaceInstructions?: boolean;
      label?: string;
    },
  ) => Promise<{ cancelled: boolean }>;
  switchSession: (
    sessionPath: string,
    options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
  ) => Promise<{ cancelled: boolean }>;
  reload: () => Promise<void>;
}

/**
 * Full runtime = state + actions.
 * Created by loader with throwing action stubs, completed by runner.initialize().
 */
export interface ExtensionRuntime extends ExtensionRuntimeState, ExtensionActions {}

/** Loaded extension with all registered items. */
export interface Extension {
  path: string;
  resolvedPath: string;
  sourceInfo: SourceInfo;
  handlers: Map<string, HandlerFn[]>;
  tools: Map<string, RegisteredTool>;
  messageRenderers: Map<string, MessageRenderer>;
  commands: Map<string, RegisteredCommand>;
  flags: Map<string, ExtensionFlag>;
  shortcuts: Map<KeyId, ExtensionShortcut>;
}

/** Result of loading extensions. */
export interface LoadExtensionsResult {
  extensions: Extension[];
  errors: Array<{ path: string; error: string }>;
  /** Shared runtime - actions are throwing stubs until runner.initialize() */
  runtime: ExtensionRuntime;
}

// ============================================================================
// Extension Error
// ============================================================================

export interface ExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
