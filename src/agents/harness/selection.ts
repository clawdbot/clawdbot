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
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import { resolveGroupToolPolicy } from "../agent-tools.policy.js";
import {
  isHostScopedAgentToolActive,
  runWithAgentRingZeroTools,
} from "../agent-tools.ring-zero-context.js";
import { isHeartbeatLifecycleRunKind } from "../bootstrap-mode.js";
import { resolveConversationCapabilityProfile } from "../conversation-capability-profile.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
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
import { isKnownCoreToolId } from "../tool-catalog.js";
import {
  expandToolGroups,
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  toolPolicyRestrictsTools,
} from "../tool-policy.js";
import type { SystemAgentToolOptions } from "../tools/system-agent-tool.js";
import { copyCoreTtsAttemptResultProvenance } from "../tools/tts-tool-result-provenance.js";
import { resolveAgentHarnessAutoSelectionHint } from "./auto-selection.js";
import { resolveAgentHarnessAvailabilityDecision } from "./availability.js";
import { createOpenClawAgentHarness, isBuiltInOpenClawAgentHarness } from "./builtin-openclaw.js";
import { selectContextEngineForTranscriptHost } from "./context-engine-logical-turn.js";
import { drainPendingContextEngineTurnsBeforeRun } from "./context-engine-turn-attempt.js";
import { AgentHarnessPreflightError, MissingAgentHarnessError } from "./errors.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import {
  runAgentHarnessLifecycleAttempt,
  runAgentHarnessLifecycleFinalization,
} from "./lifecycle.js";
import type { AgentHarnessPolicy } from "./policy.js";
import { listRegisteredAgentHarnesses, resolveAgentHarnessOwnerPluginId } from "./registry.js";
import {
  buildAgentHarnessSupportContext,
  compareHarnessSupport,
  resolveAgentHarnessPreparedAuthSupport,
  resolveAgentHarnessPreparedRouteSupport,
} from "./support.js";
import type { AgentHarness, AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";

const log = createSubsystemLogger("agents/harness");
export { resolveAvailableAgentHarnessPolicy } from "./availability.js";

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
  builtIn: boolean;
  /** Registry-owned identity; absent only for the built-in runtime. */
  ownerPluginId?: string;
  policy: AgentHarnessPolicy;
  selectedHarnessId: string;
  selectedReason:
    | "forced_openclaw"
    | "forced_plugin"
    // Implicit Codex preference found no registered Codex harness, so OpenClaw handled the run.
    | "implicit_plugin_unavailable_openclaw"
    // Implicit Codex preference cannot reproduce the prepared transport, so OpenClaw handled it.
    | "implicit_plugin_unsupported_openclaw"
    // The requested plugin declared OpenClaw as a lossless fallback for this prepared request.
    | "plugin_declared_fallback_openclaw"
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
  | "sessionId"
  | "sessionKey"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "agentId"
  | "provider"
  | "modelId"
  | "messageProvider"
  | "messageChannel"
  | "conversationToolPolicy"
  | "spawnedBy"
  | "groupId"
  | "groupChannel"
  | "groupSpace"
  | "memberRoleIds"
  | "agentAccountId"
  | "senderId"
  | "senderName"
  | "senderUsername"
  | "senderE164"
  | "senderIsOwner"
  | "inputProvenance"
  | "trustedInternalHandoff"
  | "scheduledToolPolicy"
  | "runtimePluginToolGrant"
  | "toolsAllow"
  | "disableTools"
  | "swarmCollector"
>;

type PluginHarnessToolPolicy = { allow?: string[]; deny?: string[] };

type ResolvedPluginHarnessToolPolicies = {
  senderPolicy?: PluginHarnessToolPolicy;
  senderScopedGroupPolicy?: PluginHarnessToolPolicy;
  groupPolicy?: PluginHarnessToolPolicy;
  runtimePolicies: Array<PluginHarnessToolPolicy | undefined>;
  safeDeniedToolNames: string[];
  toolPolicyRestricted: boolean;
};

function listPluginAgentHarnesses(): AgentHarness[] {
  return listRegisteredAgentHarnesses().map((entry) => entry.harness);
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
  // One embedded runtime owns the complete retry set. Auto selection and plugin-declared
  // fallbacks may resolve individual prepared routes to different harnesses.
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
  // Keep the probed instance: owner validation must reject replacement during supports().
  const pluginHarnesses = listPluginAgentHarnesses();
  const availability = resolveAgentHarnessAvailabilityDecision({
    ...params,
    resolveProviderOwnership: () =>
      resolveProviderRefOwnership({
        provider: params.provider,
        config: params.config,
      }),
  });
  const policy = availability.policy;
  // OpenClaw's built-in harness is intentionally not part of the plugin candidate list. Explicit plugin
  // runtimes fail closed unless the selected plugin declares OpenClaw as a lossless fallback.
  const openClawHarness = createOpenClawAgentHarness();
  const runtime = policy.runtime;
  if (runtime === "openclaw") {
    const selectedReason =
      availability.kind === "implicit-unavailable"
        ? "implicit_plugin_unavailable_openclaw"
        : availability.kind === "implicit-unsupported"
          ? "implicit_plugin_unsupported_openclaw"
          : availability.kind === "declared-fallback"
            ? "plugin_declared_fallback_openclaw"
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
      const support = availability.support;
      if (!support || support.supported || support.fallbackRuntime === "openclaw") {
        if (support && !support.supported) {
          log.info(
            `agent harness selected requested=${runtime} selected=${forced.id} reason=private_qa_forced_runtime`,
          );
        }
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

  const hintedCandidates = pluginHarnesses.map((harness) => ({
    harness,
    support: resolveAgentHarnessAutoSelectionHint({ harness, provider: params.provider }),
  }));
  const candidates = hintedCandidates.some((entry) => entry.support === undefined)
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
        return hintedCandidates.map(({ harness, support }) => ({
          harness,
          support: support ?? harness.supports(supportContext),
        }));
      })()
    : hintedCandidates.map(({ harness, support }) => ({
        harness,
        support: support as AgentHarnessSupport,
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

/** Runs the selected harness's fail-closed settled-turn finalization operation. */
export async function runAgentHarnessSettledTurnFinalization(
  params: EmbeddedRunAttemptParams,
  settledAttempt: EmbeddedRunAttemptResult,
  harness: AgentHarness,
) {
  const internalParams = params as EmbeddedRunAttemptParams & {
    systemAgentTool?: SystemAgentToolOptions;
  };
  const finalizeSettledTurn = harness.finalizeSettledTurn?.bind(harness);
  if (!finalizeSettledTurn) {
    throw new Error(`Agent harness ${harness.id} cannot safely finalize a settled tool turn.`);
  }
  if (internalParams.systemAgentTool && !isSystemAgentOnlyAllowlist(internalParams.toolsAllow)) {
    throw new Error('OpenClaw host authority requires toolsAllow: ["openclaw"]');
  }
  const attemptParams = prepareHarnessFinalizationParams(
    {
      ...internalParams,
      operation: "settled-tool-finalization",
    },
    isBuiltInOpenClawAgentHarness(harness),
  );
  return await runAgentHarnessOperation(harness, params, () =>
    runWithAgentRingZeroTools([], () =>
      runAgentHarnessLifecycleFinalization(harness, attemptParams, () =>
        finalizeSettledTurn({ attempt: attemptParams, settledAttempt }),
      ),
    ),
  );
}

export async function runAgentHarnessAttempt(
  params: EmbeddedRunAttemptParams,
  nativeSessionRuntime?: import("../embedded-agent-runner/run/model-setup.js").PreparedNativeSessionRuntime,
): Promise<EmbeddedRunAttemptResult> {
  let internalParams = params as EmbeddedRunAttemptParams & {
    systemAgentTool?: SystemAgentToolOptions;
  };
  if (nativeSessionRuntime) {
    await nativeSessionRuntime.assertCurrent();
  }
  // A bound native connection owns the real route. Outer model config cannot
  // redirect its transcript or credentials through a second support decision.
  const selection =
    nativeSessionRuntime?.auth === "native"
      ? buildSelectionDecision({
          harness: nativeSessionRuntime.harness,
          policy: { runtime: nativeSessionRuntime.harness.id, runtimeSource: "model" },
          selectedReason: "forced_plugin",
          candidates: [],
        })
      : selectPreparedAgentHarness(params);
  const harness = selection.harness;
  if (nativeSessionRuntime && harness !== nativeSessionRuntime.harness) {
    throw new AgentHarnessPreflightError(
      "Native session runtime changed before dispatch. Reattach the original native session before retrying.",
    );
  }
  if (internalParams.contextEngineLogicalTurnLease) {
    selectContextEngineForTranscriptHost({
      lease: internalParams.contextEngineLogicalTurnLease,
      host: {
        id: `agent-harness:${harness.id}`,
        label: `agent harness "${harness.id}"`,
        capabilities: harness.contextEngineHostCapabilities ?? [],
      },
      operation: "agent-run",
      recorder: internalParams.userTurnTranscriptRecorder,
    });
    await drainPendingContextEngineTurnsBeforeRun({
      admission: internalParams.userTurnTranscriptRecorder?.getAdmissionReceipt(),
      isHeartbeat: isHeartbeatLifecycleRunKind(internalParams.bootstrapContextRunKind),
      lease: internalParams.contextEngineLogicalTurnLease,
      recorder: internalParams.userTurnTranscriptRecorder,
      sessionTarget: internalParams.sessionTarget,
    });
    const effective = internalParams.contextEngineLogicalTurnLease.begin();
    internalParams = {
      ...internalParams,
      contextEngine: effective.engine.info.id === "legacy" ? undefined : effective.engine,
    };
  }
  if (internalParams.systemAgentTool && !isSystemAgentOnlyAllowlist(internalParams.toolsAllow)) {
    throw new Error('OpenClaw host authority requires toolsAllow: ["openclaw"]');
  }
  const ringZeroTools = internalParams.systemAgentTool
    ? [
        (await import("../tools/system-agent-tool.js")).createSystemAgentTool(
          internalParams.systemAgentTool,
        ),
      ]
    : [];
  if (
    !selection.builtIn &&
    !internalParams.suppressNextUserMessagePersistence &&
    internalParams.userTurnTranscriptRecorder
  ) {
    const assertCurrent = resolveAdmittedRunActiveAssertion(
      internalParams.admittedRunContext,
      internalParams.abortSignal,
    );
    if (!assertCurrent) {
      throw new Error("agent harness requires active admitted run authority");
    }
    assertCurrent();
    // Promote approved input before the host binds annotation to its exact stored row.
    await internalParams.userTurnTranscriptRecorder.persistApproved({
      cwd: internalParams.cwd ?? internalParams.workspaceDir,
    });
    assertCurrent();
  }
  if (nativeSessionRuntime) {
    await nativeSessionRuntime.assertCurrent();
  }
  const attemptParams = withoutHarnessSetupAuthority(internalParams);
  const pluginAttempt = withoutInternalHarnessAuthority(
    attemptParams,
    harness,
    selection.builtIn,
    selection.ownerPluginId,
  );
  logAgentHarnessSelection(selection, {
    provider: params.provider,
    modelId: params.modelId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  let result: EmbeddedRunAttemptResult;
  try {
    result = await runAgentHarnessOperation(harness, params, () =>
      runWithAgentRingZeroTools(ringZeroTools, () => {
        // Resolve plugin policy after entering the host scope. Ring-zero tools are
        // trusted setup authority and must survive ordinary deny-all policy.
        const hostOpenClawAuthority =
          isHostScopedAgentToolActive("openclaw") &&
          isSystemAgentOnlyAllowlist(pluginAttempt.params.toolsAllow);
        const preparedParams = selection.builtIn
          ? pluginAttempt.params
          : preparePluginHarnessParams(pluginAttempt.params, harness);
        const effectiveAttemptParams =
          hostOpenClawAuthority && preparedParams.pluginHarnessToolPolicyRestricted
            ? { ...preparedParams, pluginHarnessToolPolicyRestricted: false }
            : preparedParams;
        assertPluginHarnessConversationToolPolicySupport(
          harness,
          effectiveAttemptParams.pluginHarnessToolPolicyRestricted === true,
        );
        // Load the calculator only after admission and final host policy preparation.
        return import("./tool-authority.runtime.js").then(
          ({ withPreparedEmbeddedRunToolAuthority }) =>
            withPreparedEmbeddedRunToolAuthority(
              internalParams,
              effectiveAttemptParams,
              selection.builtIn
                ? undefined
                : (input) => {
                    const policies = resolvePluginHarnessToolPolicies({
                      ...input.run,
                      modelId: input.run.model,
                      sandboxSessionKey: input.run.runtimePolicySessionKey,
                      messageChannel: input.originatingChannel,
                      toolsAllow: input.toolsAllow,
                      disableTools: input.disableTools,
                    });
                    return resolvePluginHarnessDenyAllToolPolicyPrompt(policies)
                      ? { ...input, toolsAllow: [] }
                      : input;
                  },
              (prepared) =>
                pluginAttempt.runWithHostScope(() =>
                  runAgentHarnessLifecycleAttempt(harness, prepared),
                ),
            ),
        );
      }),
    );
  } finally {
    pluginAttempt.closeHostCapabilities();
  }
  const admission = internalParams.userTurnTranscriptRecorder?.getAdmissionReceipt();
  if (
    internalParams.onContextEngineTurnCandidate &&
    admission &&
    result.contextEngineTerminalAnchor
  ) {
    internalParams.onContextEngineTurnCandidate({
      boundary: {
        admission,
        terminal: result.contextEngineTerminalAnchor,
      },
      sessionIdUsed: result.sessionIdUsed,
      sessionKey: internalParams.sessionKey,
      sessionTarget: internalParams.sessionTarget,
      promptError: result.terminal.kind === "failed",
      aborted:
        result.terminal.kind === "aborted" ||
        (result.terminal.kind === "timeout" &&
          "aborted" in result.terminal &&
          result.terminal.aborted === true),
      yieldAborted:
        result.terminal.kind === "aborted" && result.terminal.source === "yield_cleanup",
      isHeartbeat: isHeartbeatLifecycleRunKind(internalParams.bootstrapContextRunKind),
    });
  }
  const { contextEngineTerminalAnchor: _contextEngineTerminalAnchor, ...publicResult } = result;
  return copyCoreTtsAttemptResultProvenance(result, publicResult);
}

function selectPreparedAgentHarness(
  params: EmbeddedRunAttemptParams,
): AgentHarnessSelectionDecision {
  return selectAgentHarnessDecision({
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
}

async function runAgentHarnessOperation<T>(
  harness: AgentHarness,
  params: EmbeddedRunAttemptParams,
  execute: () => Promise<T>,
): Promise<T> {
  const activeTrace = getActiveDiagnosticTraceContext();
  const harnessTrace = freezeDiagnosticTraceContext(
    activeTrace ? createChildDiagnosticTraceContext(activeTrace) : createDiagnosticTraceContext(),
  );
  if (isBuiltInOpenClawAgentHarness(harness)) {
    return await runWithDiagnosticTraceContext(harnessTrace, execute);
  }

  try {
    return await runWithDiagnosticTraceContext(harnessTrace, execute);
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

function isSystemAgentOnlyAllowlist(toolsAllow: readonly string[] | undefined): boolean {
  return toolsAllow?.length === 1 && normalizeToolPolicyName(toolsAllow[0] ?? "") === "openclaw";
}

function withoutHarnessSetupAuthority(
  params: EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions },
): EmbeddedRunAttemptParams {
  const {
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    systemAgentTool: _systemAgentTool,
    ...attemptParams
  } = params;
  return attemptParams;
}

function withoutInternalHarnessAuthority(
  params: EmbeddedRunAttemptParams,
  harness: AgentHarness,
  builtIn: boolean,
  ownerPluginId: string | undefined,
): {
  params: import("./types.js").AgentHarnessAttemptParamsV2;
  closeHostCapabilities: () => void;
  runWithHostScope: <T>(run: () => Promise<T>) => Promise<T>;
} {
  if (builtIn) {
    return {
      // The built-in harness is the internal owner of this authority. Only
      // plugin handoffs receive the projected public attempt shape below.
      params: {
        ...params,
        operationalRunInstance: params.admittedRunContext.operationalRunInstance,
      } as import("./types.js").AgentHarnessAttemptParamsV2,
      closeHostCapabilities: () => {},
      runWithHostScope: (run) => run(),
    };
  }
  const pluginParams = withoutPluginHarnessPrivateState(params);
  const host = createAgentHarnessHostCapabilities({
    attempt: params,
    requiredNodeCommands: harness.cloudPlacement?.devicePlacement?.requiredNodeCommands,
    pluginId:
      ownerPluginId ??
      (() => {
        throw new Error(`Agent harness ${harness.id} has no authoritative registry owner.`);
      })(),
  });
  return {
    params: { ...pluginParams, hostCapabilities: host.capabilities },
    closeHostCapabilities: host.close,
    runWithHostScope: host.runWithScope,
  };
}

function prepareHarnessFinalizationParams(
  params: EmbeddedRunAttemptParams & { systemAgentTool?: SystemAgentToolOptions },
  builtIn: boolean,
): import("./types.js").AgentHarnessSettledTurnFinalizationAttemptParams<
  import("./types.js").AgentHarnessAttemptParamsV2
> {
  const {
    hostCapabilities: _hostCapabilities,
    systemAgentTool: _systemAgentTool,
    ...withoutCapabilities
  } = params;
  if (builtIn) {
    return withoutCapabilities;
  }
  const pluginParams = withoutPluginHarnessPrivateState(withoutCapabilities);
  const boundary = "plugin harness finalization handoff";
  return {
    ...pluginParams,
    model: unwrapModelHeaderSentinelsForProviderEgress(pluginParams.model, boundary),
    resolvedApiKey: pluginParams.resolvedApiKey
      ? unwrapSecretSentinelsForProviderEgress(pluginParams.resolvedApiKey, boundary)
      : pluginParams.resolvedApiKey,
  };
}

function withoutPluginHarnessPrivateState(
  params: EmbeddedRunAttemptInternalParams,
): Omit<import("./types.js").AgentHarnessAttemptParamsV2, "hostCapabilities"> {
  // Keep mutable host-owned state behind one projection for every plugin handoff;
  // separate projections can drift and expose authority on less common operations.
  const {
    admittedRunContext: _admittedRunContext,
    assistantErrorTranscript: _assistantErrorTranscript,
    compactionCountOwner: _compactionCountOwner,
    onContextAccountingEvent: _onContextAccountingEvent,
    onCompactionRequestBudget: _onCompactionRequestBudget,
    contextEngineLogicalTurnLease: _contextEngineLogicalTurnLease,
    hostCapabilities: _hostCapabilities,
    onContextEngineTurnCandidate: _onContextEngineTurnCandidate,
    trajectoryRecorder: _trajectoryRecorder,
    __openclawSourceReplyDeliveryRuntime: _sourceReplyDeliveryRuntime,
    ...pluginParams
  } = params as EmbeddedRunAttemptInternalParams & {
    __openclawSourceReplyDeliveryRuntime?: unknown;
  };
  return pluginParams;
}

function preparePluginHarnessParams(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  harness: AgentHarness,
): import("./types.js").AgentHarnessAttemptParamsV2 {
  const boundary = "plugin harness handoff";
  const resolvedApiKey = params.resolvedApiKey
    ? unwrapSecretSentinelsForProviderEgress(params.resolvedApiKey, boundary)
    : params.resolvedApiKey;
  const model = unwrapModelHeaderSentinelsForProviderEgress(params.model, boundary);
  const preparedParams =
    model === params.model && resolvedApiKey === params.resolvedApiKey
      ? params
      : { ...params, model, resolvedApiKey };
  const policies = resolvePluginHarnessToolPolicies(
    preparedParams,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
  );
  return applyPluginHarnessDenyAllToolPolicy(
    {
      ...preparedParams,
      pluginHarnessToolPolicySafeDeniedTools:
        policies.safeDeniedToolNames.length > 0 ? policies.safeDeniedToolNames : undefined,
      pluginHarnessToolPolicyRestricted: policies.toolPolicyRestricted,
    },
    policies,
  );
}

function assertPluginHarnessConversationToolPolicySupport(
  harness: AgentHarness,
  restricted: boolean,
): void {
  if (
    harness.id !== "openclaw" &&
    restricted &&
    harness.conversationToolPolicySupport !== "exact"
  ) {
    throw new AgentHarnessPreflightError(
      `${harness.label} cannot enforce this conversation's tool policy. Use the embedded runtime or ask in the main conversation.`,
      { scope: "harness" },
    );
  }
}

function applyPluginHarnessDenyAllToolPolicy(
  params: import("./types.js").AgentHarnessAttemptParamsV2,
  policies: ResolvedPluginHarnessToolPolicies,
): import("./types.js").AgentHarnessAttemptParamsV2 {
  if (
    isHostScopedAgentToolActive("openclaw") &&
    params.toolsAllow?.length === 1 &&
    normalizeToolPolicyName(params.toolsAllow[0] ?? "") === "openclaw"
  ) {
    return params;
  }
  const prompt = resolvePluginHarnessDenyAllToolPolicyPrompt(policies);
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
    toolPolicyRestrictsTools,
  )
    ? []
    : undefined;
}

/** Resolves whether a harness operation must remove its ambient native tool surface. */
export function resolveAgentHarnessNativeToolPolicyRestricted(
  params: PluginHarnessToolPolicyContext,
  harness: AgentHarness,
): boolean {
  return resolvePluginHarnessToolPolicies(
    params,
    harness.conversationToolPolicySupport === "exact"
      ? harness.conversationToolPolicySafeDenyTools
      : undefined,
  ).toolPolicyRestricted;
}

function resolvePluginHarnessDenyAllToolPolicyPrompt(
  policies: ResolvedPluginHarnessToolPolicies,
): string | undefined {
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

export function resolvePluginHarnessToolPolicies(
  params: PluginHarnessToolPolicyContext,
  safeDenyToolNames?: readonly string[],
): ResolvedPluginHarnessToolPolicies {
  const messageProvider = params.messageProvider ?? params.messageChannel;
  const sandboxSessionKey = params.sandboxSessionKey ?? params.sessionKey;
  const sandboxRuntime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    // Compaction can supply an execution owner without its own session key.
    sessionKey: params.sessionKey ?? (params.agentId ? undefined : sandboxSessionKey),
    classificationSessionKey: sandboxSessionKey,
    classificationAgentId: params.sandboxAgentId,
  });
  const sandboxPolicy = sandboxRuntime.sandboxed ? sandboxRuntime.toolPolicy : undefined;
  const capabilityProfile = resolveConversationCapabilityProfile({
    config: params.config,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sandboxSessionKey,
    agentId: params.agentId,
    modelProvider: params.provider,
    modelId: params.modelId,
    messageProvider,
    messageChannel: params.messageChannel,
    conversationToolPolicy: params.conversationToolPolicy,
    agentAccountId: params.agentAccountId,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    memberRoleIds: params.memberRoleIds,
    spawnedBy: params.spawnedBy,
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderIsOwner: params.senderIsOwner,
    sandboxToolPolicy: sandboxPolicy,
    inputProvenance: params.inputProvenance,
    trustedInternalHandoff: params.trustedInternalHandoff,
    scheduledToolPolicy: params.scheduledToolPolicy,
    runtimePluginToolGrant: params.runtimePluginToolGrant,
  });
  const groupPolicyParams = {
    config: params.config,
    sessionKey: params.scheduledToolPolicy?.ownerSessionKey ?? params.sessionKey,
    spawnedBy: params.spawnedBy,
    messageProvider,
    groupId: params.groupId,
    groupChannel: params.groupChannel,
    groupSpace: params.groupSpace,
    accountId: params.scheduledToolPolicy?.ownerAccountId ?? params.agentAccountId,
    requireConfiguredAccount: params.scheduledToolPolicy?.mode === "account",
    senderId: params.senderId,
    senderName: params.senderName,
    senderUsername: params.senderUsername,
    senderE164: params.senderE164,
    senderPolicyMode: params.scheduledToolPolicy ? ("never" as const) : ("always" as const),
  };
  const { policy } = capabilityProfile;
  const requestedToolPolicy = params.disableTools
    ? { allow: [] }
    : params.toolsAllow
      ? { allow: params.toolsAllow }
      : undefined;
  const explicitPolicies = [
    policy.globalPolicy,
    policy.globalProviderPolicy,
    policy.agentPolicy,
    policy.agentProviderPolicy,
    policy.groupPolicy,
    policy.senderPolicy,
    policy.sandboxPolicy,
    policy.subagentPolicy,
    policy.inheritedToolPolicy,
    policy.runtimeToolPolicyForInheritance,
    requestedToolPolicy,
  ];
  const safeDenyToolNameSet = safeDenyToolNames
    ? new Set(safeDenyToolNames.map(normalizeToolPolicyName))
    : undefined;
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
      requestedToolPolicy,
    ],
    safeDeniedToolNames: collectHarnessSafeDeniedToolNames(explicitPolicies, safeDenyToolNameSet),
    // Native tools bypass the collector's noninteractive OpenClaw wrappers.
    // Keep policy-allowed host replacements, without ambient input or approval surfaces.
    toolPolicyRestricted:
      params.swarmCollector === true ||
      explicitPolicies.some((explicitPolicy) =>
        toolPolicyRestrictsHarnessNativeTools(explicitPolicy, safeDenyToolNameSet),
      ),
  };
}

function collectHarnessSafeDeniedToolNames(
  policies: Array<PluginHarnessToolPolicy | undefined>,
  safeDenyToolNames: ReadonlySet<string> | undefined,
): string[] {
  if (!safeDenyToolNames) {
    return [];
  }
  return [
    ...new Set(
      policies
        .flatMap((policy) => expandToolGroups(policy?.deny ?? []))
        .map(normalizeToolPolicyName)
        .filter((name) => isKnownCoreToolId(name) && safeDenyToolNames.has(name)),
    ),
  ].toSorted();
}

function toolPolicyRestrictsHarnessNativeTools(
  policy: PluginHarnessToolPolicy | undefined,
  safeDenyToolNames: ReadonlySet<string> | undefined,
): boolean {
  if (!safeDenyToolNames) {
    return toolPolicyRestrictsTools(policy);
  }
  if (!policy || toolPolicyRestrictsTools({ allow: policy.allow })) {
    return toolPolicyRestrictsTools(policy);
  }
  return expandToolGroups(policy.deny ?? []).some((deniedName) => {
    const normalized = normalizeToolPolicyName(deniedName);
    return !isKnownCoreToolId(normalized) || !safeDenyToolNames.has(normalized);
  });
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
  return expandToolGroups(policy?.deny ?? []).some(
    (entry) => normalizeToolPolicyName(entry) === "*",
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
  const builtIn = isBuiltInOpenClawAgentHarness(params.harness);
  return {
    harness: params.harness,
    builtIn,
    ...(!builtIn ? { ownerPluginId: resolveAgentHarnessOwnerPluginId(params.harness) } : {}),
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
