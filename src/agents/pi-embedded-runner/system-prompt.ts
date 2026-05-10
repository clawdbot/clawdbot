import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { SubagentDelegationMode } from "../../config/types.agent-defaults.js";
import type { MemoryCitationsMode } from "../../config/types.memory.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ActiveProcessSessionReference } from "../bash-process-references.js";
import type { BootstrapMode } from "../bootstrap-mode.js";
import type { ResolvedTimeFormat } from "../date-time.js";
import type { EmbeddedContextFile } from "../pi-embedded-helpers.js";
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
  /** Whether ACP-specific routing guidance should be included. Defaults to true. */
  acpEnabled?: boolean;
  /** Registered runtime slash/native command names such as `codex`. */
  nativeCommandNames?: string[];
  /** Plugin-owned prompt guidance for registered native slash commands. */
  nativeCommandGuidanceLines?: string[];
  runtimeInfo: {
    agentId?: string;
    host: string;
    os: string;
    arch: string;
    node: string;
    model: string;
    provider?: string;
    capabilities?: string[];
    channel?: string;
    /** Supported message actions for the current channel (e.g., react, edit, unsend) */
    channelActions?: string[];
    activeProcessSessions?: ActiveProcessSessionReference[];
  };
  messageToolHints?: string[];
  sandboxInfo?: EmbeddedSandboxInfo;
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
    acpEnabled: params.acpEnabled,
    nativeCommandNames: params.nativeCommandNames,
    nativeCommandGuidanceLines: params.nativeCommandGuidanceLines,
    runtimeInfo: params.runtimeInfo,
    messageToolHints: params.messageToolHints,
    sandboxInfo: params.sandboxInfo,
    toolNames: params.tools.map((tool) => tool.name),
    modelAliasLines: params.modelAliasLines,
    userTimezone: params.userTimezone,
    userTime: params.userTime,
    userTimeFormat: params.userTimeFormat,
    contextFiles: params.contextFiles,
    bootstrapMode: params.bootstrapMode,
    bootstrapTruncationNotice: params.bootstrapTruncationNotice,
    includeMemorySection: params.includeMemorySection,
    memoryCitationsMode: params.memoryCitationsMode,
    promptContribution: params.promptContribution,
  });
}

export function createSystemPromptOverride(
  systemPrompt: string,
): (defaultPrompt?: string) => string {
  const override = systemPrompt.trim();
  return (_defaultPrompt?: string) => override;
}

export function applySystemPromptOverrideToSession(
  session: AgentSession,
  override: string | ((defaultPrompt?: string) => string),
) {
  const prompt = typeof override === "function" ? override() : override.trim();
  session.agent.state.systemPrompt = prompt;
  const mutableSession = session as unknown as {
    _baseSystemPrompt?: string;
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
  };
  mutableSession._baseSystemPrompt = prompt;
  mutableSession._rebuildSystemPrompt = () => prompt;
}
