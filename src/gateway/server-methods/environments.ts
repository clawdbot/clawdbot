import { listDevicePairing } from "../../infra/device-pairing.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { createKnownNodeCatalog, listKnownNodes } from "../node-catalog.js";
import {
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateEnvironmentsListParams,
  validateEnvironmentsStatusParams,
} from "../protocol/index.js";
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
  const values = new Set<string>();
  for (const item of items) {
    for (const value of item ?? []) {
      const trimmed = value.trim();
      if (trimmed) {
        values.add(trimmed);
      }
    }
  }
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

function summarizeNodeEnvironment(node: NodeListNode): EnvironmentSummary {
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

async function listEnvironments(context: GatewayRequestContext) {
  const [devicePairing, nodePairing] = await Promise.all([listDevicePairing(), listNodePairing()]);
  const catalog = createKnownNodeCatalog({
    pairedDevices: devicePairing.paired,
    pairedNodes: nodePairing.paired,
    connectedNodes: context.nodeRegistry.listConnected(),
  });
  return listEnvironmentSummaries(listKnownNodes(catalog));
}

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
