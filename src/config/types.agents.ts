import type { ChatType } from "../channels/chat-type.js";
import type { AgentDefaultsConfig, EmbeddedPiExecutionContract } from "./types.agent-defaults.js";
import type {
  AgentEmbeddedHarnessConfig,
  AgentModelConfig,
  AgentSandboxConfig,
} from "./types.agents-shared.js";
import type { HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentRuntimeAcpConfig = {
  /** ACP harness adapter id (for example codex, claude). */
  agent?: string;
  /** Optional ACP backend override for this agent runtime. */
  backend?: string;
  /** Optional ACP session mode override. */
  mode?: "persistent" | "oneshot";
  /** Optional runtime working directory override. */
  cwd?: string;
};

export type AgentRuntimeConfig =
  | {
      type: "embedded";
    }
  | {
      type: "acp";
      acp?: AgentRuntimeAcpConfig;
    };

export type AgentBindingMatch = {
  channel: string;
  accountId?: string;
  peer?: { kind: ChatType; id: string };
  guildId?: string;
  teamId?: string;
  /** Discord role IDs used for role-based routing. */
  roles?: string[];
};

export type AgentRouteBinding = {
  /** Missing type is interpreted as route for backward compatibility. */
  type?: "route";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
};

export type AgentAcpBinding = {
  type: "acp";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  acp?: {
    mode?: "persistent" | "oneshot";
    label?: string;
    cwd?: string;
    backend?: string;
  };
};

export type AgentBinding = AgentRouteBinding | AgentAcpBinding;

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  /** Optional per-agent full system prompt replacement. */
  systemPromptOverride?: AgentDefaultsConfig["systemPromptOverride"];
  /** Optional per-agent embedded harness policy override. */
  embeddedHarness?: AgentEmbeddedHarnessConfig;
  model?: AgentModelConfig;
  /** Optional per-agent default thinking level (overrides agents.defaults.thinkingDefault). */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";
  /** Optional per-agent default verbosity level. */
  verboseDefault?: "off" | "on" | "full";
  /** Optional per-agent default reasoning visibility. */
  reasoningDefault?: "on" | "off" | "stream";
  /** Optional per-agent default for fast mode. */
  fastModeDefault?: boolean;
  /** Optional allowlist of skills for this agent; omitting it inherits agents.defaults.skills when set, and an explicit list replaces defaults instead of merging. */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). */
    requireAgentId?: boolean;
  };
  /** Optional per-agent embedded Pi overrides. */
  embeddedPi?: {
    /** Optional per-agent execution contract override. */
    executionContract?: EmbeddedPiExecutionContract;
  };
  /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig;
  /** Optional per-agent stream params (e.g. cacheRetention, temperature). */
  params?: Record<string, unknown>;
  tools?: AgentToolsConfig;
  /** Optional runtime descriptor for this agent. */
  runtime?: AgentRuntimeConfig;
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};
