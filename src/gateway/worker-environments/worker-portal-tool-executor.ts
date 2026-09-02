import type {
  WorkerPortalParams,
  WorkerSessionToolResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { formatPortalResult } from "../../agents/tools/portal-tool.js";
import type { GatewayPortalService } from "../portals/portal-service.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerSessionPlacementStore } from "./placement-store.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import type { WorkerEnvironmentService } from "./service.js";
import { serializeWorkerSessionToolResult } from "./worker-session-tool-result.js";
import { resolveWorkerSessionToolSource } from "./worker-session-tool-topology.js";

export type WorkerPortalToolRequest = {
  identity: WorkerConnectionIdentity;
  toolName: "portal";
  request: WorkerPortalParams;
  signal?: AbortSignal;
};

export type WorkerPortalToolExecutorDependencies = {
  placements: WorkerSessionPlacementStore;
  environments: Pick<WorkerEnvironmentService, "get">;
  portals: {
    getService: () => GatewayPortalService | undefined;
    carrier: Pick<WorkerNodePortalCarrier, "open">;
    onChanged: () => void;
  };
};

/** Executes worker portals only while their exact placement and turn retain authority. */
export function createWorkerPortalToolExecutor(params: WorkerPortalToolExecutorDependencies) {
  return async (request: WorkerPortalToolRequest): Promise<WorkerSessionToolResult> => {
    const assertPortalAuthority = () => {
      const current = resolveWorkerSessionToolSource({
        identity: request.identity,
        placements: params.placements,
      });
      if (!params.placements.isWorkerTurnToolAuthorized(current.turnClaim, "portal")) {
        throw new Error("Worker session tool authority changed");
      }
      const environment = params.environments.get(request.identity.environmentId);
      if (
        !environment ||
        environment.state !== "attached" ||
        environment.ownerEpoch !== request.identity.ownerEpoch ||
        environment.attachedSessionIds.length !== 1 ||
        environment.attachedSessionIds[0] !== current.sessionId
      ) {
        throw new Error("Worker source environment changed before portal operation");
      }
      if (!environment.nodeDeviceId || environment.sshEndpoint !== null) {
        throw new Error(
          "Portals require a node-backed cloud-worker placement; move the session back to the gateway with sessions.move",
        );
      }
      return environment;
    };
    const environment = assertPortalAuthority();
    const service = params.portals.getService();
    if (!service) {
      throw new Error("Gateway portals are unavailable");
    }
    request.signal?.throwIfAborted();
    if (request.request.action === "list") {
      const result = {
        portals: service.listWorkerPortals(environment.environmentId, environment.ownerEpoch),
      };
      assertPortalAuthority();
      return {
        resultJson: serializeWorkerSessionToolResult(
          formatPortalResult({ action: "list", result }),
        ),
      };
    }
    if (request.request.action === "close") {
      const id = request.request.id;
      if (!id) {
        throw new Error("portal id required");
      }
      const ownedPortals = service.listWorkerPortals(
        environment.environmentId,
        environment.ownerEpoch,
      );
      if (!ownedPortals.some((portal) => portal.id === id)) {
        throw new Error("Worker portal is not owned by the active environment");
      }
      await service.close(id, assertPortalAuthority);
      params.portals.onChanged();
      assertPortalAuthority();
      return {
        resultJson: serializeWorkerSessionToolResult(
          formatPortalResult({ action: "close", id, result: { closed: true } }),
        ),
      };
    }
    const remotePort = request.request.port;
    if (remotePort === undefined) {
      throw new Error("portal port required");
    }
    const connection = await params.portals.carrier.open({
      environmentId: environment.environmentId,
      ownerEpoch: environment.ownerEpoch,
      remotePort,
    });
    try {
      // Node discovery can yield; a replaced turn must never publish its former owner's portal.
      assertPortalAuthority();
      request.signal?.throwIfAborted();
    } catch (error) {
      await connection.close();
      throw error;
    }
    const opened = await service.open({
      targetPort: remotePort,
      assertCurrent: assertPortalAuthority,
      target: {
        kind: "worker",
        environmentId: environment.environmentId,
        ownerEpoch: environment.ownerEpoch,
        connect: connection.connect,
        remotePort,
      },
      onClose: connection.close,
      origin: environment.profileId,
      ...(request.request.title !== undefined ? { title: request.request.title } : {}),
      ...(request.request.description !== undefined
        ? { description: request.request.description }
        : {}),
      ...(request.request.path !== undefined ? { path: request.request.path } : {}),
    });
    // Publication transfers ownership to the environment; later turn revocation only denies its result.
    params.portals.onChanged();
    assertPortalAuthority();
    return {
      resultJson: serializeWorkerSessionToolResult(
        formatPortalResult({ action: "open", result: opened }),
      ),
    };
  };
}
