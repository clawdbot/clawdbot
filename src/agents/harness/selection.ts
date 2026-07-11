/**
 * Selects and invokes native agent harnesses for embedded run attempts.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProviderRefOwnership } from "../../plugins/providers.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveGroupToolPolicy } from "../agent-tools.policy.js";
import {
  isHostScopedAgentToolActive,
  runWithAgentRingZeroTools,
} from "../agent-tools.ring-zero-context.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import { isCliRuntimeAliasForProvider } from "../model-runtime-aliases.js";
import {
  unwrapModelHeaderSentinelsForProviderEgress,
  unwrapSecretSentinelsForProviderEgress,
} from "../provider-secret-egress.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { expandToolGroups, mergeAlsoAllowPolicy, normalizeToolName } from "../tool-policy.js";
import type { CrestodianToolOptions } from "../tools/crestodian-tool.js";
import { createOpenClawAgentHarness } from "./builtin-openclaw.js";
import { MissingAgentHarnessError } from "./errors.js";
import { runAgentHarnessLifecycleAttempt } from "./lifecycle.js";
import {
  resolveAgentHarnessPolicy as resolveConfiguredAgentHarnessPolicy,
  type AgentHarnessPolicy,
} from "./policy.js";
import { getRegisteredAgentHarness, listRegisteredAgentHarnesses } from "./registry.js";
import {
  buildAgentHarnessSupportContext,
  compareHarnessSupport,
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./support.js";
import type { AgentHarness, AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";

const log = createSubsystemLogger("agents/harness");
export { resolveAgentHarnessPolicy } from "./policy.js";
export type { AgentHarnessPolicy };

type AgentHarnessAvailabilityParams = {
  provider?: string;
  modelId?: string;
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
  preparedModelProvider?: boolean;
};

type AgentHarnessSelectionParams = {
  provider: string;
  modelId?: string;
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
};

type AgentHarnessSelectionDecisionParams = AgentHarnessSelectionParams & {
  /** Finalized route/auth facts must always pass harness support, including persisted pins. */
  preparedModelProvider?: boolean;
};

export type AgentHarnessPreparedModelProvider = NonNullable<
  AgentHarnessSupportContext["modelProvider"]
>;

type AgentHarnessAvailabilityDecision =
  | { kind: "available"; policy: AgentHarnessPolicy }
  | { kind: "implicit-unavailable"; policy: AgentHarnessPolicy }
  | { kind: "implicit-unsupported"; policy: AgentHarnessPolicy };

const PLUGIN_HARNESS_SENDER_DENY_ALL_PROMPT =
  "Tool and file actions are disabled for this sender by chat policy. If asked to edit files or use tools, say this sender is not allowed by policy; do not imply retrying will help.";
const PLUGIN_HARNESS_GROUP_DENY_ALL_PROMPT =
  "Tool and file actions are disabled for this chat by policy. If asked to edit files or use tools, say this chat is not allowed by policy.";
const PLUGIN_HARNESS_RUNTIME_DENY_ALL_PROMPT =
  "Tool and file actions are disabled by runtime policy. If asked to edit files or use tools, say tools are disabled by policy.";

type AgentHarnessSelectionCandidate = {
  id: string;
  label: string;
  pluginId?: string;
  supported?: boolean;
  priority?: number;
  reason?: string;
};

type AgentHarnessSelectionDecision = {
  harness: AgentHarness;
  policy: AgentHarnessPolicy;
  selectedHarnessId: string;
  selectedReason:
    | "forced_openclaw"
    | "forced_plugin"
    // Implicit Codex preference found no registered Codex harness, so OpenClaw handled the run.
    | "implicit_plugin_unavailable_openclaw"
    // Implicit Codex preference cannot reproduce the prepared transport, so OpenClaw handled it.
    | "implicit_plugin_unsupported_openclaw"
    // Provider-owned CLI runtime aliases have no agent harness plugin counterpart.
    | "cli_runtime_passthrough_openclaw"
    // Auto mode chose a registered plugin harness that supports the provider/model.
    | "auto_plugin"
    // Auto mode found no supporting plugin harness, so OpenClaw handled the run.
    | "auto_openclaw";
  candidates: AgentHarnessSelectionCandidate[];
};

type PluginHarnessToolPolicyContext = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "sessionKey"
  | "sandboxSessionKey"
  | "agentId"
  | "provider"
  | "modelId"
  | "messageProvider"
  | "messageChannel"
  | "spawnedBy"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "agentAccountId"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
>;

type PluginHarnessToolPolicy = { allow?: string[]; deny?: string[] };

type ResolvedPluginHarnessToolPolicies = {
  senderPolicy?: PluginHarnessToolPolicy;
  senderScopedGroupPolicy?: PluginHarnessToolPolicy;
  groupPolicy?: PluginHarnessToolPolicy;
  runtimePolicies: Array<PluginHarnessToolPolicy | undefined>;
};

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

export function resolveAvailableAgentHarnessPolicy(
  params: AgentHarnessAvailabilityParams,
): AgentHarnessPolicy {
  return resolveAgentHarnessAvailabilityDecision(params).policy;
}

function resolveAgentHarnessAvailabilityDecision(
  params: AgentHarnessAvailabilityParams,
): AgentHarnessAvailabilityDecision {
  const policy = resolveConfiguredAgentHarnessPolicy({
    ...params,
    modelApi: params.modelProvider?.api,
    modelBaseUrl: params.modelProvider?.baseUrl,
    requestTransportOverrides: params.modelProvider?.requestTransportOverrides,
  });
  if (policy.runtime !== "codex" || policy.runtimeSource !== "implicit") {
    return { kind: "available", policy };
  }
  const codexHarness = getRegisteredAgentHarness("codex");
  if (!codexHarness) {
    return {
      kind: "implicit-unavailable",
      policy: { ...policy, runtime: "openclaw" },
    };
  }
  const provider = params.provider?.trim();
  if (!provider) {
    return { kind: "available", policy };
  }
  const support = codexHarness.harness.supports(
    buildAgentHarnessSupportContext({
      provider,
      modelId: params.modelId,
      modelProvider: params.modelProvider,
      requestedRuntime: policy.runtime,
      config: params.config,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      preparedModelProvider: params.preparedModelProvider,
    }),
  );
  if (support.supported) {
    return { kind: "available", policy };
  }
  return {
    kind: "implicit-unsupported",
    policy: { ...policy, runtime: "openclaw" },
  };
}

export function selectAgentHarness(params: AgentHarnessSelectionParams): AgentHarness {
  return selectAgentHarnessDecision(params).harness;
}

/** Selects one harness that can preserve every prepared route/auth retry candidate. */
export function selectAgentHarnessForPreparedModelProviders(
  params: Omit<AgentHarnessSelectionParams, "modelProvider"> & {
    modelProviders: readonly AgentHarnessPreparedModelProvider[];
  },
): AgentHarness {
  const { modelProviders, ...selectionParams } = params;
  if (modelProviders.length === 0) {
    return selectAgentHarness(selectionParams);
  }
  const decisions = modelProviders.map((modelProvider) =>
    selectAgentHarnessDecision({
      ...selectionParams,
      modelProvider,
      preparedModelProvider: true,
    }),
  );
  const first = decisions[0];
  if (
    !first ||
    decisions.every((decision) => decision.selectedHarnessId === first.selectedHarnessId)
  ) {
    return first?.harness ?? selectAgentHarness(selectionParams);
  }
  // Only implicit/auto selection can produce different supported harnesses. One embedded
  // runtime owns the complete retry set; explicit and pinned plugins fail during probing above.
  return (
    decisions.find((decision) => decision.selectedHarnessId === "openclaw")?.harness ??
    createOpenClawAgentHarness()
  );
}

/** Returns whether a plugin harness constructs OpenClaw tools inside its runtime. */
export function agentHarnessBuildsOpenClawTools(harnessId: string): boolean {
  return harnessId === "codex" || harnessId === "copilot";
}

/** Returns whether the selected harness exposes OpenClaw's agent-tool surface. */
export function agentHarnessExposesOpenClawTools(harnessId: string): boolean {
  return harnessId === "openclaw" || agentHarnessBuildsOpenClawTools(harnessId);
}

function selectAgentHarnessDecision(
  params: AgentHarnessSelectionDecisionParams,
): AgentHarnessSelectionDecision {
  const pinnedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const runtimeOverride = normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const requestedRuntimeOverride = pinnedHarnessId ?? runtimeOverride;
  const selectedRuntimeOverride =
    requestedRuntimeOverride && !isDefaultAgentRuntimeId(requestedRuntimeOverride)
      ? requestedRuntimeOverride
      : undefined;
  // Persisted ownership and explicit model policy are already authoritative.
  // Avoid probing implicit harness support before those overrides are applied.
  const availability: AgentHarnessAvailabilityDecision = selectedRuntimeOverride
    ? {
        kind: "available",
        policy: resolveConfiguredAgentHarnessPolicy({
          ...params,
          modelApi: params.modelProvider?.api,
          modelBaseUrl: params.modelProvider?.baseUrl,
          requestTransportOverrides: params.modelProvider?.requestTransportOverrides,
        }),
      }
    : resolveAgentHarnessAvailabilityDecision(params);
  const resolvedPolicy = availability.policy;
  const policy = selectedRuntimeOverride
    ? ({
        ...resolvedPolicy,
        runtime: selectedRuntimeOverride,
        runtimeSource: "model",
      } as AgentHarnessPolicy)
    : resolvedPolicy;
  // OpenClaw's built-in harness is intentionally not part of the plugin candidate list. Explicit plugin
  // runtimes fail closed; only `auto` may route an unmatched turn to OpenClaw.
  const pluginHarnesses = listPluginAgentHarnesses();
  const openClawHarness = createOpenClawAgentHarness();
  const runtime = policy.runtime;
  if (runtime === "openclaw") {
    const selectedReason = selectedRuntimeOverride
      ? "forced_openclaw"
      : availability.kind === "implicit-unavailable"
        ? "implicit_plugin_unavailable_openclaw"
        : availability.kind === "implicit-unsupported"
          ? "implicit_plugin_unsupported_openclaw"
          : "forced_openclaw";
    return buildSelectionDecision({
      harness: openClawHarness,
      policy,
      selectedReason,
      candidates: listHarnessCandidates(pluginHarnesses),
    });
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      // A persisted harness owns the native transcript before route/auth preparation. The
      // finalized entrypoint sets preparedModelProvider and must always revalidate that owner.
      if (pinnedHarnessId === runtime && !params.preparedModelProvider) {
        return buildSelectionDecision({
          harness: forced,
          policy,
          selectedReason: "forced_plugin",
          candidates: listHarnessCandidates(pluginHarnesses),
        });
      }
      const supportContext = buildAgentHarnessSupportContext({
        provider: params.provider,
        modelId: params.modelId,
        modelProvider: params.modelProvider,
        requestedRuntime: runtime,
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        preparedModelProvider: params.preparedModelProvider,
        providerOwnership: resolveProviderRefOwnership({
          provider: params.provider,
          config: params.config,
        }),
      });
      const support = forced.supports(supportContext);
      if (support.supported) {
        return buildSelectionDecision({
          harness: forced,
          policy,
          selectedReason: "forced_plugin",
          candidates: listHarnessCandidates(pluginHarnesses),
        });
      }
      if (isCliRuntimeAliasForProvider({ runtime, provider: params.provider })) {
        return buildSelectionDecision({
          harness: openClawHarness,
          policy: {
            ...policy,
            runtime: "openclaw",
          },
          selectedReason: "cli_runtime_passthrough_openclaw",
          candidates: listHarnessCandidates(pluginHarnesses),
        });
      }
      throw new Error(
        `Requested agent harness "${runtime}" does not support ${formatProviderModel(params)}${
          support.reason ? ` (${support.reason})` : ""
        }.`,
      );
    }
    if (runtime === "codex" && policy.runtimeSource === "implicit") {
      return buildSelectionDecision({
        harness: openClawHarness,
        policy: {
          ...policy,
          runtime: "openclaw",
        },
        selectedReason: "implicit_plugin_unavailable_openclaw",
        candidates: listHarnessCandidates(pluginHarnesses),
      });
    }
    if (
      isCliRuntimeAliasForProvider({
        runtime,
        provider: params.provider,
        cfg: params.config,
      })
    ) {
      return buildSelectionDecision({
        harness: openClawHarness,
        policy: {
          ...policy,
          runtime: "openclaw",
        },
        selectedReason: "cli_runtime_passthrough_openclaw",
        candidates: listHarnessCandidates(pluginHarnesses),
      });
    }
    throw new MissingAgentHarnessError(runtime);
  }

  const candidates =
    pluginHarnesses.length > 0
      ? (() => {
          const supportContext = buildAgentHarnessSupportContext({
            provider: params.provider,
            modelId: params.modelId,
            modelProvider: params.modelProvider,
            requestedRuntime: runtime,
            config: params.config,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
            preparedModelProvider: params.preparedModelProvider,
            providerOwnership: resolveProviderRefOwnership({
              provider: params.provider,
              config: params.config,
            }),
          });
          return pluginHarnesses.map((harness) => ({
            harness,
            support: harness.supports(supportContext),
          }));
        })()
      : [];
  const supported = candidates
    .filter(
      (
        entry,
      ): entry is {
        harness: AgentHarness;
        support: AgentHarnessSupport & { supported: true };
      } => entry.support.supported,
    )
    .toSorted(compareHarnessSupport);

  const selected = supported[0]?.harness;
  if (selected) {
    return buildSelectionDecision({
      harness: selected,
      policy,
      selectedReason: "auto_plugin",
      candidates: candidates.map(toSelectionCandidate),
    });
  }
  return buildSelectionDecision({
    harness: openClawHarness,
    policy,
    selectedReason: "auto_openclaw",
    candidates: candidates.map(toSelectionCandidate),
  });
}

export async function runAgentHarnessAttempt(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const internalParams = params as EmbeddedRunAttemptParams & {
    crestodianTool?: CrestodianToolOptions;
  };
  const activeTrace = getActiveDiagnosticTraceContext();
  const harnessTrace = freezeDiagnosticTraceContext(
    activeTrace ? createChildDiagnosticTraceContext(activeTrace) : createDiagnosticTraceContext(),
  );
  const selection = selectAgentHarnessDecision({
    provider: params.provider,
    modelId: params.modelId,
    modelProvider: {
      api: params.model.api,
      baseUrl: params.model.baseUrl,
      ...resolveAgentHarnessPreparedRouteSupport(params.runtimePlan?.auth),
      preparedAuth: resolveAgentHarnessPreparedAuthSupport({ plan: params.runtimePlan?.auth }),
    },
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
    preparedModelProvider: params.runtimePlan?.auth !== undefined,
  });
  const harness = selection.harness;
  if (internalParams.crestodianTool && !isCrestodianOnlyAllowlist(internalParams.toolsAllow)) {
    throw new Error('Crestodian host authority requires toolsAllow: ["crestodian"]');
  }
  const ringZeroTools = internalParams.crestodianTool
    ? [
        (await import("../tools/crestodian-tool.js")).createCrestodianTool(
          internalParams.crestodianTool,
        ),
      ]
    : [];
  const pluginParams = withoutInternalHarnessAuthority(internalParams);
  logAgentHarnessSelection(selection, {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const runAttempt = () =>
    runWithAgentRingZeroTools(ringZeroTools, () => {
      // Resolve plugin policy after entering the host scope. Ring-zero tools are
      // trusted setup authority and must survive ordinary deny-all policy.
      const attemptParams =
        harness.id === "openclaw" ? pluginParams : preparePluginHarnessParams(pluginParams);
      return runAgentHarnessLifecycleAttempt(harness, attemptParams);
    });
  if (harness.id === "openclaw") {
    return await runWithDiagnosticTraceContext(harnessTrace, runAttempt);
  }

  try {
    return await runWithDiagnosticTraceContext(harnessTrace, runAttempt);
  } catch (error) {
    log.warn(`${harness.label} failed; not falling back to embedded OpenClaw backend`, {
      harnessId: harness.id,
      provider: params.provider,
      modelId: params.modelId,
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

function isCrestodianOnlyAllowlist(toolsAllow: readonly string[] | undefined): boolean {
  return toolsAllow?.length === 1 && normalizeToolName(toolsAllow[0] ?? "") === "crestodian";
}

function withoutInternalHarnessAuthority(
  params: EmbeddedRunAttemptParams & { crestodianTool?: CrestodianToolOptions },
): EmbeddedRunAttemptParams {
  if (!Object.hasOwn(params, "crestodianTool")) {
    return params;
  }
  const { crestodianTool: _crestodianTool, ...pluginParams } = params;
  return pluginParams;
}

function preparePluginHarnessParams(params: EmbeddedRunAttemptParams): EmbeddedRunAttemptParams {
  const boundary = "plugin harness handoff";
  const resolvedApiKey = params.resolvedApiKey
    ? unwrapSecretSentinelsForProviderEgress(params.resolvedApiKey, boundary)
    : params.resolvedApiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(params.model, boundary);
  if (model === params.model && resolvedApiKey === params.resolvedApiKey) {
    return applyPluginHarnessDenyAllToolPolicy(params);
  }
  return applyPluginHarnessDenyAllToolPolicy({
    ...params,
    model,
    resolvedApiKey,
  });
}

function applyPluginHarnessDenyAllToolPolicy(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
  if (
    isHostScopedAgentToolActive("crestodian") &&
    params.toolsAllow?.length === 1 &&
    normalizeToolName(params.toolsAllow[0] ?? "") === "crestodian"
  ) {
    return params;
  }
  const prompt = resolvePluginHarnessDenyAllToolPolicyPrompt(params);
  if (!prompt) {
    return params;
  }
  return {
    ...params,
    toolsAllow: [],
    extraSystemPrompt: appendPluginHarnessToolPolicyPrompt(params.extraSystemPrompt, prompt),
  };
}

export function resolvePluginHarnessPolicyToolsAllow(
  params: PluginHarnessToolPolicyContext,
): [] | undefined {
  const policies = resolvePluginHarnessToolPolicies(params);
  return [policies.senderPolicy, policies.groupPolicy, ...policies.runtimePolicies].some(
    policyRestrictsNativeTools,
  )
    ? []
    : undefined;
}

function resolvePluginHarnessDenyAllToolPolicyPrompt(
  params: PluginHarnessToolPolicyContext,
): string | undefined {
  const policies = resolvePluginHarnessToolPolicies(params);
  if (
    policyDeniesAllTools(policies.senderPolicy) ||
    policyDeniesAllTools(policies.senderScopedGroupPolicy)
  ) {
    return PLUGIN_HARNESS_SENDER_DENY_ALL_PROMPT;
  }
  if (policyDeniesAllTools(policies.groupPolicy)) {
    return PLUGIN_HARNESS_GROUP_DENY_ALL_PROMPT;
  }
  return policies.runtimePolicies.some(policyDeniesAllTools)
    ? PLUGIN_HARNESS_RUNTIME_DENY_ALL_PROMPT
    : undefined;
}

function resolvePluginHarnessToolPolicies(
  params: PluginHarnessToolPolicyContext,
): ResolvedPluginHarnessToolPolicies {
  const messageProvider = params.messageProvider ?? params.messageChannel;
  const sandboxSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.config,
    sessionKey: params.sessionKey,
    sandboxSessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
    modelId: params.modelId,
    messageProvider,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
  });
  const groupPolicyParams = {
    config: params.config,
    sessionKey: params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.agentAccountId,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  };
  const { policy } = capabilityProfile;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: sandboxSessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  return {
    senderPolicy: policy.senderPolicy,
    senderScopedGroupPolicy: resolveSenderScopedGroupToolPolicy(
      params,
      groupPolicyParams,
      policy.groupPolicy,
    ),
    groupPolicy: policy.groupPolicy,
    runtimePolicies: [
      mergeAlsoAllowPolicy(policy.profilePolicy, policy.profileAlsoAllow),
      mergeAlsoAllowPolicy(policy.providerProfilePolicy, policy.providerProfileAlsoAllow),
      policy.globalPolicy,
      policy.globalProviderPolicy,
      policy.agentPolicy,
      policy.agentProviderPolicy,
      sandboxPolicy,
      policy.subagentPolicy,
      policy.inheritedToolPolicy,
    ],
  };
}

function resolveSenderScopedGroupToolPolicy(
  params: PluginHarnessToolPolicyContext,
  groupPolicyParams: Parameters<typeof resolveGroupToolPolicy>[0],
  groupPolicy: { deny?: string[] } | undefined,
): { deny?: string[] } | undefined {
  if (!policyDeniesAllTools(groupPolicy) || !hasSenderIdentity(params)) {
    return undefined;
  }
  const groupPolicyWithoutSender = resolveGroupToolPolicy({
    ...groupPolicyParams,
    senderId: undefined,
    senderName: undefined,
    senderUsername: undefined,
    senderE164: undefined,
  });
  return policyDeniesAllTools(groupPolicyWithoutSender) ? undefined : groupPolicy;
}

function hasSenderIdentity(params: PluginHarnessToolPolicyContext): boolean {
  return Boolean(
    params.senderId?.trim() ||
    params.senderName?.trim() ||
    params.senderUsername?.trim() ||
    params.senderE164?.trim(),
  );
}

function appendPluginHarnessToolPolicyPrompt(existing: string | undefined, prompt: string): string {
  const trimmed = existing?.trim();
  if (!trimmed) {
    return prompt;
  }
  return trimmed.includes(prompt) ? trimmed : `${trimmed}\n\n${prompt}`;
}

function policyDeniesAllTools(policy?: { deny?: string[] }): boolean {
  return expandToolGroups(policy?.deny ?? []).some((entry) => normalizeToolName(entry) === "*");
}

function policyRestrictsNativeTools(policy?: PluginHarnessToolPolicy): boolean {
  if (!policy) {
    return false;
  }
  const deniesAnyTool = expandToolGroups(policy.deny ?? []).some((entry) =>
    Boolean(normalizeToolName(entry)),
  );
  if (deniesAnyTool) {
    return true;
  }
  return (
    Array.isArray(policy.allow) &&
    policy.allow.length > 0 &&
    !expandToolGroups(policy.allow).some((entry) => normalizeToolName(entry) === "*")
  );
}

function listHarnessCandidates(harnesses: AgentHarness[]): AgentHarnessSelectionCandidate[] {
  return harnesses.map((harness) => ({
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
  }));
}

function toSelectionCandidate(entry: {
  harness: AgentHarness;
  support: AgentHarnessSupport;
}): AgentHarnessSelectionCandidate {
  return {
    id: entry.harness.id,
    label: entry.harness.label,
    pluginId: entry.harness.pluginId,
    supported: entry.support.supported,
    priority: entry.support.supported ? entry.support.priority : undefined,
    reason: entry.support.reason,
  };
}

function buildSelectionDecision(params: {
  harness: AgentHarness;
  policy: AgentHarnessPolicy;
  selectedReason: AgentHarnessSelectionDecision["selectedReason"];
  candidates: AgentHarnessSelectionCandidate[];
}): AgentHarnessSelectionDecision {
  return {
    harness: params.harness,
    policy: params.policy,
    selectedHarnessId: params.harness.id,
    selectedReason: params.selectedReason,
    candidates: params.candidates,
  };
}

function logAgentHarnessSelection(
  selection: AgentHarnessSelectionDecision,
  params: { provider: string; modelId?: string; sessionKey?: string; agentId?: string },
) {
  if (!log.isEnabled("debug")) {
    return;
  }
  log.debug("agent harness selected", {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    selectedHarnessId: selection.selectedHarnessId,
    selectedReason: selection.selectedReason,
    runtime: selection.policy.runtime,
    candidates: selection.candidates,
  });
}

function formatProviderModel(params: { provider: string; modelId?: string }): string {
  return params.modelId ? `${params.provider}/${params.modelId}` : params.provider;
}
