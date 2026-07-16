import { normalizeSortedUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  type EnvironmentSummary,
  ErrorCodes,
  errorShape,
  validateEnvironmentsCreateParams,
  validateEnvironmentsDestroyParams,
  validateEnvironmentsListParams,
  validateEnvironmentsStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listDevicePairing } from "../../infra/device-pairing.js";
import { listNodePairing } from "../../infra/node-pairing.js";
import type { NodeListNode } from "../../shared/node-list-types.js";
import { createKnownNodeCatalog, listKnownNodes } from "../node-catalog.js";
import type { WorkerEnvironmentServiceRecord } from "../worker-environments/service-contract.js";
import type { WorkerEnvironmentState } from "../worker-environments/state.js";
import { formatForLog } from "../ws-log.js";
import { respondInvalidParams, respondUnavailableOnThrow } from "./nodes.helpers.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

const GATEWAY_ENVIRONMENT: EnvironmentSummary = {
  id: "gateway",
  type: "local",
  label: "Gateway local",
  status: "available",
  capabilities: ["agent.run", "sessions", "tools", "workspace"],
};
const WORKER_STATUS: Record<WorkerEnvironmentState, EnvironmentSummary["status"]> = {
  requested: "starting",
  provisioning: "starting",
  bootstrapping: "starting",
  ready: "available",
  attached: "available",
  idle: "available",
  draining: "stopping",
  destroying: "stopping",
  destroyed: "unavailable",
  failed: "error",
  orphaned: "error",
};
function uniqueSortedStrings(...items: Array<readonly string[] | undefined>): string[] {
  return normalizeSortedUniqueTrimmedStringList(items.flatMap((item) => item ?? []));
}
function rejectInvalid(
  respond: RespondFn,
  method: string,
  validator: Parameters<typeof respondInvalidParams>[0]["validator"],
) {
  return respondInvalidParams({ respond, method, validator });
}
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
/** Projects a durable worker row without exposing its SSH credential reference. */
export function summarizeWorkerEnvironment(
  record: WorkerEnvironmentServiceRecord,
  now = Date.now(),
): EnvironmentSummary {
  return {
    id: record.environmentId,
    type: "worker",
    status: WORKER_STATUS[record.state],
    worker: {
      providerId: record.providerId,
      ...(record.leaseId ? { leaseId: record.leaseId } : {}),
      state: record.state,
      ageMs: Math.max(0, Math.trunc(now - record.createdAtMs)),
      ...(record.state === "idle" && record.idleSinceAtMs !== null
        ? { idleMs: Math.max(0, Math.trunc(now - record.idleSinceAtMs)) }
        : {}),
      attachedSessionIds: uniqueSortedStrings(record.attachedSessionIds),
      tunnelStatus: record.tunnelStatus,
    },
  };
}
async function listEnvironments(context: GatewayRequestContext): Promise<EnvironmentSummary[]> {
  const [devices, nodes] = await Promise.all([listDevicePairing(), listNodePairing()]);
  const catalog = createKnownNodeCatalog({
    pairedDevices: devices.paired,
    pairedNodes: nodes.paired,
    connectedNodes: context.nodeRegistry.listConnected(),
  });
  return [GATEWAY_ENVIRONMENT, ...listKnownNodes(catalog).map(summarizeNodeEnvironment)];
}
function listWorkerEnvironments(context: GatewayRequestContext): WorkerEnvironmentServiceRecord[] {
  try {
    return context.workerEnvironmentService?.list() ?? [];
  } catch {
    // A damaged worker store must not regress the pre-existing gateway/node inventory.
    return [];
  }
}
function listWorkerProfiles(context: GatewayRequestContext) {
  if (!context.workerEnvironmentService || !context.workerPlacementDispatchService) {
    return [];
  }
  const profiles = context.getRuntimeConfig().cloudWorkers?.profiles ?? {};
  return Object.entries(profiles)
    .flatMap(([id, profile]) => {
      const providerId = typeof profile.provider === "string" ? profile.provider.trim() : "";
      return id.trim() && providerId ? [{ id: id.trim(), providerId }] : [];
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
}
async function respondWorkerMutation(
  respond: RespondFn,
  run: () => Promise<WorkerEnvironmentServiceRecord>,
  invalidCodes: readonly string[],
  unavailableMessage: string,
) {
  try {
    respond(true, summarizeWorkerEnvironment(await run()), undefined);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    const invalid = typeof code === "string" && invalidCodes.includes(code);
    const message = invalid && error instanceof Error ? error.message : unavailableMessage;
    respond(
      false,
      undefined,
      errorShape(invalid ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE, message),
    );
  }
}
export const environmentsHandlers: GatewayRequestHandlers = {
  "environments.list": async ({ params, respond, context }) => {
    if (!validateEnvironmentsListParams(params)) {
      return rejectInvalid(respond, "environments.list", validateEnvironmentsListParams);
    }
    await respondUnavailableOnThrow(respond, async () => {
      const environments = await listEnvironments(context);
      const workers = listWorkerEnvironments(context);
      const summarizedAtMs = Date.now();
      environments.push(
        ...workers.map((record) => summarizeWorkerEnvironment(record, summarizedAtMs)),
      );
      const profiles = listWorkerProfiles(context);
      respond(true, { environments, ...(profiles.length > 0 ? { profiles } : {}) }, undefined);
    });
  },
  "environments.status": async ({ params, respond, context }) => {
    if (!validateEnvironmentsStatusParams(params)) {
      return rejectInvalid(respond, "environments.status", validateEnvironmentsStatusParams);
    }
    await respondUnavailableOnThrow(respond, async () => {
      const environment = (await listEnvironments(context)).find(
        (entry) => entry.id === params.environmentId,
      );
      if (environment) {
        respond(true, environment, undefined);
        return;
      }
      let worker: WorkerEnvironmentServiceRecord | undefined;
      try {
        worker = context.workerEnvironmentService?.get(params.environmentId);
      } catch {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "environment status unavailable"),
        );
        return;
      }
      respond(
        Boolean(worker),
        worker ? summarizeWorkerEnvironment(worker) : undefined,
        worker ? undefined : errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"),
      );
    });
  },
  "environments.create": async ({ params, respond, context }) => {
    if (!validateEnvironmentsCreateParams(params)) {
      return rejectInvalid(respond, "environments.create", validateEnvironmentsCreateParams);
    }
    const service = context.workerEnvironmentService;
    if (!service) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cloud worker environments are not configured"),
      );
      return;
    }
    await respondWorkerMutation(
      respond,
      () => service.create(params.profileId, params.idempotencyKey),
      ["profile_not_found", "invalid_profile"],
      "worker environment creation failed",
    );
  },
  "environments.destroy": async ({ params, respond, context }) => {
    if (!validateEnvironmentsDestroyParams(params)) {
      return rejectInvalid(respond, "environments.destroy", validateEnvironmentsDestroyParams);
    }
    const service = context.workerEnvironmentService;
    if (!service) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown environmentId"));
      return;
    }
    await respondWorkerMutation(
      respond,
      async () => {
        const placementService = context.workerPlacementDispatchService;
        if (params.force && !placementService?.forceDestroyEnvironment) {
          throw new Error("cloud worker placement control is unavailable");
        }
        const destroyed = params.force
          ? await placementService!.forceDestroyEnvironment!(params.environmentId)
          : await service.destroyUnattached(params.environmentId);
        // Destruction is authoritative. Project the dead worker into its owning
        // placement before returning, or immediate session deletion stays fenced.
        try {
          await context.workerPlacementDispatchService?.reconcileActive?.(params.environmentId);
        } catch (error) {
          // The provider mutation has committed. Keep its success authoritative;
          // the periodic recovery sweep will retry this projection.
          context.logGateway.warn(
            `worker placement reconciliation after destroy failed: ${formatForLog(error)}`,
          );
        }
        return destroyed;
      },
      ["environment_not_found", "invalid_state"],
      "worker environment destruction failed",
    );
  },
};
