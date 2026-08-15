/** Lazy runtime adapter for plugin-owned embedded-agent execution. */
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { runEmbeddedAgent as runEmbeddedAgentCore } from "../../agents/embedded-agent.js";
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
  if ("admittedRunContext" in params || "preparedRunAdmission" in params) {
    throw new Error("Plugin embedded-agent execution cannot supply host run authority.");
  }
  params.abortSignal?.throwIfAborted();
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: params.config ?? getRuntimeConfig(),
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
    return await runEmbeddedAgentCore({ ...params, preparedRunAdmission });
  } finally {
    params.abortSignal?.removeEventListener("abort", close);
    close();
  }
};
