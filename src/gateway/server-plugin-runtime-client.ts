// Internal client metadata for trusted in-process plugin runtime calls.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { isKnownCoreToolId } from "../agents/tool-catalog.js";
import { normalizeToolName } from "../agents/tool-policy.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimePluginToolGrant } from "../plugins/runtime/tool-grant.js";
import { APPROVALS_SCOPE, WRITE_SCOPE } from "./method-scopes.js";
import type { GatewayRequestOptions } from "./server-methods/types.js";

export function createSyntheticPluginRuntimeClient(params?: {
  allowModelOverride?: boolean;
  agentRunTracking?: "plugin_subagent";
  cronRunContinuation?: boolean;
  internalDeliveryMediaUrls?: string[];
  internalDeliverySuppressText?: boolean;
  pluginRuntimeOwnerId?: string;
  runtimePluginToolGrant?: RuntimePluginToolGrant;
  scopes?: string[];
}): GatewayRequestOptions["client"] {
  const pluginRuntimeOwnerId =
    typeof params?.pluginRuntimeOwnerId === "string" && params.pluginRuntimeOwnerId.trim()
      ? params.pluginRuntimeOwnerId.trim()
      : undefined;
  return {
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: "internal",
        platform: "node",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: params?.scopes ?? [WRITE_SCOPE],
    },
    internal: {
      allowModelOverride: params?.allowModelOverride === true,
      ...(params?.agentRunTracking ? { agentRunTracking: params.agentRunTracking } : {}),
      ...(params?.cronRunContinuation === true ? { cronRunContinuation: true } : {}),
      ...(params?.internalDeliveryMediaUrls
        ? { internalDeliveryMediaUrls: [...params.internalDeliveryMediaUrls] }
        : {}),
      ...(params?.internalDeliverySuppressText === true
        ? { internalDeliverySuppressText: true }
        : {}),
      ...(params?.scopes?.includes(APPROVALS_SCOPE) ? { approvalRuntime: true } : {}),
      ...(pluginRuntimeOwnerId ? { pluginRuntimeOwnerId } : {}),
      ...(params?.runtimePluginToolGrant
        ? { runtimePluginToolGrant: params.runtimePluginToolGrant }
        : {}),
    },
  };
}

export function mergePluginRuntimeClientInternal(
  client: GatewayRequestOptions["client"] | undefined,
  internal: NonNullable<GatewayRequestOptions["client"]>["internal"],
): GatewayRequestOptions["client"] {
  if (!client || !internal) {
    return client ?? null;
  }
  return {
    ...client,
    internal: {
      ...client.internal,
      ...internal,
    },
  };
}

export function resolvePluginSubagentToolsAlsoAllow(params: {
  pluginId?: string;
  toolsAlsoAllow?: string[];
}): RuntimePluginToolGrant | undefined {
  const requested = uniqueStrings(
    (params.toolsAlsoAllow ?? []).map((entry) => normalizeToolName(entry.trim())).filter(Boolean),
  );
  if (requested.length === 0) {
    return undefined;
  }
  const pluginId = params.pluginId?.trim();
  if (!pluginId) {
    throw new Error("toolsAlsoAllow requires plugin identity for subagent runs.");
  }
  const registry = getActivePluginRegistry();
  for (const toolName of requested) {
    if (isKnownCoreToolId(toolName)) {
      throw new Error(`plugin "${pluginId}" may not add core tool "${toolName}" to subagent runs.`);
    }
    const owners = uniqueStrings(
      (registry?.tools ?? [])
        .filter((registration) =>
          [...registration.names, ...(registration.declaredNames ?? [])].some(
            (registeredName) => normalizeToolName(registeredName) === toolName,
          ),
        )
        .map((registration) => registration.pluginId),
    );
    if (owners.length !== 1 || owners[0] !== pluginId) {
      throw new Error(`plugin "${pluginId}" does not uniquely own subagent tool "${toolName}".`);
    }
  }
  return { pluginId, toolNames: requested };
}
