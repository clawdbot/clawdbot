import type { ImageContent, Model } from "../../llm/types.js";
import type {
  Agent,
  AgentEvent,
  AgentMessage,
  AgentTool,
  CompactionResult,
  ThinkingLevel,
} from "../runtime/index.js";
import type {
  ContextUsage,
  ExtensionCommandContextActions,
  ExtensionErrorListener,
  ExtensionRunner,
  ExtensionUIContext,
  InputSource,
  SessionStartEvent,
  ShutdownHandler,
  ToolDefinition,
} from "./extensions/index.js";
import type { ModelRegistry } from "./model-registry.js";
import type { ResourceLoader } from "./resource-loader.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsManager } from "./settings-manager.js";

export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
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

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;
export type AgentSessionWriteLockRunner = <T>(run: () => Promise<T> | T) => Promise<T>;

export interface AgentSessionConfig {
  agent: Agent;
  sessionManager: SessionManager;
  settingsManager: SettingsManager;
  cwd: string;
  /** Models to cycle through with Ctrl+P. */
  scopedModels?: Array<{ model: Model; thinkingLevel?: ThinkingLevel }>;
  /** Resource loader for skills, prompts, themes, context files, and system prompt. */
  resourceLoader: ResourceLoader;
  /** SDK custom tools registered outside extensions. */
  customTools?: ToolDefinition[];
  /** Model registry for API key resolution and model discovery. */
  modelRegistry: ModelRegistry;
  /** Initial active built-in tool names. Defaults to read, bash, edit, and write. */
  initialActiveToolNames?: string[];
  /** Optional tool allowlist. */
  allowedToolNames?: string[];
  /** Exclude built-in shell and filesystem tools from the registry. */
  disableBuiltInTools?: boolean;
  /** Override base tools for custom runtimes. */
  baseToolsOverride?: Record<string, AgentTool>;
  /** Mutable reference used by Agent to access the current extension runner. */
  extensionRunnerRef?: { current?: ExtensionRunner };
  /** Session start metadata emitted when extensions bind to this runtime. */
  sessionStartEvent?: SessionStartEvent;
  /** Lock used before session-file writes or write-capable hooks. */
  withSessionWriteLock?: AgentSessionWriteLockRunner;
  /** Owner of reactive context-overflow recovery. Defaults to the session. */
  contextOverflowRecoveryOwner?: "session" | "caller";
}

export interface ExtensionBindings {
  uiContext?: ExtensionUIContext;
  commandContextActions?: ExtensionCommandContextActions;
  abortHandler?: () => void;
  shutdownHandler?: ShutdownHandler;
  onError?: ExtensionErrorListener;
}

export interface PromptOptions {
  /** Expand file-based prompt templates. Defaults to true. */
  expandPromptTemplates?: boolean;
  /** Image attachments. */
  images?: ImageContent[];
  /** Queue behavior when an agent is already streaming. */
  streamingBehavior?: "steer" | "followUp";
  /** Source of input for extension input handlers. Defaults to interactive. */
  source?: InputSource;
  /** Internal RPC hook for prompt preflight acceptance or rejection. */
  preflightResult?: (success: boolean) => void;
}

/** Result from cycling the active model. */
export interface ModelCycleResult {
  model: Model;
  thinkingLevel: ThinkingLevel;
  /** Whether the cycle used the scoped model list. */
  isScoped: boolean;
}

/** Session statistics exposed to session commands. */
export interface SessionStats {
  sessionFile: string | undefined;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  contextUsage?: ContextUsage;
}
