/**
 * Extension runner - executes extensions and manages their lifecycle.
 */

import type { KeyId } from "@earendil-works/pi-tui";
import type { ImageContent, Model } from "../../../llm/types.js";
import { type Theme, theme } from "../../modes/interactive/theme/theme.js";
import type { AgentMessage } from "../../runtime/index.js";
import type { ResourceDiagnostic } from "../diagnostics.js";
import type { KeybindingsConfig } from "../keybindings.js";
import type { ModelRegistry } from "../model-registry.js";
import type { SessionManager } from "../session-manager.js";
import type { BuildSystemPromptOptions } from "../system-prompt.js";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  CompactOptions,
  ContextEvent,
  ContextEventResult,
  ContextUsage,
  Extension,
  ExtensionActions,
  ExtensionCommandContext,
  ExtensionCommandContextActions,
  ExtensionContext,
  ExtensionContextActions,
  ExtensionError,
  ExtensionEvent,
  ExtensionFlag,
  ExtensionRuntime,
  ExtensionShortcut,
  ExtensionUIContext,
  InputEvent,
  InputEventResult,
  InputSource,
  MessageEndEvent,
  MessageEndEventResult,
  MessageRenderer,
  ProviderConfig,
  RegisteredCommand,
  RegisteredTool,
  ReplacedSessionContext,
  ResolvedCommand,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  SessionBeforeCompactResult,
  SessionBeforeForkResult,
  SessionBeforeSwitchResult,
  SessionBeforeTreeResult,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  UserBashEvent,
  UserBashEventResult,
} from "./types.js";

// Extension shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
  "app.interrupt",
  "app.clear",
  "app.exit",
  "app.suspend",
  "app.thinking.cycle",
  "app.model.cycleForward",
  "app.model.cycleBackward",
  "app.model.select",
  "app.tools.expand",
  "app.thinking.toggle",
  "app.editor.external",
  "app.message.followUp",
  "tui.input.submit",
  "tui.select.confirm",
  "tui.select.cancel",
  "tui.input.copy",
  "tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
  const builtinKeybindings = {} as BuiltInKeyBindings;
  for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
    if (keys === undefined) {
      continue;
    }
    const keyList = Array.isArray(keys) ? keys : [keys];
    const restrictOverride = (
      RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]
    ).includes(keybinding);
    for (const key of keyList) {
      const normalizedKey = key.toLowerCase() as KeyId;
      // If multiple actions bind the same key, the reserved action wins so extensions
      // remain blocked by reserved shortcuts regardless of iteration order.
      const existing = builtinKeybindings[normalizedKey];
      if (existing?.restrictOverride && !restrictOverride) {
        continue;
      }
      builtinKeybindings[normalizedKey] = {
        keybinding,
        restrictOverride,
      };
    }
  }
  return builtinKeybindings;
};

/** Combined result from all before_agent_start handlers */
interface BeforeAgentStartCombinedResult {
  messages?: NonNullable<BeforeAgentStartEventResult["message"]>[];
  systemPrompt?: string;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
  ExtensionEvent,
  | ToolCallEvent
  | ToolResultEvent
  | UserBashEvent
  | ContextEvent
  | BeforeProviderRequestEvent
  | BeforeAgentStartEvent
  | MessageEndEvent
  | ResourcesDiscoverEvent
  | InputEvent
>;

type SessionBeforeEvent = Extract<
  RunnerEmitEvent,
  {
    type:
      | "session_before_switch"
      | "session_before_fork"
      | "session_before_compact"
      | "session_before_tree";
  }
>;

type SessionBeforeEventResult =
  | SessionBeforeSwitchResult
  | SessionBeforeForkResult
  | SessionBeforeCompactResult
  | SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends {
  type: "session_before_switch";
}
  ? SessionBeforeSwitchResult | undefined
  : TEvent extends { type: "session_before_fork" }
    ? SessionBeforeForkResult | undefined
    : TEvent extends { type: "session_before_compact" }
      ? SessionBeforeCompactResult | undefined
      : TEvent extends { type: "session_before_tree" }
        ? SessionBeforeTreeResult | undefined
        : undefined;

export type ExtensionErrorListener = (error: ExtensionError) => void;

export type NewSessionHandler = (options?: {
  parentSession?: string;
  setup?: (sessionManager: SessionManager) => Promise<void>;
  withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
  entryId: string,
  options?: {
    position?: "before" | "at";
    withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
  },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
  targetId: string,
  options?: {
    summarize?: boolean;
    customInstructions?: string;
    replaceInstructions?: boolean;
    label?: string;
  },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
  sessionPath: string,
  options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

type ReloadHandler = () => Promise<void>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
  extensionRunner: ExtensionRunner,
  event: SessionShutdownEvent,
): Promise<boolean> {
  if (extensionRunner.hasHandlers("session_shutdown")) {
    await extensionRunner.emit(event);
    return true;
  }
  return false;
}

const noOpUIContext: ExtensionUIContext = {
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
  notify: () => {},
  onTerminalInput: () => () => {},
  setStatus: () => {},
  setWorkingMessage: () => {},
  setWorkingVisible: () => {},
  setWorkingIndicator: () => {},
  setHiddenThinkingLabel: () => {},
  setWidget: () => {},
  setFooter: () => {},
  setHeader: () => {},
  setTitle: () => {},
  custom: async () => undefined as never,
  pasteToEditor: () => {},
  setEditorText: () => {},
  getEditorText: () => "",
  editor: async () => undefined,
  addAutocompleteProvider: () => {},
  setEditorComponent: () => {},
  getEditorComponent: () => undefined,
  get theme() {
    return theme;
  },
  getAllThemes: () => [],
  getTheme: () => undefined,
  setTheme: (nextTheme: string | Theme) => {
    void nextTheme;
    return { success: false, error: "UI not available" };
  },
  getToolsExpanded: () => false,
  setToolsExpanded: () => {},
};

export class ExtensionRunner {
  private extensions: Extension[];
  private runtime: ExtensionRuntime;
  private uiContext: ExtensionUIContext;
  private cwd: string;
  private sessionManager: SessionManager;
  private modelRegistry: ModelRegistry;
  private errorListeners: Set<ExtensionErrorListener> = new Set();
  private getModel: () => Model | undefined = () => undefined;
  private isIdleFn: () => boolean = () => true;
  private getSignalFn: () => AbortSignal | undefined = () => undefined;
  private waitForIdleFn: () => Promise<void> = async () => {};
  private abortFn: () => void = () => {};
  private hasPendingMessagesFn: () => boolean = () => false;
  private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
  private compactFn: (options?: CompactOptions) => void = () => {};
  private getSystemPromptFn: () => string = () => "";
  private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
  private forkHandler: ForkHandler = async () => ({ cancelled: false });
  private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
  private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
  private reloadHandler: ReloadHandler = async () => {};
  private shutdownHandler: ShutdownHandler = () => {};
  private shortcutDiagnostics: ResourceDiagnostic[] = [];
  private commandDiagnostics: ResourceDiagnostic[] = [];
  private staleMessage: string | undefined;

  constructor(
    extensions: Extension[],
    runtime: ExtensionRuntime,
    cwd: string,
    sessionManager: SessionManager,
    modelRegistry: ModelRegistry,
  ) {
    this.extensions = extensions;
    this.runtime = runtime;
    this.uiContext = noOpUIContext;
    this.cwd = cwd;
    this.sessionManager = sessionManager;
    this.modelRegistry = modelRegistry;
  }

  bindCore(
    actions: ExtensionActions,
    contextActions: ExtensionContextActions,
    providerActions?: {
      registerProvider?: (name: string, config: ProviderConfig) => void;
      unregisterProvider?: (name: string) => void;
    },
  ): void {
    // Copy actions into the shared runtime (all extension APIs reference this)
    this.runtime.sendMessage = actions.sendMessage;
    this.runtime.sendUserMessage = actions.sendUserMessage;
    this.runtime.appendEntry = actions.appendEntry;
    this.runtime.setSessionName = actions.setSessionName;
    this.runtime.getSessionName = actions.getSessionName;
    this.runtime.setLabel = actions.setLabel;
    this.runtime.getActiveTools = actions.getActiveTools;
    this.runtime.getAllTools = actions.getAllTools;
    this.runtime.setActiveTools = actions.setActiveTools;
    this.runtime.refreshTools = actions.refreshTools;
    this.runtime.getCommands = actions.getCommands;
    this.runtime.setModel = actions.setModel;
    this.runtime.getThinkingLevel = actions.getThinkingLevel;
    this.runtime.setThinkingLevel = actions.setThinkingLevel;

    // Context actions (required)
    this.getModel = contextActions.getModel;
    this.isIdleFn = contextActions.isIdle;
    this.getSignalFn = contextActions.getSignal;
    this.abortFn = contextActions.abort;
    this.hasPendingMessagesFn = contextActions.hasPendingMessages;
    this.shutdownHandler = contextActions.shutdown;
    this.getContextUsageFn = contextActions.getContextUsage;
    this.compactFn = contextActions.compact;
    this.getSystemPromptFn = contextActions.getSystemPrompt;

    // Flush provider registrations queued during extension loading
    for (const { name, config, extensionPath } of this.runtime.pendingProviderRegistrations) {
      try {
        if (providerActions?.registerProvider) {
          providerActions.registerProvider(name, config);
        } else {
          this.modelRegistry.registerProvider(name, config);
        }
      } catch (err) {
        this.emitError({
          extensionPath,
          event: "register_provider",
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }
    this.runtime.pendingProviderRegistrations = [];

    // From this point on, provider registration/unregistration takes effect immediately
    // without requiring a /reload.
    this.runtime.registerProvider = (name, config) => {
      if (providerActions?.registerProvider) {
        providerActions.registerProvider(name, config);
        return;
      }
      this.modelRegistry.registerProvider(name, config);
    };
    this.runtime.unregisterProvider = (name) => {
      if (providerActions?.unregisterProvider) {
        providerActions.unregisterProvider(name);
        return;
      }
      this.modelRegistry.unregisterProvider(name);
    };
  }

  bindCommandContext(actions?: ExtensionCommandContextActions): void {
    if (actions) {
      this.waitForIdleFn = actions.waitForIdle;
      this.newSessionHandler = actions.newSession;
      this.forkHandler = actions.fork;
      this.navigateTreeHandler = actions.navigateTree;
      this.switchSessionHandler = actions.switchSession;
      this.reloadHandler = actions.reload;
      return;
    }

    this.waitForIdleFn = async () => {};
    this.newSessionHandler = async () => ({ cancelled: false });
    this.forkHandler = async () => ({ cancelled: false });
    this.navigateTreeHandler = async () => ({ cancelled: false });
    this.switchSessionHandler = async () => ({ cancelled: false });
    this.reloadHandler = async () => {};
  }

  setUIContext(uiContext?: ExtensionUIContext): void {
    this.uiContext = uiContext ?? noOpUIContext;
  }

  getUIContext(): ExtensionUIContext {
    return this.uiContext;
  }

  hasUI(): boolean {
    return this.uiContext !== noOpUIContext;
  }

  getExtensionPaths(): string[] {
    return this.extensions.map((e) => e.path);
  }

  /** Get all registered tools from all extensions (first registration per name wins). */
  getAllRegisteredTools(): RegisteredTool[] {
    const toolsByName = new Map<string, RegisteredTool>();
    for (const ext of this.extensions) {
      for (const tool of ext.tools.values()) {
        if (!toolsByName.has(tool.definition.name)) {
          toolsByName.set(tool.definition.name, tool);
        }
      }
    }
    return Array.from(toolsByName.values());
  }

  /** Get a tool definition by name. Returns undefined if not found. */
  getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
    for (const ext of this.extensions) {
      const tool = ext.tools.get(toolName);
      if (tool) {
        return tool.definition;
      }
    }
    return undefined;
  }

  getFlags(): Map<string, ExtensionFlag> {
    const allFlags = new Map<string, ExtensionFlag>();
    for (const ext of this.extensions) {
      for (const [name, flag] of ext.flags) {
        if (!allFlags.has(name)) {
          allFlags.set(name, flag);
        }
      }
    }
    return allFlags;
  }

  setFlagValue(name: string, value: boolean | string): void {
    this.runtime.flagValues.set(name, value);
  }

  getFlagValues(): Map<string, boolean | string> {
    return new Map(this.runtime.flagValues);
  }

  getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ExtensionShortcut> {
    this.shortcutDiagnostics = [];
    const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
    const extensionShortcuts = new Map<KeyId, ExtensionShortcut>();

    const addDiagnostic = (message: string, extensionPath: string) => {
      this.shortcutDiagnostics.push({ type: "warning", message, path: extensionPath });
      if (!this.hasUI()) {
        console.warn(message);
      }
    };

    for (const ext of this.extensions) {
      for (const [key, shortcut] of ext.shortcuts) {
        const normalizedKey = key.toLowerCase() as KeyId;

        const builtInKeybinding = builtinKeybindings[normalizedKey];
        if (builtInKeybinding?.restrictOverride === true) {
          addDiagnostic(
            `Extension shortcut '${key}' from ${shortcut.extensionPath} conflicts with built-in shortcut. Skipping.`,
            shortcut.extensionPath,
          );
          continue;
        }

        if (builtInKeybinding?.restrictOverride === false) {
          addDiagnostic(
            `Extension shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
            shortcut.extensionPath,
          );
        }

        const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
        if (existingExtensionShortcut) {
          addDiagnostic(
            `Extension shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.extensionPath} and ${shortcut.extensionPath}. Using ${shortcut.extensionPath}.`,
            shortcut.extensionPath,
          );
        }
        extensionShortcuts.set(normalizedKey, shortcut);
      }
    }
    return extensionShortcuts;
  }

  getShortcutDiagnostics(): ResourceDiagnostic[] {
    return this.shortcutDiagnostics;
  }

  invalidate(
    message = "This extension ctx is stale after session replacement or reload. Do not use a captured api or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
  ): void {
    if (!this.staleMessage) {
      this.staleMessage = message;
      this.runtime.invalidate(message);
    }
  }

  private assertActive(): void {
    if (this.staleMessage) {
      throw new Error(this.staleMessage);
    }
  }

  onError(listener: ExtensionErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emitError(error: ExtensionError): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  hasHandlers(eventType: string): boolean {
    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(eventType);
      if (handlers && handlers.length > 0) {
        return true;
      }
    }
    return false;
  }

  getMessageRenderer(customType: string): MessageRenderer | undefined {
    for (const ext of this.extensions) {
      const renderer = ext.messageRenderers.get(customType);
      if (renderer) {
        return renderer;
      }
    }
    return undefined;
  }

  private resolveRegisteredCommands(): ResolvedCommand[] {
    const commands: RegisteredCommand[] = [];
    const counts = new Map<string, number>();

    for (const ext of this.extensions) {
      for (const command of ext.commands.values()) {
        commands.push(command);
        counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
      }
    }

    const seen = new Map<string, number>();
    const takenInvocationNames = new Set<string>();

    return commands.map((command) => {
      const occurrence = (seen.get(command.name) ?? 0) + 1;
      seen.set(command.name, occurrence);

      let invocationName =
        (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

      if (takenInvocationNames.has(invocationName)) {
        let suffix = occurrence;
        do {
          suffix++;
          invocationName = `${command.name}:${suffix}`;
        } while (takenInvocationNames.has(invocationName));
      }

      takenInvocationNames.add(invocationName);
      return Object.assign({}, command, { invocationName });
    });
  }

  getRegisteredCommands(): ResolvedCommand[] {
    this.commandDiagnostics = [];
    return this.resolveRegisteredCommands();
  }

  getCommandDiagnostics(): ResourceDiagnostic[] {
    return this.commandDiagnostics;
  }

  getCommand(name: string): ResolvedCommand | undefined {
    return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
  }

  /**
   * Request a graceful shutdown. Called by extension tools and event handlers.
   * The actual shutdown behavior is provided by the mode via bindExtensions().
   */
  shutdown(): void {
    this.shutdownHandler();
  }

  /**
   * Create an ExtensionContext for use in event handlers and tool execution.
   * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
   */
  createContext(): ExtensionContext {
    const assertActive = () => this.assertActive();
    const getModel = this.getModel;
    const getUiContext = () => this.uiContext;
    const hasUiContext = () => this.hasUI();
    const getCwd = () => this.cwd;
    const getSessionManager = () => this.sessionManager;
    const getModelRegistry = () => this.modelRegistry;
    const isIdle = () => this.isIdleFn();
    const getSignal = () => this.getSignalFn();
    const abort = () => this.abortFn();
    const hasPendingMessages = () => this.hasPendingMessagesFn();
    const shutdown = () => this.shutdownHandler();
    const getContextUsage = () => this.getContextUsageFn();
    const compact = (options?: CompactOptions) => this.compactFn(options);
    const getSystemPrompt = () => this.getSystemPromptFn();
    return {
      get ui() {
        assertActive();
        return getUiContext();
      },
      get hasUI() {
        assertActive();
        return hasUiContext();
      },
      get cwd() {
        assertActive();
        return getCwd();
      },
      get sessionManager() {
        assertActive();
        return getSessionManager();
      },
      get modelRegistry() {
        assertActive();
        return getModelRegistry();
      },
      get model() {
        assertActive();
        return getModel();
      },
      isIdle: () => {
        assertActive();
        return isIdle();
      },
      get signal() {
        assertActive();
        return getSignal();
      },
      abort: () => {
        assertActive();
        abort();
      },
      hasPendingMessages: () => {
        assertActive();
        return hasPendingMessages();
      },
      shutdown: () => {
        assertActive();
        shutdown();
      },
      getContextUsage: () => {
        assertActive();
        return getContextUsage();
      },
      compact: (options) => {
        assertActive();
        compact(options);
      },
      getSystemPrompt: () => {
        assertActive();
        return getSystemPrompt();
      },
    };
  }

  createCommandContext(): ExtensionCommandContext {
    // Use property descriptors instead of object spread so the guarded getters from
    // createContext() stay lazy. A spread would eagerly read them once and freeze the
    // old values into the returned object, bypassing stale-instance checks.
    const context = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(this.createContext()),
    ) as ExtensionCommandContext;
    context.waitForIdle = () => {
      this.assertActive();
      return this.waitForIdleFn();
    };
    context.newSession = (options) => {
      this.assertActive();
      return this.newSessionHandler(options);
    };
    context.fork = (entryId, options) => {
      this.assertActive();
      return this.forkHandler(entryId, options);
    };
    context.navigateTree = (targetId, options) => {
      this.assertActive();
      return this.navigateTreeHandler(targetId, options);
    };
    context.switchSession = (sessionPath, options) => {
      this.assertActive();
      return this.switchSessionHandler(sessionPath, options);
    };
    context.reload = () => {
      this.assertActive();
      return this.reloadHandler();
    };
    return context;
  }

  private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
    return (
      event.type === "session_before_switch" ||
      event.type === "session_before_fork" ||
      event.type === "session_before_compact" ||
      event.type === "session_before_tree"
    );
  }

  async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
    const ctx = this.createContext();
    let result: SessionBeforeEventResult | undefined;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get(event.type);
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const handlerResult = await handler(event, ctx);

          if (this.isSessionBeforeEvent(event) && handlerResult) {
            result = handlerResult as SessionBeforeEventResult;
            if (result.cancel) {
              return result as RunnerEmitResult<TEvent>;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: event.type,
            error: message,
            stack,
          });
        }
      }
    }

    return result as RunnerEmitResult<TEvent>;
  }

  async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
    const ctx = this.createContext();
    let currentMessage = event.message;
    let modified = false;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("message_end");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
          const handlerResult = (await handler(currentEvent, ctx)) as
            | MessageEndEventResult
            | undefined;
          if (!handlerResult?.message) {
            continue;
          }

          if (handlerResult.message.role !== currentMessage.role) {
            this.emitError({
              extensionPath: ext.path,
              event: "message_end",
              error: "message_end handlers must return a message with the same role",
            });
            continue;
          }

          currentMessage = handlerResult.message;
          modified = true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "message_end",
            error: message,
            stack,
          });
        }
      }
    }

    return modified ? currentMessage : undefined;
  }

  async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    const ctx = this.createContext();
    const currentEvent: ToolResultEvent = { ...event };
    let modified = false;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("tool_result");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const handlerResult = (await handler(currentEvent, ctx)) as
            | ToolResultEventResult
            | undefined;
          if (!handlerResult) {
            continue;
          }

          if (handlerResult.content !== undefined) {
            currentEvent.content = handlerResult.content;
            modified = true;
          }
          if (handlerResult.details !== undefined) {
            currentEvent.details = handlerResult.details;
            modified = true;
          }
          if (handlerResult.isError !== undefined) {
            currentEvent.isError = handlerResult.isError;
            modified = true;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "tool_result",
            error: message,
            stack,
          });
        }
      }
    }

    if (!modified) {
      return undefined;
    }

    return {
      content: currentEvent.content,
      details: currentEvent.details,
      isError: currentEvent.isError,
    };
  }

  async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    const ctx = this.createContext();
    let result: ToolCallEventResult | undefined;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("tool_call");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        const handlerResult = await handler(event, ctx);

        if (handlerResult) {
          result = handlerResult as ToolCallEventResult;
          if (result.block) {
            return result;
          }
        }
      }
    }

    return result;
  }

  async emitUserBash(event: UserBashEvent): Promise<UserBashEventResult | undefined> {
    const ctx = this.createContext();

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("user_bash");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const handlerResult = await handler(event, ctx);
          if (handlerResult) {
            return handlerResult as UserBashEventResult;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "user_bash",
            error: message,
            stack,
          });
        }
      }
    }

    return undefined;
  }

  async emitContext(messages: AgentMessage[]): Promise<AgentMessage[]> {
    const ctx = this.createContext();
    let currentMessages = structuredClone(messages);

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("context");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const event: ContextEvent = { type: "context", messages: currentMessages };
          const handlerResult = await handler(event, ctx);

          if (handlerResult && (handlerResult as ContextEventResult).messages) {
            currentMessages = (handlerResult as ContextEventResult).messages!;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "context",
            error: message,
            stack,
          });
        }
      }
    }

    return currentMessages;
  }

  async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
    const ctx = this.createContext();
    let currentPayload = payload;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("before_provider_request");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const event: BeforeProviderRequestEvent = {
            type: "before_provider_request",
            payload: currentPayload,
          };
          const handlerResult = await handler(event, ctx);
          if (handlerResult !== undefined) {
            currentPayload = handlerResult;
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "before_provider_request",
            error: message,
            stack,
          });
        }
      }
    }

    return currentPayload;
  }

  async emitBeforeAgentStart(
    prompt: string,
    images: ImageContent[] | undefined,
    systemPrompt: string,
    systemPromptOptions: BuildSystemPromptOptions,
  ): Promise<BeforeAgentStartCombinedResult | undefined> {
    let currentSystemPrompt = systemPrompt;
    const ctx = Object.defineProperties(
      {},
      Object.getOwnPropertyDescriptors(this.createContext()),
    ) as ExtensionContext;
    ctx.getSystemPrompt = () => {
      this.assertActive();
      return currentSystemPrompt;
    };
    const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];
    let systemPromptModified = false;

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("before_agent_start");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const event: BeforeAgentStartEvent = {
            type: "before_agent_start",
            prompt,
            images,
            systemPrompt: currentSystemPrompt,
            systemPromptOptions,
          };
          const handlerResult = await handler(event, ctx);

          if (handlerResult) {
            const result = handlerResult as BeforeAgentStartEventResult;
            if (result.message) {
              messages.push(result.message);
            }
            if (result.systemPrompt !== undefined) {
              currentSystemPrompt = result.systemPrompt;
              systemPromptModified = true;
            }
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "before_agent_start",
            error: message,
            stack,
          });
        }
      }
    }

    if (messages.length > 0 || systemPromptModified) {
      return {
        messages: messages.length > 0 ? messages : undefined,
        systemPrompt: systemPromptModified ? currentSystemPrompt : undefined,
      };
    }

    return undefined;
  }

  async emitResourcesDiscover(
    cwd: string,
    reason: ResourcesDiscoverEvent["reason"],
  ): Promise<{
    skillPaths: Array<{ path: string; extensionPath: string }>;
    promptPaths: Array<{ path: string; extensionPath: string }>;
    themePaths: Array<{ path: string; extensionPath: string }>;
  }> {
    const ctx = this.createContext();
    const skillPaths: Array<{ path: string; extensionPath: string }> = [];
    const promptPaths: Array<{ path: string; extensionPath: string }> = [];
    const themePaths: Array<{ path: string; extensionPath: string }> = [];

    for (const ext of this.extensions) {
      const handlers = ext.handlers.get("resources_discover");
      if (!handlers || handlers.length === 0) {
        continue;
      }

      for (const handler of handlers) {
        try {
          const event: ResourcesDiscoverEvent = { type: "resources_discover", cwd, reason };
          const handlerResult = await handler(event, ctx);
          const result = handlerResult as ResourcesDiscoverResult | undefined;

          if (result?.skillPaths?.length) {
            skillPaths.push(
              ...result.skillPaths.map((path) => ({ path, extensionPath: ext.path })),
            );
          }
          if (result?.promptPaths?.length) {
            promptPaths.push(
              ...result.promptPaths.map((path) => ({ path, extensionPath: ext.path })),
            );
          }
          if (result?.themePaths?.length) {
            themePaths.push(
              ...result.themePaths.map((path) => ({ path, extensionPath: ext.path })),
            );
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const stack = err instanceof Error ? err.stack : undefined;
          this.emitError({
            extensionPath: ext.path,
            event: "resources_discover",
            error: message,
            stack,
          });
        }
      }
    }

    return { skillPaths, promptPaths, themePaths };
  }

  /** Emit input event. Transforms chain, "handled" short-circuits. */
  async emitInput(
    text: string,
    images: ImageContent[] | undefined,
    source: InputSource,
  ): Promise<InputEventResult> {
    const ctx = this.createContext();
    let currentText = text;
    let currentImages = images;

    for (const ext of this.extensions) {
      for (const handler of ext.handlers.get("input") ?? []) {
        try {
          const event: InputEvent = {
            type: "input",
            text: currentText,
            images: currentImages,
            source,
          };
          const result = (await handler(event, ctx)) as InputEventResult | undefined;
          if (result?.action === "handled") {
            return result;
          }
          if (result?.action === "transform") {
            currentText = result.text;
            currentImages = result.images ?? currentImages;
          }
        } catch (err) {
          this.emitError({
            extensionPath: ext.path,
            event: "input",
            error: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
          });
        }
      }
    }
    return currentText !== text || currentImages !== images
      ? { action: "transform", text: currentText, images: currentImages }
      : { action: "continue" };
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
