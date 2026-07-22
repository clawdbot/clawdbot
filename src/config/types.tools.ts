// Defines tool availability and allowlist configuration types.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../channels/chat-type.js";
import type { SafeBinProfileFixture } from "../infra/exec-safe-bin-policy.js";
import type { AgentModelConfig } from "./types.agents-shared.js";
import type { AgentElevatedAllowFromConfig, SessionSendPolicyAction } from "./types.base.js";
import type { ConfiguredProviderRequest } from "./types.provider-request.js";
export type { MemorySearchConfig } from "./types.memory.js";

export type MediaUnderstandingScopeMatch = {
  /** Channel/provider id to match before running media or link understanding. */
  channel?: string;
  /** Direct/group classification from the channel runtime, when available. */
  chatType?: ChatType;
  /** Attachment or link key prefix used for narrow per-source routing. */
  keyPrefix?: string;
};

export type MediaUnderstandingScopeRule = {
  /** Policy applied when match criteria select this scope rule. */
  action: SessionSendPolicyAction;
  /** Optional match filter; omitted match behaves as a catch-all rule. */
  match?: MediaUnderstandingScopeMatch;
};

export type MediaUnderstandingScopeConfig = {
  /** Fallback action when no scope rule matches. */
  default?: SessionSendPolicyAction;
  /** Ordered allow/block rules; first matching rule wins. */
  rules?: MediaUnderstandingScopeRule[];
};

export type MediaUnderstandingCapability = "image" | "audio" | "video";

export type MediaUnderstandingAttachmentsConfig = {
  /** Select the first matching attachment or process multiple. */
  mode?: "first" | "all";
  /** Max number of attachments to process (default: 1). */
  maxAttachments?: number;
  /** Attachment ordering preference. */
  prefer?: "first" | "last" | "path" | "url";
};

type MediaProviderRequestConfig = {
  /** Optional provider-specific query params (merged into requests). */
  providerOptions?: Record<string, Record<string, string | number | boolean>>;
  /** Optional base URL override for provider requests. */
  baseUrl?: string;
  /** Optional headers merged into provider requests. */
  headers?: Record<string, string>;
  /** Optional request transport overrides for provider HTTP calls. */
  request?: ConfiguredProviderRequest;
};

export type MediaUnderstandingModelConfig = MediaProviderRequestConfig & {
  /** provider API id (e.g. openai, google). */
  provider?: string;
  /** Model id for provider-based understanding. */
  model?: string;
  /** Optional capability tags for shared model lists. */
  capabilities?: MediaUnderstandingCapability[];
  /** Use a CLI command instead of provider API. */
  type?: "provider" | "cli";
  /** CLI binary (required when type=cli). */
  command?: string;
  /** CLI args (template-enabled). */
  args?: string[];
  /** Optional prompt override for this model entry. */
  prompt?: string;
  /** Optional max output characters for this model entry. */
  maxChars?: number;
  /** Optional max bytes for this model entry. */
  maxBytes?: number;
  /** Optional timeout override (seconds) for this model entry. */
  timeoutSeconds?: number;
  /** Optional language hint for audio transcription. */
  language?: string;
  /** Auth profile id to use for this provider. */
  profile?: string;
  /** Preferred profile id if multiple are available. */
  preferredProfile?: string;
};

export type MediaUnderstandingConfig = MediaProviderRequestConfig & {
  /** Enable media understanding when models are configured. */
  enabled?: boolean;
  /** Prefer a matching shared model entry. */
  preferredModel?: string;
  /** Optional scope gating for understanding. */
  scope?: MediaUnderstandingScopeConfig;
  /** Default max bytes to send. */
  maxBytes?: number;
  /** Default max output characters. */
  maxChars?: number;
  /** Default prompt. */
  prompt?: string;
  /** Internal request-scoped prompt override injected by CLI/runtime wrappers. */
  _requestPromptOverride?: string;
  /** Default timeout (seconds). */
  timeoutSeconds?: number;
  /** Default language hint (audio). */
  language?: string;
  /** Internal request-scoped language override injected by CLI/runtime wrappers. */
  _requestLanguageOverride?: string;
  /** Attachment selection policy. */
  attachments?: MediaUnderstandingAttachmentsConfig;
  /** Ordered model list (fallbacks in order). */
  models?: MediaUnderstandingModelConfig[];
  /**
   * Echo the audio transcript back to the originating chat before agent processing.
   * Lets users verify what was heard. Default: false.
   */
  echoTranscript?: boolean;
  /**
   * Format string for the echoed transcript. Use `{transcript}` as placeholder.
   * Default: '📝 "{transcript}"'
   */
  echoFormat?: string;
};

/** Per-capability defaults and policy. Models live only in tools.media.models. */
export type MediaUnderstandingCapabilityConfig = Omit<MediaUnderstandingConfig, "models">;

export type LinkModelConfig = {
  /** Use a CLI command for link processing. */
  type?: "cli";
  /** CLI binary (required when type=cli). */
  command: string;
  /** CLI args (template-enabled). */
  args?: string[];
  /** Optional timeout override (seconds) for this model entry. */
  timeoutSeconds?: number;
};

export type LinkToolsConfig = {
  /** Enable link understanding when models are configured. */
  enabled?: boolean;
  /** Optional scope gating for understanding. */
  scope?: MediaUnderstandingScopeConfig;
  /** Max number of links to process per message. */
  maxLinks?: number;
  /** Default timeout (seconds). */
  timeoutSeconds?: number;
  /** Ordered model list (fallbacks in order). */
  models?: LinkModelConfig[];
};

export type MediaToolsConfig = {
  /** Canonical model list for image/audio/video, selected by capability tags. */
  models?: MediaUnderstandingModelConfig[];
  /** Max concurrent media understanding runs. */
  concurrency?: number;
  image?: MediaUnderstandingCapabilityConfig;
  audio?: MediaUnderstandingCapabilityConfig;
  video?: MediaUnderstandingCapabilityConfig;
};

export type ToolProfileId = "minimal" | "coding" | "messaging" | "full";

export type ToolLoopDetectionConfig = {
  /** Enable tool-loop protection (default: false). */
  enabled?: boolean;
};

export type ToolSearchConfig =
  | boolean
  | {
      /** Enable compact search/call cataloging for large tool sets. */
      enabled?: boolean;
      /** Exposed model surface. "code" exposes tool_search_code; "tools" exposes structured fallback tools; "directory" keeps a bounded directory plus selected schemas visible while deferring the rest behind search/describe/call. */
      mode?: "code" | "tools" | "directory";
      /** Timeout in milliseconds for one tool_search_code execution. Runtime clamps to 1s..60s. */
      codeTimeoutMs?: number;
      /** Default search result count when the model omits a limit. Runtime clamps to maxSearchLimit. */
      searchDefaultLimit?: number;
      /** Maximum search result count. Runtime clamps to 1..50. */
      maxSearchLimit?: number;
    };

export type CodeModeConfig =
  | boolean
  | {
      /** Enable generic OpenClaw code mode. Default: false. */
      enabled?: boolean;
      /** Guest runtime. Only quickjs-wasi is supported. */
      runtime?: "quickjs-wasi";
      /** Model-facing mode. Only "only" is supported: expose exec/wait and hide normal tools. */
      mode?: "only";
      /** Accepted source languages. */
      languages?: Array<"javascript" | "typescript">;
      /** Wall-clock limit in milliseconds for one exec or wait call. */
      timeoutMs?: number;
      /** QuickJS heap limit in bytes. */
      memoryLimitBytes?: number;
      /** Maximum serialized output bytes. */
      maxOutputBytes?: number;
      /** Maximum serialized snapshot bytes. */
      maxSnapshotBytes?: number;
      /** Maximum concurrent nested tool calls. */
      maxPendingToolCalls?: number;
      /** Retention for suspended snapshots. */
      snapshotTtlSeconds?: number;
      /** Default search result count for tools.search. */
      searchDefaultLimit?: number;
      /** Maximum search result count for tools.search. */
      maxSearchLimit?: number;
    };

export type SwarmConfig =
  | boolean
  | {
      /** Enable collector-mode subagents and agents_wait. Default: false. */
      enabled?: boolean;
      /** Maximum concurrently running collector children per swarm group. */
      maxConcurrent?: number;
      /** Maximum live collector children per swarm group. */
      maxChildrenPerGroup?: number;
      /** Maximum lifetime collector spawns per swarm group. */
      maxTotalPerGroup?: number;
      /** Maximum agents_wait timeout in seconds. */
      waitTimeoutSecondsMax?: number;
      /** Default child agent id when sessions_spawn omits agentId. */
      defaultAgentId?: string;
    };

export type SessionsToolsVisibility = "self" | "tree" | "agent" | "all";

export type ToolAllowDenyPolicyConfig = {
  /** Exact tool names allowed in this policy scope. */
  allow?: string[];
  /** Additional allowlist entries merged into the inherited policy. */
  alsoAllow?: string[];
  /** Exact tool names denied after allow expansion; deny wins. */
  deny?: string[];
};

export type ToolPolicyConfig = ToolAllowDenyPolicyConfig & {
  /** Built-in profile used as the base policy before allow/deny merges. */
  profile?: ToolProfileId;
};

export type GroupToolPolicyConfig = ToolAllowDenyPolicyConfig;

export const TOOLS_BY_SENDER_KEY_TYPES = ["channel", "id", "e164", "username", "name"] as const;
export type ToolsBySenderKeyType = (typeof TOOLS_BY_SENDER_KEY_TYPES)[number];

export function parseToolsBySenderTypedKey(
  rawKey: string,
): { type: ToolsBySenderKeyType; value: string } | undefined {
  const trimmed = rawKey.trim();
  if (!trimmed) {
    return undefined;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  for (const type of TOOLS_BY_SENDER_KEY_TYPES) {
    const prefix = `${type}:`;
    if (!lowered.startsWith(prefix)) {
      continue;
    }
    // Preserve the original value casing after the typed prefix; usernames and
    // display names can be case-sensitive in channel-specific matching code.
    return {
      type,
      value: trimmed.slice(prefix.length),
    };
  }
  return undefined;
}

/**
 * Per-sender overrides.
 *
 * Prefer explicit key prefixes:
 * - channel:<channelId>:<senderId>
 * - id:<senderId>
 * - e164:<phone>
 * - username:<handle>
 * - name:<display-name>
 * - * (wildcard)
 *
 * Legacy unprefixed keys are supported for backward compatibility and are matched as senderId only.
 */
export type GroupToolPolicyBySenderConfig = Record<string, GroupToolPolicyConfig>;

export type ExecToolConfig = {
  /** Exec host routing (default: auto). */
  host?: "auto" | "sandbox" | "gateway" | "node";
  /** Normalized exec policy mode. Prefer this over raw security/ask knobs. */
  mode?: "deny" | "allowlist" | "ask" | "auto" | "full";
  /** Legacy exec security mode retained when no canonical mode can preserve policy. */
  security?: "deny" | "allowlist" | "full";
  /** Legacy exec ask mode retained when no canonical mode can preserve policy. */
  ask?: "off" | "on-miss" | "always";
  /** Default node binding for exec.host=node (node id/name). */
  node?: string;
  /** Directories to prepend to PATH when running exec (gateway/sandbox). */
  pathPrepend?: string[];
  /** Safe stdin-only binaries that can run without allowlist entries. */
  safeBins?: string[];
  /**
   * Require explicit approval for interpreter inline-eval forms (`python -c`, `node -e`, etc.).
   * Prevents silent allowlist reuse and allow-always persistence for those forms.
   */
  strictInlineEval?: boolean;
  /** Render parser-derived command highlights in exec approval prompts (default: false). */
  commandHighlighting?: boolean;
  /** Extra explicit directories trusted for safeBins path checks (never derived from PATH). */
  safeBinTrustedDirs?: string[];
  /** Optional custom safe-bin profiles for entries in tools.exec.safeBins. */
  safeBinProfiles?: Record<string, SafeBinProfileFixture>;
  /** Model-backed reviewer used by tools.exec.mode=auto before falling back to human approval. */
  reviewer?: {
    /** Optional reviewer model override (provider/model or agent model config). */
    model?: AgentModelConfig;
    /** Reviewer timeout in milliseconds (default: 30000). */
    timeoutMs?: number;
  };
  /** Default time (ms) before an exec command auto-backgrounds. */
  backgroundMs?: number;
  /** Default timeout (seconds) before auto-killing exec commands. */
  timeoutSeconds?: number;
  /** Emit a running notice (ms) when approval-backed exec runs long (default: 10000, 0 = off). */
  approvalRunningNoticeMs?: number;
  /** How long to keep finished sessions in memory (ms). */
  cleanupMs?: number;
  /** Emit a system event and heartbeat when a backgrounded exec exits. */
  notifyOnExit?: boolean;
  /**
   * Also emit success exit notifications when a backgrounded exec has no output.
   * Default false to reduce context noise.
   */
  notifyOnExitEmptySuccess?: boolean;
  /** apply_patch subtool configuration. */
  applyPatch?: {
    /** Enable apply_patch for OpenAI models (default: true; set false to disable). */
    enabled?: boolean;
    /**
     * Restrict apply_patch paths to the workspace directory.
     * Default: true (safer; does not affect read/write/edit).
     */
    workspaceOnly?: boolean;
    /**
     * Optional allowlist of model ids that can use apply_patch.
     * Accepts either raw ids (e.g. "gpt-5.4") or full ids (e.g. "openai/gpt-5.4").
     */
    allowModels?: string[];
  };
};

export type FsToolsConfig = {
  /**
   * Restrict filesystem tools (read/write/edit/apply_patch) to the agent workspace directory.
   * Default: false (unrestricted, matches legacy behavior).
   */
  workspaceOnly?: boolean;
};

export type SessionsSpawnToolsConfig = {
  attachments?: {
    /** Enable inline attachments for sessions_spawn. */
    enabled?: boolean;
    maxTotalBytes?: number;
    maxFiles?: number;
    maxFileBytes?: number;
    retainOnSessionKeep?: boolean;
  };
};

export type AgentToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
  /** Additional allowlist entries merged into allow and/or profile allowlist. */
  alsoAllow?: string[];
  deny?: string[];
  /** Optional tool policy overrides keyed by provider id or "provider/model". */
  byProvider?: Record<string, ToolPolicyConfig>;
  /** Per-sender tool policy overrides keyed by sender identity. */
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** Per-agent code mode override; merges over the top-level tools.codeMode config. */
  codeMode?: CodeModeConfig;
  /** Per-agent swarm override; merges over the top-level tools.swarm config. */
  swarm?: SwarmConfig;
  /** Per-agent elevated exec gate (can only further restrict global tools.elevated). */
  elevated?: {
    /** Enable or disable elevated mode for this agent (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Exec tool defaults for this agent. */
  exec?: ExecToolConfig;
  /** Filesystem tool path guards. */
  fs?: FsToolsConfig;
  /** Runtime loop detection for repetitive/ stuck tool-call patterns. */
  loopDetection?: ToolLoopDetectionConfig;
  /** Message tool configuration for this agent. */
  message?: MessageToolsConfig;
  sandbox?: {
    tools?: ToolAllowDenyPolicyConfig;
  };
};

export type ToolsConfig = {
  /** Base tool profile applied before allow/deny lists. */
  profile?: ToolProfileId;
  allow?: string[];
  /** Additional allowlist entries merged into allow and/or profile allowlist. */
  alsoAllow?: string[];
  deny?: string[];
  /** Optional tool policy overrides keyed by provider id or "provider/model". */
  byProvider?: Record<string, ToolPolicyConfig>;
  /** Per-sender tool policy overrides keyed by sender identity. */
  toolsBySender?: GroupToolPolicyBySenderConfig;
  web?: {
    search?: {
      /** Enable managed web_search and optional Codex-native web search. */
      enabled?: boolean;
      /** Search provider id. */
      provider?: string;
      /** Default search results count (1-10). */
      maxResults?: number;
      /** Timeout in seconds for search requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for search results. */
      cacheTtlMinutes?: number;
      /** Optional native Codex web search for Codex-capable models. */
      openaiCodex?: {
        /** Enable native Codex web search for eligible models. */
        enabled?: boolean;
        /** Prefer cached or explicitly request live access. Unrestricted Codex turns resolve cached to live. */
        mode?: "cached" | "live";
        /** Optional allowlist of domains passed to the native Codex tool. */
        allowedDomains?: string[];
        /** Optional Codex native search context size hint. */
        contextSize?: "low" | "medium" | "high";
        /** Optional approximate user location passed to the native Codex tool. */
        userLocation?: {
          country?: string;
          region?: string;
          city?: string;
          timezone?: string;
        };
      };
    };
    fetch?: {
      /** Enable web fetch tool (default: true). */
      enabled?: boolean;
      /** Web fetch fallback provider id. */
      provider?: string;
      /** Max characters to return from fetched content. */
      maxChars?: number;
      /** Hard cap for maxChars (tool or config), defaults to 50000. */
      maxCharsCap?: number;
      /** Max download size before truncation, defaults to 2000000. */
      maxResponseBytes?: number;
      /** Timeout in seconds for fetch requests. */
      timeoutSeconds?: number;
      /** Cache TTL in minutes for fetched content. */
      cacheTtlMinutes?: number;
      /** Maximum number of redirects to follow (default: 3). */
      maxRedirects?: number;
      /** Override User-Agent header for fetch requests. */
      userAgent?: string;
      /** Use Readability to extract main content (default: true). */
      readability?: boolean;
      /** Route web_fetch through a trusted HTTP(S) env proxy and let the proxy resolve DNS. Enable only when that proxy enforces outbound policy. */
      useTrustedEnvProxy?: boolean;
      /** SSRF policy configuration for web_fetch. */
      ssrfPolicy?: {
        /** Allow RFC 2544 benchmark range IPs (198.18.0.0/15) for fake-IP proxy compatibility (e.g., Clash TUN mode, Surge). */
        allowRfc2544BenchmarkRange?: boolean;
        /** Allow IPv6 Unique Local Addresses (fc00::/7) for trusted fake-IP proxy compatibility. */
        allowIpv6UniqueLocalRange?: boolean;
      };
    };
  };
  media?: MediaToolsConfig;
  links?: LinkToolsConfig;
  /** Message tool configuration. */
  message?: MessageToolsConfig;
  agentToAgent?: {
    /** Enable agent-to-agent messaging tools. Default: false. */
    enabled?: boolean;
    /** Allowlist of agent ids or patterns (implementation-defined). */
    allow?: string[];
  };
  /**
   * Session tool visibility controls which sessions can be targeted by session tools
   * (sessions_list, sessions_history, sessions_search, sessions_send).
   *
   * Default: "tree" (current session + spawned subagent sessions).
   */
  sessions?: {
    /**
     * - "self": only the current session
     * - "tree": current session + sessions spawned by this session (default)
     * - "agent": any session belonging to the current agent id (can include other users)
     * - "all": any session (cross-agent still requires tools.agentToAgent)
     */
    visibility?: SessionsToolsVisibility;
  };
  /** Elevated exec permissions for the host machine. */
  elevated?: {
    /** Enable or disable elevated mode (default: true). */
    enabled?: boolean;
    /** Approved senders for /elevated (per-provider allowlists). */
    allowFrom?: AgentElevatedAllowFromConfig;
  };
  /** Exec tool defaults. */
  exec?: ExecToolConfig;
  /** Filesystem tool path guards. */
  fs?: FsToolsConfig;
  /** Runtime loop detection for repetitive/ stuck tool-call patterns. */
  loopDetection?: ToolLoopDetectionConfig;
  /** Compact large OpenClaw, MCP, and client tool catalogs behind search/call tools. */
  toolSearch?: ToolSearchConfig;
  /** Generic code mode: expose exec/wait and hide normal tools behind a QuickJS catalog bridge. */
  codeMode?: CodeModeConfig;
  /** Collector-mode subagents and wait controls. */
  swarm?: SwarmConfig;
  /** sessions_spawn tool configuration. */
  sessions_spawn?: SessionsSpawnToolsConfig;
  /** Sub-agent tool policy defaults (deny wins). */
  subagents?: {
    tools?: ToolAllowDenyPolicyConfig;
  };
  /** Sandbox tool policy defaults (deny wins). */
  sandbox?: {
    tools?: ToolAllowDenyPolicyConfig;
  };
  /** Experimental tool flags. */
  experimental?: {
    /** Structured checklist tool; enabled by default. Set false to opt out. */
    planTool?: boolean;
  };
};

export type MessageToolsConfig = {
  crossContext?: {
    /** Allow sends to other channels within the same provider (default: true). */
    allowWithinProvider?: boolean;
    /** Allow sends across different providers (default: false). */
    allowAcrossProviders?: boolean;
    /** Cross-context marker configuration. */
    marker?: {
      /** Enable origin markers for cross-context sends (default: true). */
      enabled?: boolean;
      /** Text prefix template, supports {channel}. */
      prefix?: string;
      /** Text suffix template, supports {channel}. */
      suffix?: string;
    };
  };
  actions?: {
    /** Message action names exposed and accepted by the message tool. */
    allow?: string[];
  };
  broadcast?: {
    /** Enable broadcast action (default: true). */
    enabled?: boolean;
  };
};
