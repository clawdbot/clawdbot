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
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  resolveEffectiveToolPolicy,
  resolveGroupToolPolicy,
  resolveInheritedToolPolicyForSession,
  resolveSubagentToolPolicyForSession,
} from "../agent-tools.policy.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../embedded-agent-runner/run/types.js";
import { isCliRuntimeAliasForProvider } from "../model-runtime-aliases.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { resolveSenderToolPolicy } from "../sender-tool-policy.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "../subagent-capabilities.js";
import { expandToolGroups, normalizeToolName } from "../tool-policy.js";
import { createOpenClawAgentHarness } from "./builtin-openclaw.js";
import { MissingAgentHarnessError } from "./errors.js";
import { runAgentHarnessLifecycleAttempt } from "./lifecycle.js";
import {
  resolveAgentHarnessPolicy as resolveConfiguredAgentHarnessPolicy,
  type AgentHarnessPolicy,
} from "./policy.js";
import { getRegisteredAgentHarness, listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";

const log = createSubsystemLogger("agents/harness");
export { resolveAgentHarnessPolicy } from "./policy.js";
export type { AgentHarnessPolicy };

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
    // Provider-owned CLI runtime aliases have no agent harness plugin counterpart.
    | "cli_runtime_passthrough_openclaw"
    // Auto mode chose a registered plugin harness that supports the provider/model.
    | "auto_plugin"
    // Auto mode found no supporting plugin harness, so OpenClaw handled the run.
    | "auto_openclaw";
  candidates: AgentHarnessSelectionCandidate[];
};

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
}

export function resolveAvailableAgentHarnessPolicy(params: {
  provider?: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: NodeJS.ProcessEnv;
}): AgentHarnessPolicy {
  return applyAgentHarnessAvailabilityPolicy(resolveConfiguredAgentHarnessPolicy(params));
}

function applyAgentHarnessAvailabilityPolicy(policy: AgentHarnessPolicy): AgentHarnessPolicy {
  if (
    policy.runtime === "codex" &&
    policy.runtimeSource === "implicit" &&
    !getRegisteredAgentHarness("codex")
  ) {
    return {
      ...policy,
      runtime: "openclaw",
    };
  }
  return policy;
}

function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.harness.id.localeCompare(right.harness.id);
}

export function selectAgentHarness(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
}): AgentHarness {
  return selectAgentHarnessDecision(params).harness;
}

function selectAgentHarnessDecision(params: {
  provider: string;
  modelId?: string;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
}): AgentHarnessSelectionDecision {
  const resolvedPolicy = resolveConfiguredAgentHarnessPolicy(params);
  const runtimeOverride = normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const policy =
    runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)
      ? ({
          ...resolvedPolicy,
          runtime: runtimeOverride,
          runtimeSource: "model",
        } as AgentHarnessPolicy)
      : resolvedPolicy;
  // OpenClaw's built-in harness is intentionally not part of the plugin candidate list. Explicit plugin
  // runtimes fail closed; only `auto` may route an unmatched turn to OpenClaw.
  const pluginHarnesses = listPluginAgentHarnesses();
  const openClawHarness = createOpenClawAgentHarness();
  const runtime = policy.runtime;
  if (runtime === "openclaw") {
    return buildSelectionDecision({
      harness: openClawHarness,
      policy,
      selectedReason: "forced_openclaw",
      candidates: listHarnessCandidates(pluginHarnesses),
    });
  }
  if (runtime !== "auto") {
    const forced = pluginHarnesses.find((entry) => entry.id === runtime);
    if (forced) {
      const support = forced.supports({
        provider: params.provider,
        modelId: params.modelId,
        requestedRuntime: runtime,
      });
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

  const candidates = pluginHarnesses.map((harness) => ({
    harness,
    support: harness.supports({
      provider: params.provider,
      modelId: params.modelId,
      requestedRuntime: runtime,
    }),
  }));
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
  const activeTrace = getActiveDiagnosticTraceContext();
  const harnessTrace = freezeDiagnosticTraceContext(
    activeTrace ? createChildDiagnosticTraceContext(activeTrace) : createDiagnosticTraceContext(),
  );
  const selection = selectAgentHarnessDecision({
    provider: params.provider,
    modelId: params.modelId,
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    agentHarnessId: params.agentHarnessId,
    agentHarnessRuntimeOverride: params.agentHarnessRuntimeOverride,
  });
  const harness = selection.harness;
  const attemptParams =
    harness.id === "openclaw" ? params : applyPluginHarnessDenyAllToolPolicy(params);
  logAgentHarnessSelection(selection, {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  const runAttempt = () => runAgentHarnessLifecycleAttempt(harness, attemptParams);
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

function applyPluginHarnessDenyAllToolPolicy(
  params: EmbeddedRunAttemptParams,
): EmbeddedRunAttemptParams {
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

function resolvePluginHarnessDenyAllToolPolicyPrompt(
  params: EmbeddedRunAttemptParams,
): string | undefined {
  const { globalPolicy, globalProviderPolicy, agentPolicy, agentProviderPolicy } =
    resolveEffectiveToolPolicy({
      config: params.config,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      modelProvider: params.provider,
      modelId: params.modelId,
    });
  const messageProvider = params.messageProvider ?? params.messageChannel;
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
  const groupPolicy = resolveGroupToolPolicy(groupPolicyParams);
  const senderPolicy = resolveSenderToolPolicy({
    config: params.config,
    agentId: params.agentId,
    messageProvider,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
  });
  if (
    policyDeniesAllTools(senderPolicy) ||
    policyDeniesAllTools(resolveSenderScopedGroupToolPolicy(params, groupPolicyParams, groupPolicy))
  ) {
    return PLUGIN_HARNESS_SENDER_DENY_ALL_PROMPT;
  }
  if (policyDeniesAllTools(groupPolicy)) {
    return PLUGIN_HARNESS_GROUP_DENY_ALL_PROMPT;
  }
  const sandboxSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    sessionKey: sandboxSessionKey,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const subagentStore = resolveSubagentCapabilityStore(sandboxSessionKey, { cfg: params.config });
  const subagentPolicy =
    sandboxSessionKey &&
    isSubagentEnvelopeSession(sandboxSessionKey, {
      cfg: params.config,
      store: subagentStore,
    })
      ? resolveSubagentToolPolicyForSession(params.config, sandboxSessionKey, {
          store: subagentStore,
        })
      : undefined;
  const inheritedToolPolicy = resolveInheritedToolPolicyForSession(
    params.config,
    sandboxSessionKey,
    {
      store: subagentStore,
    },
  );
  return [
    globalPolicy,
    globalProviderPolicy,
    agentPolicy,
    agentProviderPolicy,
    sandboxPolicy,
    subagentPolicy,
    inheritedToolPolicy,
  ].some(policyDeniesAllTools)
    ? PLUGIN_HARNESS_RUNTIME_DENY_ALL_PROMPT
    : undefined;
}

function resolveSenderScopedGroupToolPolicy(
  params: EmbeddedRunAttemptParams,
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

function hasSenderIdentity(params: EmbeddedRunAttemptParams): boolean {
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
