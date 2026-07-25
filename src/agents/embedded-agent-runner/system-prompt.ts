/**
 * Builds and installs embedded-agent system prompts.
 */
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { SubagentDelegationMode } from "../../config/types.agent-defaults.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PreparedMemoryPromptSection } from "../../plugins/memory-state.js";
import type { AgentPromptSurfaceKind } from "../../plugins/types.js";
import type { ActiveProcessSessionReference } from "../bash-process-references.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers.js";
import type { AgentTool } from "../runtime/index.js";
import type { AgentSession } from "../sessions/index.js";
import { buildConfiguredAgentSystemPrompt } from "../system-prompt-config.js";
import type { ProviderSystemPromptContribution } from "../system-prompt-contribution.js";
import type { PromptMode, SilentReplyPromptMode } from "../system-prompt.types.js";
import type { EmbeddedSandboxInfo } from "./types.js";
import type { ReasoningLevel, ThinkLevel } from "./utils.js";

export function buildEmbeddedSystemPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  workspaceDir: string;
  defaultThinkLevel?: ThinkLevel;
  reasoningLevel?: ReasoningLevel;
  extraSystemPrompt?: string;
  ownerNumbers?: string[];
  ownerDisplay?: "raw" | "hash";
  ownerDisplaySecret?: string;
  reasoningTagHint: boolean;
  heartbeatPrompt?: string;
  skillsPrompt?: string;
  docsPath?: string;
  sourcePath?: string;
  ttsHint?: string;
  reactionGuidance?: {
    level: "minimal" | "extensive";
    channel: string;
  };
  workspaceNotes?: string[];
  /** Controls which hardcoded sections to include. Defaults to "full". */
  promptMode?: PromptMode;
  /** Controls the generic silent-reply section. Channel-aware prompts can set "none". */
  silentReplyPromptMode?: SilentReplyPromptMode;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Prompt-only strength for delegating non-trivial work through sub-agents. */
  subagentDelegationMode?: SubagentDelegationMode;
  /** Run-scoped Ultra behavior; independent from configured delegation preference. */
  proactiveSubagentOrchestration?: boolean;
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  /** Prompt surface controls runtime-specific fallback fragments. Defaults to OpenClaw main. */
  promptSurface?: AgentPromptSurfaceKind;
  /** Registered runtime slash/native command names such as `codex`. */
  nativeCommandNames?: string[];
  /** Plugin-owned prompt guidance for registered native slash commands. */
  nativeCommandGuidanceLines?: string[];
  runtimeInfo: {
    agentId?: string;
    sessionKey?: string;
    sessionId?: string;
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    capabilities?: string[];
    channel?: string;
    chatType?: ChatType;
    /** Supported message actions for the current channel (e.g., react, edit, unsend) */
    channelActions?: string[];
    activeProcessSessions?: ActiveProcessSessionReference[];
    activeNode?: string;
  };
  messageToolHints?: string[];
  toolSchemaDirectoryPrompt?: string;
  sandboxInfo?: EmbeddedSandboxInfo;
  /** Callable tool names used for capability guidance without adding them to the visible tool list. */
  capabilityToolNames?: string[];
  tools: AgentTool[];
  modelAliasLines?: string[];
  userTimezone: string;
  userTime?: string;
  userTimeFormat?: ResolvedTimeFormat;
  contextFiles?: EmbeddedContextFile[];
  bootstrapMode?: BootstrapMode;
  bootstrapTruncationNotice?: string;
  includeMemorySection?: boolean;
  memoryCitationsMode?: MemoryCitationsMode;
  preparedMemoryPrompt?: PreparedMemoryPromptSection;
  promptContribution?: ProviderSystemPromptContribution;
}): string {
  return buildConfiguredAgentSystemPrompt({
    config: params.config,
    agentId: params.agentId ?? params.runtimeInfo.agentId,
    workspaceDir: params.workspaceDir,
    defaultThinkLevel: params.defaultThinkLevel,
    reasoningLevel: params.reasoningLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    ownerNumbers: params.ownerNumbers,
    ownerDisplay: params.ownerDisplay,
    ownerDisplaySecret: params.ownerDisplaySecret,
    reasoningTagHint: params.reasoningTagHint,
    heartbeatPrompt: params.heartbeatPrompt,
    skillsPrompt: params.skillsPrompt,
    docsPath: params.docsPath,
    sourcePath: params.sourcePath,
    ttsHint: params.ttsHint,
    workspaceNotes: params.workspaceNotes,
    reactionGuidance: params.reactionGuidance,
    promptMode: params.promptMode,
    silentReplyPromptMode: params.silentReplyPromptMode,
    sourceReplyDeliveryMode: params.sourceReplyDeliveryMode,
    subagentDelegationMode: params.subagentDelegationMode,
    proactiveSubagentOrchestration: params.proactiveSubagentOrchestration,
    acpEnabled: params.acpEnabled,
    promptSurface: params.promptSurface,
    nativeCommandNames: params.nativeCommandNames,
    nativeCommandGuidanceLines: params.nativeCommandGuidanceLines,
    runtimeInfo: params.runtimeInfo,
    messageToolHints: params.messageToolHints,
    toolSchemaDirectoryPrompt: params.toolSchemaDirectoryPrompt,
    sandboxInfo: params.sandboxInfo,
    toolNames: params.tools.map((tool) => tool.name),
    capabilityToolNames: params.capabilityToolNames,
    modelAliasLines: params.modelAliasLines,
    userTimezone: params.userTimezone,
    userTime: params.userTime,
    userTimeFormat: params.userTimeFormat,
    contextFiles: params.contextFiles,
    bootstrapMode: params.bootstrapMode,
    bootstrapTruncationNotice: params.bootstrapTruncationNotice,
    includeMemorySection: params.includeMemorySection,
    memoryCitationsMode: params.memoryCitationsMode,
    preparedMemoryPrompt: params.preparedMemoryPrompt,
    promptContribution: params.promptContribution,
  });
}

export function applySystemPromptToSession(session: AgentSession, systemPrompt: string) {
  session.setBaseSystemPrompt(systemPrompt.trim());
}
