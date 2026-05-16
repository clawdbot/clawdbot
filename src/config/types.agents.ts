import type { ChatType } from "../channels/chat-type.js";
import type {
  AgentContextLimitsConfig,
  AgentDefaultsConfig,
  AgentModelEntryConfig,
  EmbeddedPiExecutionContract,
  SubagentDelegationMode,
} from "./types.agent-defaults.js";
import type {
  AgentEmbeddedHarnessConfig,
  AgentModelConfig,
  AgentRuntimePolicyConfig,
  AgentSandboxConfig,
} from "./types.agents-shared.js";
import type { DmScope, HumanDelayConfig, IdentityConfig } from "./types.base.js";
import type { GroupChatConfig } from "./types.messages.js";
import type { SkillsLimitsConfig } from "./types.skills.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";
import type { TtsConfig } from "./types.tts.js";

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
  session?: {
    /** Optional session scoping override for conversations matched by this binding. */
    dmScope?: DmScope;
  };
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
  /** Optional per-agent agent runtime policy override. */
  agentRuntime?: AgentRuntimePolicyConfig;
  /** @deprecated Use agentRuntime. */
  embeddedHarness?: AgentEmbeddedHarnessConfig;
  model?: AgentModelConfig;
  /** Per-model metadata overrides for this agent. */
  models?: Record<string, AgentModelEntryConfig>;
  /** @deprecated Legacy per-agent compaction config is kept for raw doctor migration/repair. */
  compaction?: AgentDefaultsConfig["compaction"];
  /** Optional per-agent default thinking level (overrides agents.defaults.thinkingDefault). */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max";
  /** Optional per-agent default verbosity level. */
  verboseDefault?: "off" | "on" | "full";
  /** Optional per-agent tool progress detail mode. */
  toolProgressDetail?: AgentDefaultsConfig["toolProgressDetail"];
  /** Optional per-agent default reasoning visibility. */
  reasoningDefault?: "on" | "off" | "stream";
  /** Optional per-agent default for fast mode. */
  fastModeDefault?: boolean;
  /** Optional per-agent bootstrap/context injection mode override. */
  contextInjection?: AgentDefaultsConfig["contextInjection"];
  /** Optional per-agent max chars for each injected bootstrap file. */
  bootstrapMaxChars?: AgentDefaultsConfig["bootstrapMaxChars"];
  /** Optional per-agent max total chars across injected bootstrap files. */
  bootstrapTotalMaxChars?: AgentDefaultsConfig["bootstrapTotalMaxChars"];
  /** Optional allowlist of skills for this agent; omitting it inherits agents.defaults.skills when set, and an explicit list replaces defaults instead of merging. */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent TTS overrides, deep-merged over messages.tts. */
  tts?: TtsConfig;
  /** Optional per-agent skills subsystem overrides. */
  skillsLimits?: Pick<SkillsLimitsConfig, "maxSkillsPromptChars">;
  /** Optional per-agent overrides for selected context/token-heavy limits. */
  contextLimits?: AgentContextLimitsConfig;
  contextTokens?: number;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Prompt-only guidance for how strongly this agent should delegate work. */
    delegationMode?: SubagentDelegationMode;
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig;
    /** Require explicit agentId in sessions_spawn (no default same-as-caller). */
    requireAgentId?: boolean;
  };
  /** Optional outer run loop retry boundaries. */
  runRetries?: AgentDefaultsConfig["runRetries"];
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
