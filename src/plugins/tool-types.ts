// Defines plugin tool metadata and filesystem policy types.
import type { ConversationRecallContext } from "../agents/conversation-recall.types.js";
import type { ToolFsPolicy } from "../agents/tool-fs-policy.types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { ConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HookEntry } from "../hooks/types.js";
import type {
  MemoryReadResult,
  MemorySearchResult,
  MemorySource,
} from "../memory-host-sdk/host/types.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

export type OpenClawPluginActiveModelContext = {
  provider?: string;
  modelId?: string;
  modelRef?: string;
};

/** A generic, model-safe denial returned by the host-owned memory read broker. */
export type AuthorizedMemoryReadUnavailable = Readonly<{
  disabled: true;
  unavailable: true;
  error: "memory unavailable";
}>;

/** A scoped search hit whose continuation is valid only for this tool invocation. */
export type AuthorizedMemoryReadSearchResult = Readonly<
  MemorySearchResult & {
    /** Opaque, revision-bound continuation; never a filesystem path or namespace. */
    handleId: string;
  }
>;

/**
 * Host-owned, selected-runtime-only read capability. Plugins cannot construct
 * it or convert arbitrary paths into reads; an opaque continuation comes from
 * a prior authorized search in the same invocation.
 */
export type AuthorizedMemoryReadHost = Readonly<{
  search: (params: {
    query: string;
    sources?: readonly MemorySource[];
    limit?: number;
    signal?: AbortSignal;
  }) => Promise<
    | Readonly<{ results: readonly AuthorizedMemoryReadSearchResult[] }>
    | AuthorizedMemoryReadUnavailable
  >;
  read: (params: {
    handleId: string;
    from?: number;
    lines?: number;
  }) => Promise<MemoryReadResult | AuthorizedMemoryReadUnavailable>;
}>;

/** Trusted execution context passed to plugin-owned agent tool factories. */
export type OpenClawPluginToolContext = {
  config?: OpenClawConfig;
  /** Active runtime-resolved config snapshot when one is available. */
  runtimeConfig?: OpenClawConfig;
  /** Returns the latest runtime-resolved config snapshot for long-lived tool definitions. */
  getRuntimeConfig?: () => OpenClawConfig | undefined;
  /** Effective filesystem policy for the active tool run. */
  fsPolicy?: ToolFsPolicy;
  workspaceDir?: string;
  agentDir?: string;
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID - regenerated on /new and /reset. Use for per-conversation isolation. */
  sessionId?: string;
  /** Out-of-band plugin-owned bindings attached by the current run initiator. */
  toolBindings?: Readonly<Record<string, unknown>>;
  /** Host-prepared repository identities for project-aware tool behavior. */
  activeProjectKeys?: readonly string[];
  /** Trusted runtime-only authorization for one bounded cross-conversation recall pass. */
  conversationRecall?: ConversationRecallContext;
  /** True when legacy memory surfaces are disabled for this agent's completed cutover. */
  memoryReadEnforced?: true;
  /** Host-owned authorized-read capability for the selected memory runtime. */
  authorizedMemoryRead?: AuthorizedMemoryReadHost;
  /**
   * Runtime-supplied active model metadata for informational use, diagnostics,
   * and plugin-owned policy decisions. This is not a security boundary against
   * the local operator, installed plugin code, or a modified OpenClaw runtime.
   */
  activeModel?: OpenClawPluginActiveModelContext;
  browser?: {
    sandboxBridgeUrl?: string;
    allowHostControl?: boolean;
  };
  messageChannel?: string;
  agentAccountId?: string;
  /** Trusted provider auth availability from the active auth profile store. */
  hasAuthForProvider?: (providerId: string) => boolean;
  /** Resolves an API key from the active auth profile store when available. */
  resolveApiKeyForProvider?: (providerId: string) => Promise<string | undefined>;
  /** Trusted ambient delivery route for the active agent/session. */
  deliveryContext?: DeliveryContext;
  /** Trusted platform-native conversation id for the active inbound turn. */
  nativeChannelId?: string;
  /** Trusted sender id from inbound context (runtime-provided, not tool args). */
  requesterSenderId?: string;
  /** Trusted owner bit from inbound context (runtime-provided, not tool args). */
  senderIsOwner?: boolean;
  /**
   * Server-owned origin for this operation. Missing values are delegated.
   * Plugins must use it only for conversation-read visibility policy.
   */
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  sandboxed?: boolean;
  /**
   * True for explicit one-shot local CLI runs that must release plugin-owned
   * process resources before the command exits.
   */
  oneShotCliRun?: boolean;
};

export type OpenClawPluginToolFactory = (
  ctx: OpenClawPluginToolContext,
) => AnyAgentTool | AnyAgentTool[] | null | undefined;

export type OpenClawPluginToolOptions = {
  name?: string;
  names?: string[];
  optional?: boolean;
};

export type OpenClawPluginHookOptions = {
  entry?: HookEntry;
  name?: string;
  description?: string;
  register?: boolean;
};
