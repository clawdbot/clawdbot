/** Lightweight runtime availability shared by execution and next-turn projections. */
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import { resolveAgentHarnessPolicy, type AgentHarnessPolicy } from "./policy.js";
import { getRegisteredAgentHarness } from "./registry.js";
import { buildAgentHarnessSupportContext } from "./support.js";
import type { AgentHarnessSupport, AgentHarnessSupportContext } from "./types.js";

type AgentHarnessAvailabilityParams = Parameters<typeof resolveAgentHarnessPolicy>[0] & {
  modelProvider?: AgentHarnessSupportContext["modelProvider"];
  /** Projection can inspect loaded support, but absence before registration is not a fallback. */
  mode?: "execution" | "projection";
  agentHarnessId?: string;
  agentHarnessRuntimeOverride?: string;
  preparedModelProvider?: boolean;
  /** Execution supplies ownership lazily; read-only projections never discover plugins. */
  resolveProviderOwnership?: () => Parameters<
    typeof buildAgentHarnessSupportContext
  >[0]["providerOwnership"];
};

type AgentHarnessAvailabilityDecision = {
  kind: "available" | "implicit-unavailable" | "implicit-unsupported" | "declared-fallback";
  policy: AgentHarnessPolicy;
  /** Reuse the exact support decision during execution, without another probe. */
  support?: AgentHarnessSupport;
};

export function resolveAvailableAgentHarnessPolicy(
  params: AgentHarnessAvailabilityParams,
): AgentHarnessPolicy {
  return resolveAgentHarnessAvailabilityDecision(params).policy;
}

export function resolveAgentHarnessAvailabilityDecision(
  params: AgentHarnessAvailabilityParams,
): AgentHarnessAvailabilityDecision {
  const configured = resolveAgentHarnessPolicy({
    ...params,
    modelApi: params.modelProvider?.api ?? params.modelApi,
    modelBaseUrl: params.modelProvider?.baseUrl ?? params.modelBaseUrl,
    requestTransportOverrides:
      params.modelProvider?.requestTransportOverrides ?? params.requestTransportOverrides,
  });
  const pinnedHarnessId = normalizeOptionalAgentRuntimeId(params.agentHarnessId);
  const runtimeOverride =
    pinnedHarnessId ?? normalizeOptionalAgentRuntimeId(params.agentHarnessRuntimeOverride);
  const policy: AgentHarnessPolicy =
    runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)
      ? { ...configured, runtime: runtimeOverride, runtimeSource: "model" }
      : configured;
  const implicit = policy.runtime === "codex" && policy.runtimeSource === "implicit";
  if (policy.runtime === "auto" || policy.runtime === "openclaw") {
    return { kind: "available", policy };
  }
  const registered = getRegisteredAgentHarness(policy.runtime);
  if (!registered) {
    return implicit && params.mode !== "projection"
      ? { kind: "implicit-unavailable", policy: { ...policy, runtime: "openclaw" } }
      : { kind: "available", policy };
  }
  // A pinned native transcript owns early selection. Final prepared routes must
  // revalidate that owner; historical producer metadata is not a next-turn pin.
  if (pinnedHarnessId === policy.runtime && !params.preparedModelProvider) {
    return { kind: "available", policy };
  }
  const provider = params.provider?.trim() ?? "";
  if (params.provider === undefined) {
    return { kind: "available", policy };
  }
  const support = registered.harness.supports(
    buildAgentHarnessSupportContext({
      ...params,
      provider,
      requestedRuntime: policy.runtime,
      providerOwnership: params.resolveProviderOwnership?.(),
    }),
  );
  if (!support.supported && !policy.forcedByEnvironment) {
    if (implicit || support.fallbackRuntime === "openclaw") {
      return {
        kind: implicit ? "implicit-unsupported" : "declared-fallback",
        policy: { ...policy, runtime: "openclaw" },
        support,
      };
    }
  }
  return { kind: "available", policy, support };
}
