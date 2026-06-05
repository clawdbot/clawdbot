// Environment gateway methods summarize the local gateway and paired/connected
// nodes as execution environments for UI and automation clients.
import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateEnvironmentsListParams,
  validateEnvironmentsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { createKnownNodeCatalog, listKnownNodes } from "../node-catalog.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";

const GATEWAY_ENVIRONMENT: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  capabilities: ["agent.run", "sessions", "tools", "workspace"],
};

function uniqueSortedStrings(...items: Array<readonly string[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}

/** Converts a known node entry into the public environment summary shape. */
function summarizeNodeEnvironment(node: NodeListNode): EnvironmentSummary {
  // Expose both declared capabilities and command names so older node
  // runtimes still advertise useful execution surfaces in one stable list.
  const capabilities = uniqueSortedStrings(node.caps, node.commands);
  return {
    id: `node:${node.nodeId}`,
    type: "node",
    label: node.displayName ?? node.nodeId,
    status: node.connected ? "available" : "unavailable",
    ...(capabilities.length > 0 ? { capabilities } : {}),
  };
}

function listEnvironmentSummaries(nodes: readonly NodeListNode[]): EnvironmentSummary[] {
  return [GATEWAY_ENVIRONMENT, ...nodes.map(summarizeNodeEnvironment)];
}

/** Lists the local Gateway plus paired/connected node environments. */
async function listEnvironments(context: GatewayRequestContext) {
  const [devicePairing, nodePairing] = await Promise.all([listDevicePairing(), listNodePairing()]);
  const catalog = createKnownNodeCatalog({
    pairedDevices: devicePairing.paired,
    pairedNodes: nodePairing.paired,
    connectedNodes: context.nodeRegistry.listConnected(),
  });
  return listEnvironmentSummaries(listKnownNodes(catalog));
}

/** Gateway handlers for querying local and node execution environments. */
export const environmentsHandlers: GatewayRequestHandlers = {
  "environments.list": async ({ params, respond, context }) => {
    if (!validateEnvironmentsListParams(params)) {
      respondInvalidParams({
        respond,
        method: "environments.list",
        validator: validateEnvironmentsListParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      respond(true, { environments: await listEnvironments(context) }, undefined);
    });
  },
  "environments.status": async ({ params, respond, context }) => {
    if (!validateEnvironmentsStatusParams(params)) {
      respondInvalidParams({
        respond,
        method: "environments.status",
        validator: validateEnvironmentsStatusParams,
      });
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const environment = (await listEnvironments(context)).find(
        (entry) => entry.id === params.environmentId,
      );
      if (!environment) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"));
        return;
      }
      respond(true, environment, undefined);
    });
  },
};
