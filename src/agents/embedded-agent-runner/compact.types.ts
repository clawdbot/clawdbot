import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ReasoningLevel, ThinkLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import type { CommandQueueEnqueueFn } from "../../process/command-queue.types.js";
import type { SkillSnapshot } from "../../skills/types.js";
import type { ExecElevatedDefaults, ExecToolDefaults } from "../bash-tools.exec-types.js";
import type { AgentRuntimePlan } from "../runtime-plan/types.js";

export type CompactEmbeddedAgentSessionParams = {
  sessionId: string;
  runId?: string;
  sessionKey?: string;
  /** Caller-resolved owner agent for global session aliases. */
  agentId?: string;
  /** Session key used only for runtime policy/sandbox resolution. Defaults to sessionKey. */
  sandboxSessionKey?: string;
  messageChannel?: string;
  messageProvider?: string;
  agentAccountId?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  /** Trusted sender id from inbound context for scoped message-tool discovery. */
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  authProfileId?: string;
  /** Host-resolved provider credential for native harness compaction. */
  resolvedApiKey?: string;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent policy inheritance. */
  spawnedBy?: string | null;
  sessionFile: string;
  /** Optional caller-observed live prompt tokens used for compaction diagnostics. */
  currentTokenCount?: number;
  workspaceDir: string;
  /** Optional task working directory; workspaceDir remains the agent bootstrap workspace. */
  cwd?: string;
  agentDir?: string;
  config?: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  provider?: string;
  model?: string;
  /** Effective model fallback chain for this session attempt. Undefined uses config defaults. */
  modelFallbacksOverride?: string[];
  /** Optional caller-resolved context engine for harness-owned compaction. */
  contextEngine?: ContextEngine;
  /** Optional caller-resolved token budget for harness-owned compaction. */
  contextTokenBudget?: number;
  /** Optional caller-resolved runtime context for harness-owned context-engine compaction. */
  contextEngineRuntimeContext?: ContextEngineRuntimeContext;
  /** Session-pinned embedded harness id. Prevents compaction hot-switching. */
  agentHarnessId?: string;
  /** OpenClaw-owned runtime policy prepared for this compaction path. */
  runtimePlan?: AgentRuntimePlan;
  thinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  execOverrides?: Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
  bashElevated?: ExecElevatedDefaults;
  customInstructions?: string;
  tokenBudget?: number;
  force?: boolean;
  /** Force compaction because the caller already determined this turn must compact before prompt submission. */
  forcePreflight?: boolean;
  /** Alias for forcePreflight used by preflight budget gates. */
  preflightRequired?: boolean;
  /** Diagnostic trigger that made preflight compaction mandatory. */
  preflightCompactionTrigger?: "tokens" | "transcript_bytes";
  trigger?: "budget" | "overflow" | "manual";
  /**
   * Preflight callers can allow native/current-session harness compaction but
   * move plugin-owned budget compaction onto background turn maintenance.
   */
  deferOwningContextEngineCompaction?: boolean;
  diagId?: string;
  attempt?: number;
  maxAttempts?: number;
  lane?: string;
  enqueue?: CommandQueueEnqueueFn;
  extraSystemPrompt?: string;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  ownerNumbers?: string[];
  abortSignal?: AbortSignal;
  onCompactionHookMessages?: (payload: {
    phase: "before" | "after";
    messages: string[];
    sessionId: string;
    sessionKey: string;
  }) => void | Promise<void>;
  /** Allow runtime plugins for this compaction to late-bind the gateway subagent. */
  allowGatewaySubagentBinding?: boolean;
};

export type CompactionMessageMetrics = {
  messages: number;
  historyTextChars: number;
  toolResultChars: number;
  estTokens?: number;
  contributors: Array<{ role: string; chars: number; tool?: string }>;
};
