/** Lazy runtime adapter for plugin-owned embedded-agent execution. */
import { randomUUID } from "node:crypto";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
} from "../../agents/admitted-run-context.js";
import { runEmbeddedAgent as runEmbeddedAgentCore } from "../../agents/embedded-agent.js";
import { recordRuntimeActionDecision } from "../../audit/runtime-action-decision.js";
import { getRuntimeConfig } from "../../config/config.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";
import type { PluginRuntime } from "./types.js";

export const runPluginEmbeddedAgent: PluginRuntime["agent"]["runEmbeddedAgent"] = async (
  params,
) => {
  const pluginId = getPluginRuntimeGatewayRequestScope()?.pluginId;
  if (!pluginId) {
    throw new Error("Plugin embedded-agent execution requires an active plugin runtime scope.");
  }
  if (
    "admittedRunContext" in params ||
    "preparedRunAdmission" in params ||
    "compactionCountOwner" in params ||
    "onCompactionAccounting" in params ||
    "onContextAccountingEvent" in params ||
    "onDeferredLifecycleOwner" in params ||
    "onDeferredLifecycleAbort" in params
  ) {
    throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
  }
  params.abortSignal?.throwIfAborted();
  const decisionOccurrenceId = randomUUID();
  let admittedRunContext: AdmittedRunContext | undefined;
  const config = params.config ?? getRuntimeConfig();
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(params.runId),
    facts: {
      runId: params.runId,
      agentId: params.sessionTarget?.agentId ?? params.agentId ?? "main",
      ingress: {
        kind: "plugin",
        boundary: "plugin-runtime",
        rawSourceRef: pluginId,
        state: "present",
      },
    },
    onAdmitted: (context) => {
      admittedRunContext = context;
      const token = context.executionIdentityToken;
      recordRuntimeActionDecision({
        token,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "enforced",
        reasonCode: "plugin_runtime_owner_admitted",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        policyRefs: ["plugin:registered-owner", "run:admission"],
        summary: "The registered plugin owner passed exact run admission.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "admission"]),
      });
    },
  });
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      preparedRunAdmission.close();
    }
  };
  // Abort owns authority revocation independently of core completion; the
  // post-registration check closes the prepare-to-listener race.
  params.abortSignal?.addEventListener("abort", close, { once: true });
  try {
    params.abortSignal?.throwIfAborted();
    const result = await runEmbeddedAgentCore({ ...params, config, preparedRunAdmission });
    if (admittedRunContext && getAdmittedRunDelegatedAuthority(admittedRunContext)) {
      recordRuntimeActionDecision({
        token: admittedRunContext.executionIdentityToken,
        family: "plugin",
        operation: "run",
        outcome: "allowed",
        coverageState: "attribution-only",
        reasonCode: "plugin_runtime_completed",
        owner: "plugin-runtime",
        decisionBoundary: "plugin.runtime.run-embedded-agent",
        summary: "The plugin-owned runtime completed; this is attribution, not authorization.",
        remediation: [],
        discriminator: JSON.stringify([pluginId, params.runId, decisionOccurrenceId, "completion"]),
      });
    }
    return result;
  } finally {
    params.abortSignal?.removeEventListener("abort", close);
    close();
  }
};
