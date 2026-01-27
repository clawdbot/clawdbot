import {
  codingTools,
  createEditTool,
  createReadTool,
  createWriteTool,
  readTool,
} from "@mariozechner/pi-coding-agent";
import type { MoltbotConfig } from "../config/config.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { createApplyPatchTool } from "./apply-patch.js";
import {
  createExecTool,
  createProcessTool,
  type ExecToolDefaults,
  type ProcessToolDefaults,
} from "./bash-tools.js";
import { listChannelAgentTools } from "./channel-tools.js";
import { createMoltbotTools } from "./moltbot-tools.js";
import type { ModelAuthMode } from "./model-auth.js";
import { wrapToolWithAbortSignal } from "./pi-tools.abort.js";
import {
  filterToolsByPolicy,
  isToolAllowedByPolicies,
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveSubagentToolPolicy,
} from "./pi-tools.policy.js";
import {
  assertRequiredParams,
  CLAUDE_PARAM_GROUPS,
  createMoltbotReadTool,
  createSandboxedEditTool,
  createSandboxedReadTool,
  createSandboxedWriteTool,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
} from "./pi-tools.read.js";
import { cleanToolSchemaForGemini, normalizeToolParameters } from "./pi-tools.schema.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxContext } from "./sandbox.js";
import {
  buildPluginToolGroups,
  collectExplicitAllowlist,
  expandPolicyWithPluginGroups,
  normalizeToolName,
  resolveToolProfilePolicy,
  stripPluginOnlyAllowlist,
} from "./tool-policy.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { logWarn } from "../logger.js";

function isOpenAIProvider(provider?: string) {
  const normalized = provider?.trim().toLowerCase();
  return normalized === "openai" || normalized === "openai-codex";
}

function isApplyPatchAllowedForModel(params: {
  modelProvider?: string;
  modelId?: string;
  allowModels?: string[];
}) {
  const allowModels = Array.isArray(params.allowModels) ? params.allowModels : [];
  if (allowModels.length === 0) return true;
  const modelId = params.modelId?.trim();
  if (!modelId) return false;
  const normalizedModelId = modelId.toLowerCase();
  const provider = params.modelProvider?.trim().toLowerCase();
  const normalizedFull =
    provider && !normalizedModelId.includes("/")
      ? `${provider}/${normalizedModelId}`
      : normalizedModelId;
  return allowModels.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    return normalized === normalizedModelId || normalized === normalizedFull;
  });
}

function resolveExecConfig(cfg: MoltbotConfig | undefined) {
  const globalExec = cfg?.tools?.exec;
  return {
    host: globalExec?.host,
    security: globalExec?.security,
    ask: globalExec?.ask,
    node: globalExec?.node,
    pathPrepend: globalExec?.pathPrepend,
    safeBins: globalExec?.safeBins,
    backgroundMs: globalExec?.backgroundMs,
    timeoutSec: globalExec?.timeoutSec,
    approvalRunningNoticeMs: globalExec?.approvalRunningNoticeMs,
    cleanupMs: globalExec?.cleanupMs,
    notifyOnExit: globalExec?.notifyOnExit,
    applyPatch: globalExec?.applyPatch,
  };
}

export const __testing = {
  cleanToolSchemaForGemini,
  normalizeToolParams,
  patchToolSchemaForClaudeCompatibility,
  wrapToolParamNormalization,
  assertRequiredParams,
} as const;

export function createMoltbotCodingTools(options?: {
  exec?: ExecToolDefaults & ProcessToolDefaults;
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  sandbox?: SandboxContext | null;
  sessionKey?: string;
  agentDir?: string;
  workspaceDir?: string;
  config?: MoltbotConfig;
  abortSignal?: AbortSignal;
  /**
   * Provider of the currently selected model (used for provider-specific tool quirks).
   * Example: "anthropic", "openai", "google", "openai-codex".
   */
  modelProvider?: string;
  /** Model id for the current provider (used for model-specific tool gating). */
  modelId?: string;
  /**
   * Auth mode for the current provider. We only need this for Anthropic OAuth
   * tool-name blocking quirks.
   */
  modelAuthMode?: ModelAuthMode;
  /** Current channel ID for auto-threading (Slack). */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading (Slack). */
  currentThreadTs?: string;
  /** Group id for channel-level tool policy resolution. */
  groupId?: string | null;
  /** Group channel label (e.g. #general) for channel-level tool policy resolution. */
  groupChannel?: string | null;
  /** Group space label (e.g. guild/team id) for channel-level tool policy resolution. */
  groupSpace?: string | null;
  /** Parent session key for subagent group policy inheritance. */
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  /** Reply-to mode for Slack auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
  /** If true, the model has native vision capability */
  modelHasVision?: boolean;
}): AnyAgentTool[] {
  const execToolName = "exec";
  const sandbox = options?.sandbox?.enabled ? options.sandbox : undefined;
  const {
    agentId,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    profile,
    providerProfile,
    profileAlsoAllow,
    providerProfileAlsoAllow,
  } = resolveEffectiveToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    modelProvider: options?.modelProvider,
    modelId: options?.modelId,
  });
  const groupPolicy = resolveGroupToolPolicy({
    config: options?.config,
    sessionKey: options?.sessionKey,
    spawnedBy: options?.spawnedBy,
    messageProvider: options?.messageProvider,
    groupId: options?.groupId,
    groupChannel: options?.groupChannel,
    groupSpace: options?.groupSpace,
    accountId: options?.agentAccountId,
    senderId: options?.senderId,
    senderName: options?.senderName,
    senderUsername: options?.senderUsername,
    senderE164: options?.senderE164,
  });
  const profilePolicy = resolveToolProfilePolicy(profile);
  const providerProfilePolicy = resolveToolProfilePolicy(providerProfile);

  const mergeAlsoAllow = (policy: typeof profilePolicy, alsoAllow?: string[]) => {
    if (!policy?.allow || !Array.isArray(alsoAllow) || alsoAllow.length === 0) return policy;
    return { ...policy, allow: Array.from(new Set([...policy.allow, ...alsoAllow])) };
  };

  const profilePolicyWithAlsoAllow = mergeAlsoAllow(profilePolicy, profileAlsoAllow);
  const providerProfilePolicyWithAlsoAllow = mergeAlsoAllow(
    providerProfilePolicy,
    providerProfileAlsoAllow,
  );
  const scopeKey = options?.exec?.scopeKey ?? (agentId ? `agent:${agentId}` : undefined);
  const subagentPolicy =
    isSubagentSessionKey(options?.sessionKey) && options?.sessionKey
      ? resolveSubagentToolPolicy(options.config)
      : undefined;
  const allowBackground = isToolAllowedByPolicies("process", [
    profilePolicyWithAlsoAllow,
    providerProfilePolicyWithAlsoAllow,
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    groupPolicy,
    sandbox?.tools,
    subagentPolicy,
  ]);
  const execConfig = resolveExecConfig(options?.config);
  const sandboxRoot = sandbox?.workspaceDir;
  const allowWorkspaceWrites = sandbox?.workspaceAccess !== "ro";
  const workspaceRoot = options?.workspaceDir ?? process.cwd();
  const applyPatchConfig = options?.config?.tools?.exec?.applyPatch;
  const applyPatchEnabled =
    !!applyPatchConfig?.enabled &&
    isOpenAIProvider(options?.modelProvider) &&
    isApplyPatchAllowedForModel({
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      allowModels: applyPatchConfig?.allowModels,
    });

  const base = (codingTools as unknown as AnyAgentTool[]).flatMap((tool) => {
    if (tool.name === readTool.name) {
      if (sandboxRoot) {
        return [createSandboxedReadTool(sandboxRoot)];
      }
      const freshReadTool = createReadTool(workspaceRoot);
      return [createMoltbotReadTool(freshReadTool)];
    }
    if (tool.name === "bash" || tool.name === execToolName) return [];
    if (tool.name === "write") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [
        wrapToolParamNormalization(createWriteTool(workspaceRoot), CLAUDE_PARAM_GROUPS.write),
      ];
    }
    if (tool.name === "edit") {
      if (sandboxRoot) return [];
      // Wrap with param normalization for Claude Code compatibility
      return [wrapToolParamNormalization(createEditTool(workspaceRoot), CLAUDE_PARAM_GROUPS.edit)];
    }
    return [tool as AnyAgentTool];
  });
  const { cleanupMs: cleanupMsOverride, ...execDefaults } = options?.exec ?? {};
  const execTool = createExecTool({
    ...execDefaults,
    host: options?.exec?.host ?? execConfig.host,
    security: options?.exec?.security ?? execConfig.security,
    ask: options?.exec?.ask ?? execConfig.ask,
    node: options?.exec?.node ?? execConfig.node,
    pathPrepend: options?.exec?.pathPrepend ?? execConfig.pathPrepend,
    safeBins: options?.exec?.safeBins ?? execConfig.safeBins,
    agentId,
    cwd: options?.workspaceDir,
    allowBackground,
    scopeKey,
    sessionKey: options?.sessionKey,
    messageProvider: options?.messageProvider,
    backgroundMs: options?.exec?.backgroundMs ?? execConfig.backgroundMs,
    timeoutSec: options?.exec?.timeoutSec ?? execConfig.timeoutSec,
    approvalRunningNoticeMs:
      options?.exec?.approvalRunningNoticeMs ?? execConfig.approvalRunningNoticeMs,
    notifyOnExit: options?.exec?.notifyOnExit ?? execConfig.notifyOnExit,
    sandbox: sandbox
      ? {
          containerName: sandbox.containerName,
          workspaceDir: sandbox.workspaceDir,
          containerWorkdir: sandbox.containerWorkdir,
          env: sandbox.docker.env,
        }
      : undefined,
  });
  const processTool = createProcessTool({
    cleanupMs: cleanupMsOverride ?? execConfig.cleanupMs,
    scopeKey,
  });
  const applyPatchTool =
    !applyPatchEnabled || (sandboxRoot && !allowWorkspaceWrites)
      ? null
      : createApplyPatchTool({
          cwd: sandboxRoot ?? workspaceRoot,
          sandboxRoot: sandboxRoot && allowWorkspaceWrites ? sandboxRoot : undefined,
        });
  const tools: AnyAgentTool[] = [
    ...base,
    ...(sandboxRoot
      ? allowWorkspaceWrites
        ? [createSandboxedEditTool(sandboxRoot), createSandboxedWriteTool(sandboxRoot)]
        : []
      : []),
    ...(applyPatchTool ? [applyPatchTool as unknown as AnyAgentTool] : []),
    execTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
    // Channel docking: include channel-defined agent tools (login, etc.).
    ...listChannelAgentTools({ cfg: options?.config }),
    ...createMoltbotTools({
      sandboxBrowserBridgeUrl: sandbox?.browser?.bridgeUrl,
      allowHostBrowserControl: sandbox ? sandbox.browserAllowHostControl : true,
      agentSessionKey: options?.sessionKey,
      agentChannel: resolveGatewayMessageChannel(options?.messageProvider),
      agentAccountId: options?.agentAccountId,
      agentTo: options?.messageTo,
      agentThreadId: options?.messageThreadId,
      agentGroupId: options?.groupId ?? null,
      agentGroupChannel: options?.groupChannel ?? null,
      agentGroupSpace: options?.groupSpace ?? null,
      agentDir: options?.agentDir,
      sandboxRoot,
      workspaceDir: options?.workspaceDir,
      sandboxed: !!sandbox,
      config: options?.config,
      pluginToolAllowlist: collectExplicitAllowlist([
        profilePolicy,
        providerProfilePolicy,
        globalPolicy,
        globalProviderPolicy,
        agentPolicy,
        agentProviderPolicy,
        groupPolicy,
        sandbox?.tools,
        subagentPolicy,
      ]),
      currentChannelId: options?.currentChannelId,
      currentThreadTs: options?.currentThreadTs,
      replyToMode: options?.replyToMode,
      hasRepliedRef: options?.hasRepliedRef,
      modelHasVision: options?.modelHasVision,
      requesterAgentIdOverride: agentId,
    }),
  ];
  const coreToolNames = new Set(
    tools
      .filter((tool) => !getPluginToolMeta(tool as AnyAgentTool))
      .map((tool) => normalizeToolName(tool.name))
      .filter(Boolean),
  );
  const pluginGroups = buildPluginToolGroups({
    tools,
    toolMeta: (tool) => getPluginToolMeta(tool as AnyAgentTool),
  });
  const resolvePolicy = (policy: typeof profilePolicy, label: string) => {
    const resolved = stripPluginOnlyAllowlist(policy, pluginGroups, coreToolNames);
    if (resolved.unknownAllowlist.length > 0) {
      const entries = resolved.unknownAllowlist.join(", ");
      const suffix = resolved.strippedAllowlist
        ? "Ignoring allowlist so core tools remain available. Use tools.alsoAllow for additive plugin tool enablement."
        : "These entries won't match any tool unless the plugin is enabled.";
      logWarn(`tools: ${label} allowlist contains unknown entries (${entries}). ${suffix}`);
    }
    return expandPolicyWithPluginGroups(resolved.policy, pluginGroups);
  };
  const profilePolicyExpanded = resolvePolicy(
    profilePolicyWithAlsoAllow,
    profile ? `tools.profile (${profile})` : "tools.profile",
  );
  const providerProfileExpanded = resolvePolicy(
    providerProfilePolicyWithAlsoAllow,
    providerProfile ? `tools.byProvider.profile (${providerProfile})` : "tools.byProvider.profile",
  );
  const globalPolicyExpanded = resolvePolicy(globalPolicy, "tools.allow");
  const globalProviderExpanded = resolvePolicy(globalProviderPolicy, "tools.byProvider.allow");
  const agentPolicyExpanded = resolvePolicy(
    agentPolicy,
    agentId ? `agents.${agentId}.tools.allow` : "agent tools.allow",
  );
  const agentProviderExpanded = resolvePolicy(
    agentProviderPolicy,
    agentId ? `agents.${agentId}.tools.byProvider.allow` : "agent tools.byProvider.allow",
  );
  const groupPolicyExpanded = resolvePolicy(groupPolicy, "group tools.allow");
  const sandboxPolicyExpanded = expandPolicyWithPluginGroups(sandbox?.tools, pluginGroups);
  const subagentPolicyExpanded = expandPolicyWithPluginGroups(subagentPolicy, pluginGroups);

  const toolsFiltered = profilePolicyExpanded
    ? filterToolsByPolicy(tools, profilePolicyExpanded)
    : tools;
  const providerProfileFiltered = providerProfileExpanded
    ? filterToolsByPolicy(toolsFiltered, providerProfileExpanded)
    : toolsFiltered;
  const globalFiltered = globalPolicyExpanded
    ? filterToolsByPolicy(providerProfileFiltered, globalPolicyExpanded)
    : providerProfileFiltered;
  const globalProviderFiltered = globalProviderExpanded
    ? filterToolsByPolicy(globalFiltered, globalProviderExpanded)
    : globalFiltered;
  const agentFiltered = agentPolicyExpanded
    ? filterToolsByPolicy(globalProviderFiltered, agentPolicyExpanded)
    : globalProviderFiltered;
  const agentProviderFiltered = agentProviderExpanded
    ? filterToolsByPolicy(agentFiltered, agentProviderExpanded)
    : agentFiltered;
  const groupFiltered = groupPolicyExpanded
    ? filterToolsByPolicy(agentProviderFiltered, groupPolicyExpanded)
    : agentProviderFiltered;
  const sandboxed = sandboxPolicyExpanded
    ? filterToolsByPolicy(groupFiltered, sandboxPolicyExpanded)
    : groupFiltered;
  const subagentFiltered = subagentPolicyExpanded
    ? filterToolsByPolicy(sandboxed, subagentPolicyExpanded)
    : sandboxed;
  // Always normalize tool JSON Schemas before handing them to pi-agent/pi-ai.
  // Without this, some providers (notably OpenAI) will reject root-level union schemas.
  const normalized = subagentFiltered.map(normalizeToolParameters);
  const withAbort = options?.abortSignal
    ? normalized.map((tool) => wrapToolWithAbortSignal(tool, options.abortSignal))
    : normalized;

  // NOTE: Keep canonical (lowercase) tool names here.
  // pi-ai's Anthropic OAuth transport remaps tool names to Claude Code-style names
  // on the wire and maps them back for tool dispatch.
  return withAbort;
}
