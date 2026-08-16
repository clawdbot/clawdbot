import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateNodeDescribeParams,
  validateNodeListParams,
  validateNodePluginToolsUpdateParams,
  validateNodeSkillsUpdateParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { projectNodePairing } from "../../infra/device-pairing-node.js";
import { listDevicePairing, resolveNodePairingState } from "../../infra/device-pairing.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  formatNodeRunnerUpdateRequired,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE,
  NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE,
  parseNodeRunnerInventoryDeclaration,
} from "../../infra/node-runner-inventory.js";
import { resolveLocalNodeId } from "../../node-host/local-id.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { replaceRemoteNodeSkills } from "../../skills/runtime/remote-skills.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../skills/runtime/remote.js";
import { createKnownNodeCatalog, getKnownNode, listKnownNodes } from "../node-catalog.js";
import {
  collectNodeRunnerIssuesByNodeId,
  isNodeRunnerSessionHost,
  updateNodeRunnerInventory,
} from "../node-registry-private.js";
import type { NodeSession } from "../node-registry.js";
import {
  hasAuthorizedClientPluginNodeCapabilityUrl,
  pluginNodeCapabilityScopedHostUrlsConflict,
  refreshClientPluginNodeCapability,
} from "../plugin-node-capability.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./shared-types.js";
import type { GatewayRequestHandler, GatewayRequestHandlers } from "./types.js";

function safeNodeReadProjection(
  node: NodeListNode,
  ownDeviceId: string | undefined,
): NodeListNode | null {
  if (!node.paired && !node.connected) {
    return null;
  }
  const {
    pendingRequestId,
    pendingDeclaredCaps: _pendingDeclaredCaps,
    pendingDeclaredCommands: _pendingDeclaredCommands,
    pendingDeclaredPermissions: _pendingDeclaredPermissions,
    ...safeNode
  } = node;
  // A read-scoped mobile client may guide its user to approve this phone, but must not expose
  // another node's approval target or any pending capability declaration.
  return node.nodeId === ownDeviceId && pendingRequestId
    ? { ...safeNode, pendingRequestId }
    : safeNode;
}

function nodeReadCallerDeviceId(client: GatewayClient | null): string | undefined {
  return normalizeOptionalString(client?.connect?.device?.id);
}

function isVisibleNode(node: NodeListNode | null): node is NodeListNode {
  return node !== null;
}

function currentSessionHostNodeIds(params: {
  connectedNodes: readonly NodeSession[];
  nodeRegistry: GatewayRequestContext["nodeRegistry"];
}): Set<string> {
  return new Set(
    params.connectedNodes.flatMap((node) =>
      isNodeRunnerSessionHost({
        registry: params.nodeRegistry,
        nodeId: node.nodeId,
        connId: node.connId,
        pairingGeneration: node.pairingGeneration,
      })
        ? [node.nodeId]
        : [],
    ),
  );
}

async function listNodesForClient(params: {
  client: GatewayClient | null;
  context: GatewayRequestContext;
  nodeId?: string;
  pairedDevices: Awaited<ReturnType<typeof listDevicePairing>>["paired"];
  pairedNodes: ReturnType<typeof projectNodePairing>["paired"];
  pendingNodes: ReturnType<typeof projectNodePairing>["pending"];
  connectedNodes: readonly NodeSession[];
}): Promise<NodeListNode[]> {
  const sessionHostNodeIds = currentSessionHostNodeIds({
    connectedNodes: params.connectedNodes,
    nodeRegistry: params.context.nodeRegistry,
  });
  const issuesByNodeId = collectNodeRunnerIssuesByNodeId(
    params.context.nodeRegistry,
    params.connectedNodes,
  );
  const catalog = createKnownNodeCatalog({
    pairedDevices: params.pairedDevices,
    pairedNodes: params.pairedNodes,
    pendingNodes: params.pendingNodes,
    connectedNodes: params.connectedNodes,
    sessionHostNodeIds,
    issuesByNodeId,
  });
  const localNodeId = await resolveLocalNodeId().catch((error: unknown) => {
    params.context.logGateway.warn(
      `failed to resolve same-install node-host identity: ${formatErrorMessage(error)}`,
    );
    return null;
  });
  const catalogNodes = params.nodeId
    ? [getKnownNode(catalog, params.nodeId)].filter(isVisibleNode)
    : listKnownNodes(catalog);
  const nodes = catalogNodes.map((node) =>
    node.nodeId === localNodeId ? Object.assign({}, node, { gatewayLocal: true }) : node,
  );
  if (nodeInvokePolicy.canReadPendingNodePairing(params.client)) {
    return nodes;
  }
  const ownDeviceId = nodeReadCallerDeviceId(params.client);
  return nodes.map((node) => safeNodeReadProjection(node, ownDeviceId)).filter(isVisibleNode);
}

function listCurrentConnectedNodes(
  context: GatewayRequestContext,
  pairedDevices: Awaited<ReturnType<typeof listDevicePairing>>["paired"],
): NodeSession[] {
  const currentPairingStates = new Map<string, { identity: string; generation?: string }>();
  for (const device of pairedDevices) {
    const state = resolveNodePairingState(device);
    if (state) {
      currentPairingStates.set(state.identity.nodeId, {
        identity: state.identity.key,
        ...(state.generation ? { generation: state.generation.key } : {}),
      });
    }
  }
  return context.nodeRegistry.listConnectedForPairingStates(currentPairingStates);
}

function normalizePluginSurfaceRefreshParams(
  params: unknown,
): { surface: string; observedUrl?: string } | undefined {
  if (!params || typeof params !== "object") {
    return undefined;
  }
  const surface = normalizeOptionalString((params as { surface?: unknown }).surface);
  if (!surface) {
    return undefined;
  }
  const observedUrl = normalizeOptionalString((params as { observedUrl?: unknown }).observedUrl);
  return { surface, ...(observedUrl ? { observedUrl } : {}) };
}

function respondRefreshedPluginSurface(params: {
  surface: string;
  observedUrl?: string;
  client: GatewayClient | null;
  respond: RespondFn;
}) {
  const currentUrl = params.client?.pluginSurfaceUrls?.[params.surface];
  const capabilitySurface = params.client?.pluginNodeCapabilitySurfaces?.[params.surface] ?? {
    surface: params.surface,
  };
  if (
    params.client &&
    currentUrl &&
    params.observedUrl &&
    pluginNodeCapabilityScopedHostUrlsConflict(currentUrl, params.observedUrl) &&
    hasAuthorizedClientPluginNodeCapabilityUrl({
      client: params.client,
      surface: capabilitySurface,
      url: currentUrl,
    })
  ) {
    // A prior in-flight request already rotated this capability. Return its
    // result instead of invalidating it with a second rotation.
    params.respond(
      true,
      {
        surface: params.surface,
        pluginSurfaceUrls: { [params.surface]: currentUrl },
      },
      undefined,
    );
    return;
  }
  const refreshed = params.client
    ? refreshClientPluginNodeCapability({
        client: params.client,
        surface: capabilitySurface,
      })
    : undefined;
  if (!refreshed) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, `${params.surface} plugin surface unavailable`),
    );
    return;
  }
  params.respond(
    true,
    {
      surface: refreshed.surface,
      pluginSurfaceUrls: { [refreshed.surface]: refreshed.scopedUrl },
      expiresAtMs: refreshed.expiresAtMs,
    },
    undefined,
  );
}

const handlePluginSurfaceRefresh: GatewayRequestHandler = ({ params, respond, client }) => {
  const parsed = normalizePluginSurfaceRefreshParams(params);
  if (!parsed) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "surface required"));
    return;
  }
  respondRefreshedPluginSurface({
    surface: parsed.surface,
    observedUrl: parsed.observedUrl,
    client,
    respond,
  });
};

export function refreshConnectedNodeSurfaceCaches(params: {
  context: GatewayRequestContext;
  nodeSession: NodeSession;
  cfg?: OpenClawConfig;
}) {
  const cfg = params.cfg ?? params.context.getRuntimeConfig();
  const { nodeSession } = params;
  recordRemoteNodeInfo({
    nodeId: nodeSession.nodeId,
    connId: nodeSession.connId,
    displayName: nodeSession.displayName,
    platform: nodeSession.platform,
    deviceFamily: nodeSession.deviceFamily,
    commands: nodeSession.commands,
    remoteIp: nodeSession.remoteIp,
    pairingGeneration: nodeSession.pairingGeneration,
  });
  void refreshRemoteNodeBins({
    nodeId: nodeSession.nodeId,
    platform: nodeSession.platform,
    deviceFamily: nodeSession.deviceFamily,
    commands: nodeSession.commands,
    cfg,
  }).catch((err: unknown) =>
    params.context.logGateway.warn(
      `remote bin probe failed for ${nodeSession.nodeId}: ${formatErrorMessage(err)}`,
    ),
  );
}

export const nodeReadHandlers: GatewayRequestHandlers = {
  "node.list": async ({ params, respond, client, context }) => {
    if (!validateNodeListParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.list",
        validator: validateNodeListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const devicePairing = await listDevicePairing();
      const nodePairing = projectNodePairing(devicePairing.paired);
      const connectedNodes = listCurrentConnectedNodes(context, devicePairing.paired);
      const nodes = await listNodesForClient({
        client,
        context,
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        pendingNodes: nodePairing.pending,
        connectedNodes,
      });
      const activeNodeId = context.nodeRegistry.getActiveNode(connectedNodes)?.nodeId;
      const nodesWithPresence = activeNodeId
        ? nodes.map((node) => (node.nodeId === activeNodeId ? { ...node, active: true } : node))
        : nodes;
      respond(true, { ts: Date.now(), activeNodeId, nodes: nodesWithPresence }, undefined);
    });
  },
  "node.describe": async ({ params, respond, client, context }) => {
    if (!validateNodeDescribeParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.describe",
        validator: validateNodeDescribeParams,
      });
      return;
    }
    const { nodeId } = params as { nodeId: string };
    const id = normalizeOptionalString(nodeId) ?? "";
    if (!id) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const devicePairing = await listDevicePairing();
      const nodePairing = projectNodePairing(devicePairing.paired);
      const connectedNodes = listCurrentConnectedNodes(context, devicePairing.paired);
      const nodes = await listNodesForClient({
        client,
        context,
        nodeId: id,
        pairedDevices: devicePairing.paired,
        pairedNodes: nodePairing.paired,
        pendingNodes: nodePairing.pending,
        connectedNodes,
      });
      const node = nodes[0];
      if (!node) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
        return;
      }
      respond(
        true,
        {
          ts: Date.now(),
          ...node,
          ...(context.nodeRegistry.getActiveNode(connectedNodes)?.nodeId === id
            ? { active: true }
            : {}),
        },
        undefined,
      );
    });
  },
  "plugin.surface.refresh": handlePluginSurfaceRefresh,
  "node.pluginSurface.refresh": handlePluginSurfaceRefresh,
  "node.pluginTools.update": async ({ params, respond, client, context }) => {
    if (!validateNodePluginToolsUpdateParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.pluginTools.update",
        validator: validateNodePluginToolsUpdateParams,
      });
      return;
    }
    const nodeId = normalizeOptionalString(
      client?.connect?.device?.id ?? client?.connect?.client?.id,
    );
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const updated = context.nodeRegistry.updateNodePluginTools(
      nodeId,
      client?.connId,
      params.tools,
    );
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    respond(true, { nodeId, tools: updated.nodePluginTools }, undefined);
  },
  "node.skills.update": async ({ params, respond, client, context }) => {
    if (!validateNodeSkillsUpdateParams(params)) {
      respondInvalidParams({
        respond,
        method: "node.skills.update",
        validator: validateNodeSkillsUpdateParams,
      });
      return;
    }
    const nodeId = normalizeOptionalString(
      client?.connect?.device?.id ?? client?.connect?.client?.id,
    );
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    const updated = context.nodeRegistry.updateNodeSkills(nodeId, client?.connId, params.skills);
    if (!updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    replaceRemoteNodeSkills({
      nodeId,
      displayName: updated.displayName,
      skills: updated.nodeSkills,
    });
    respond(true, { nodeId, skills: updated.nodeSkills }, undefined);
  },
  "node.runnerInventory.update": ({ params, respond, client, context }) => {
    const declaration = parseNodeRunnerInventoryDeclaration(params);
    if (!declaration) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid node runner inventory"),
      );
      return;
    }
    const nodeId = normalizeOptionalString(client?.connect?.device?.id);
    const updated = nodeId
      ? updateNodeRunnerInventory({
          registry: context.nodeRegistry,
          nodeId,
          connId: client?.connId,
          declaration,
        })
      : null;
    if (!nodeId || !updated) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown nodeId"));
      return;
    }
    if (
      declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_LEGACY_PROTOCOL_FEATURE ||
      declaration.protocolFeatures[0] === NODE_WORKER_SUPERVISOR_BUILD_PROTOCOL_FEATURE
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          formatNodeRunnerUpdateRequired(nodeId, NODE_RUNNER_UPDATE_REQUIRED_ISSUE),
        ),
      );
      return;
    }
    respond(true, { nodeId }, undefined);
  },
};
