import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OperatorScope } from "../gateway/operator-scopes.js";
import type {
  PluginConversationBinding,
  PluginConversationBindingRequestParams,
  PluginConversationBindingRequestResult,
} from "./conversation-binding.types.js";

type ChannelId = import("../channels/plugins/types.core.js").ChannelId;

// =============================================================================
// Plugin Commands
// =============================================================================

export type PluginCommandDiagnosticsSession = {
  /** Stable host session key when available. */
  sessionKey?: string;
  /** Ephemeral OpenClaw session id when available. */
  sessionId?: string;
  /**
   * Deprecated transcript locator for this OpenClaw session when available.
   *
   * SQLite-backed sessions use a `sqlite:<agentId>:<sessionId>:<storePath>`
   * marker, not a filesystem path. Use session id/key plus transcript-runtime
   * helpers for active transcript reads.
   *
   * @deprecated Use session identity fields with `plugin-sdk/session-transcript-runtime`.
   */
  sessionFile?: string;
  /** Embedded agent harness selected for this session. */
  agentHarnessId?: string;
  /** Channel/provider for this session when available. */
  channel?: string;
  /** Provider channel id when available. */
  channelId?: ChannelId;
  /** Account id for multi-account channels when available. */
  accountId?: string;
  /** Thread/topic id when available. */
  messageThreadId?: string | number;
  /** Parent conversation id for thread-capable channels when available. */
  threadParentId?: string;
};

/**
 * Context passed to plugin command handlers.
 */
export type PluginCommandContext = {
  /** The sender's identifier (for example a channel-scoped user ID) */
  senderId?: string;
  /** The channel/surface (for example "chat" or "team-chat") */
  channel: string;
  /** Provider channel id */
  channelId?: ChannelId;
  /** Whether the sender is on the allowlist */
  isAuthorizedSender: boolean;
  /** Whether the sender is an owner for owner-only command surfaces. */
  senderIsOwner?: boolean;
  /** Gateway client scopes for internal control-plane callers */
  gatewayClientScopes?: string[];
  /** Host-resolved agent that owns the active session. */
  agentId?: string;
  /** Stable host session key for the active conversation when available. */
  sessionKey?: string;
  /** Ephemeral host session id for the active conversation when available. */
  sessionId?: string;
  /**
   * Deprecated transcript locator for the active OpenClaw session when available.
   *
   * SQLite-backed sessions use a `sqlite:<agentId>:<sessionId>:<storePath>`
   * marker, not a filesystem path. Use session id/key plus transcript-runtime
   * helpers for active transcript reads.
   *
   * @deprecated Use session identity fields with `plugin-sdk/session-transcript-runtime`.
   */
  sessionFile?: string;
  /** Raw command arguments after the command name */
  args?: string;
  /** The full normalized command body */
  commandBody: string;
  /** Current OpenClaw configuration */
  config: OpenClawConfig;
  /** Raw "From" value (channel-scoped id) */
  from?: string;
  /** Raw "To" value (channel-scoped id) */
  to?: string;
  /** Account id for multi-account channels */
  accountId?: string;
  /** Thread/topic id if available */
  messageThreadId?: string | number;
  /** Parent conversation id for thread-capable channels */
  threadParentId?: string;
  /** Sensitive diagnostics-only session inventory for owner-gated commands. */
  diagnosticsSessions?: PluginCommandDiagnosticsSession[];
  /** Host-bound runtime capabilities scoped to this command invocation. */
  runtimeContext?: {
    llm?: Pick<import("./runtime/types-core.js").PluginRuntimeCore["llm"], "complete">;
  };
  /** Internal diagnostics-only marker that exec approval already authorized upload. */
  diagnosticsUploadApproved?: boolean;
  /** Internal diagnostics-only marker to preview upload effects without exposing ids. */
  diagnosticsPreviewOnly?: boolean;
  /** Internal diagnostics-only marker for owner-private routed confirmations. */
  diagnosticsPrivateRouted?: boolean;
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

/**
 * Result returned by a plugin command handler.
 */
export type PluginCommandResult = ReplyPayload & {
  /** Allows the agent session to continue processing after the command. */
  continueAgent?: boolean;
  /** Suppresses channel fallback replies when the handler already delivered a response. */
  suppressReply?: boolean;
};

/**
 * Handler function for plugin commands.
 */
export type PluginCommandHandler = (
  ctx: PluginCommandContext,
) => PluginCommandResult | Promise<PluginCommandResult>;

/**
 * Definition for a plugin-registered command.
 */
export const AGENT_PROMPT_SURFACE_KINDS = [
  "openclaw_main",
  /** @deprecated Use openclaw_main. */
  "pi_main",
  "codex_app_server",
  "cli_backend",
  "acp_backend",
  "subagent",
] as const;

export type AgentPromptSurfaceKind = (typeof AGENT_PROMPT_SURFACE_KINDS)[number];

export type AgentPromptGuidanceEntry = {
  text: string;
  surfaces?: readonly AgentPromptSurfaceKind[];
};

export type AgentPromptGuidance = string | AgentPromptGuidanceEntry;

export type OpenClawPluginCommandDefinition = {
  /** Command name without leading slash (e.g., "tts") */
  name: string;
  /**
   * Optional native-command aliases for slash/menu surfaces.
   * `default` applies to all native providers unless a provider-specific
   * override exists (for example `{ default: "talkvoice", teamChat: "voice2" }`).
   */
  nativeNames?: Partial<Record<string, string>> & { default?: string };
  /**
   * Optional native progress placeholder text for native command surfaces.
   * `default` applies to all native providers unless a provider-specific
   * override exists.
   */
  nativeProgressMessages?: Partial<Record<string, string>> & {
    default?: string;
  };
  /** Description shown in /help and command menus */
  description: string;
  /** Localized descriptions for native command surfaces that support them. */
  descriptionLocalizations?: Record<string, string>;
  /**
   * Optional channel ids this command belongs to.
   * Omit to keep the command available on every channel surface.
   */
  channels?: readonly string[];
  /** Optional system-prompt guidance for agents when this command is registered. */
  agentPromptGuidance?: readonly AgentPromptGuidance[];
  /** Whether this command accepts arguments */
  acceptsArgs?: boolean;
  /** Whether only authorized senders can use this command (default: true) */
  requireAuth?: boolean;
  /** Operator scopes required by gateway clients; command owners may satisfy this on chat surfaces. */
  requiredScopes?: OperatorScope[];
  /** Whether a trusted bundled handler needs owner status for subcommand-level authorization. */
  exposeSenderIsOwner?: boolean;
  /**
   * Allows a bundled plugin to claim a command name that is otherwise reserved
   * by core. External plugins cannot use this field.
   */
  ownership?: "plugin" | "reserved";
  /** The handler function */
  handler: PluginCommandHandler;
};
