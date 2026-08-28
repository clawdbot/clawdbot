import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../infra/node-commands.js";
import {
  formatNodeRunnerUpdateRequired,
  NODE_RUNNER_UPDATE_REQUIRED_ISSUE,
  NODE_WORKER_ENVIRONMENT_SESSION_VERSION,
} from "../../infra/node-runner-inventory.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SpawnResult } from "../../process/exec.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import type { NodeWorkerSupervisorReceipt } from "../../worker/node-supervisor-protocol.js";
import {
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../../worker/node-workspace-transfer-protocol.js";
import { sameWorkerBuild } from "../../worker/worker-build-identity.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import type { createNodeWorkerLaunchAdapter } from "./node-launch-adapter.js";
import { raceNodeWorkerOperation } from "./node-worker-abort.js";
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import {
  createNodeWorkerWorkspaceActions,
  type NodeWorkerWorkspaceBinding,
} from "./node-worker-workspace-actions.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelStopReason,
  type WorkerTunnelStatus,
  type WorkerTurnTunnelHandle,
  type WorkerWorkspaceCommand,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const COMMAND_RESULT_GRACE_MS = 5_000;
const RETRY_DELAY_MS = 100;
const tunnelLog = createSubsystemLogger("gateway/worker-tunnel");
const RETRYABLE_TRANSPORT_CODES = new Set([
  "DISCONNECTED",
  "NOT_CONNECTED",
  "PAIRING_CHANGED",
  "PRIVATE_DIALECT_UNAVAILABLE",
  "ROUTE_CHANGED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

export type NodeWorkerWorkspaceBindingResolver = (binding: {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
}) => Promise<NodeWorkerWorkspaceBinding | undefined>;

type NodeWorkerTunnelManagerOptions = {
  gatewayDeviceId: string;
  getEnvironment: (environmentId: string) => WorkerEnvironmentRecord | undefined;
  listEnvironments: () => readonly WorkerEnvironmentRecord[];
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  launchNodeWorker: ReturnType<typeof createNodeWorkerLaunchAdapter>["launch"];
  validateWorkerTurn: (claim: WorkerSessionTurnClaim) => boolean;
  workspaceTransfer: NodeWorkspaceTransferService;
};

type NodeWorkerTunnelStartRequest = {
  executionMode: "worker-turn" | "remote-exec";
  environmentId: string;
  ownerEpoch: number;
  deviceId: string;
  sessionId: string;
  expectedBuild: WorkerAdmissionHandshake;
};

type NodeEnvironmentOwner = Omit<NodeWorkerTunnelStartRequest, "expectedBuild"> & {
  stopPromise?: Promise<void>;
  stopReason?: WorkerTunnelStopReason;
};

type NodeTunnelEntry = NodeEnvironmentOwner & {
  expectedBuild: WorkerAdmissionHandshake;
  abortController: AbortController;
  handle?: WorkerTurnTunnelHandle;
  initialization?: Promise<void>;
  launchTasks: Set<Promise<unknown>>;
  readiness: Deferred<WorkerTurnTunnelHandle>;
};

function spawnResultFromReceipt(receipt: NodeWorkerSupervisorReceipt): SpawnResult {
  if (receipt.state === "completed") {
    return {
      stdout: receipt.resultJson,
      stderr: "",
      code: 0,
      signal: null,
      killed: false,
      termination: "exit",
    };
  }
  if (
    receipt.state === "failed" ||
    receipt.state === "interrupted" ||
    receipt.state === "cancelled"
  ) {
    return {
      stdout: "",
      stderr: receipt.errorText,
      code: 1,
      signal: null,
      killed: receipt.state === "cancelled" || receipt.state === "interrupted",
      termination: "exit",
    };
  }
  throw new Error("node worker launch returned without a terminal receipt");
}

function payloadJson(value: string | null | undefined): unknown {
  if (!value) {
    throw new Error("node workspace command omitted its result");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error("node workspace command returned malformed JSON");
  }
}

/** Owns node-channel handles without treating the persistent machine as a disposable lease. */
export function createNodeWorkerTunnelManager(options: NodeWorkerTunnelManagerOptions) {
  const entries = new Map<string, NodeTunnelEntry>();
  const retiredEntries = new Set<NodeEnvironmentOwner>();
  let resolveWorkspaceBinding: NodeWorkerWorkspaceBindingResolver | undefined;
  const gatewayNamespace = nodeWorkerGatewayNamespace(options.gatewayDeviceId);

  const hasDurableBinding = (entry: NodeTunnelEntry): boolean => {
    const current = options.getEnvironment(entry.environmentId);
    return Boolean(
      current &&
      current.ownerEpoch === entry.ownerEpoch &&
      current.bootstrapReceipt?.installKind === "bundle" &&
      sameWorkerBuild(current.bootstrapReceipt, entry.expectedBuild) &&
      current.attachedSessionIds.length <= 1 &&
      (current.attachedSessionIds.length === 0 ||
        current.attachedSessionIds[0] === entry.sessionId),
    );
  };

  const isLiveEntry = (entry: NodeTunnelEntry): boolean =>
    entries.get(entry.environmentId) === entry && !entry.abortController.signal.aborted;

  const isEnvironmentOwner = (entry: NodeTunnelEntry): boolean =>
    hasDurableBinding(entry) && isLiveEntry(entry);

  const findNode = async (
    entry: NodeEnvironmentOwner,
    signal: AbortSignal,
  ): Promise<{ transport: NodeWorkerSupervisorTransport; node: NodeWorkerSupervisorNodeProof }> => {
    const transport = options.getTransport();
    if (!transport) {
      throw new Error("device worker node transport is unavailable");
    }
    const node = (await raceNodeWorkerOperation(transport.listCurrentNodes(), signal)).find(
      (candidate) => candidate.nodeId === entry.deviceId,
    );
    if (!node) {
      throw new WorkerTunnelOwnerDisconnectedError(
        "device worker node is not connected with the supervisor dialect",
      );
    }
    return { transport, node };
  };

  const runWorkspaceCommand = async (
    entry: NodeTunnelEntry,
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
  ): Promise<NodeWorkerWorkspaceExecResult> => {
    const commandTimeoutMs = command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    // Keep the subprocess deadline authoritative while allowing its terminal result to cross the
    // node transport. Equal deadlines turn an ordinary process timeout into a transport failure.
    const transportTimeoutMs =
      addTimerTimeoutGraceMs(commandTimeoutMs, COMMAND_RESULT_GRACE_MS) ?? commandTimeoutMs;
    const deadline = Date.now() + transportTimeoutMs;
    const signals = [entry.abortController.signal, AbortSignal.timeout(transportTimeoutMs)];
    if (command.signal) {
      signals.push(command.signal);
    }
    const signal = AbortSignal.any(signals);
    const input: NodeWorkerWorkspaceExecInput = {
      gatewayNamespace,
      environmentId: entry.environmentId,
      sessionId: entry.sessionId,
      generation: entry.ownerEpoch,
      argv: [...command.argv],
      ...(command.input === undefined ? {} : { input: command.input }),
      timeoutMs: commandTimeoutMs,
      ...(command.resetWorkspace === undefined ? {} : { resetWorkspace: command.resetWorkspace }),
      ...(command.transfer === undefined ? {} : { transfer: command.transfer }),
    };
    while (true) {
      if (!isEnvironmentOwner(entry)) {
        throw new Error("node worker workspace authority closed");
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0 || signal.aborted) {
        throw signal.reason ?? new Error("node worker workspace command timed out");
      }
      let result: Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;
      try {
        const { node, transport } = await findNode(entry, signal);
        result = await transport.invoke({
          node,
          command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
          params: input,
          timeoutMs: remainingMs,
          signal,
          isDispatchAuthorized: () => isEnvironmentOwner(entry),
        });
      } catch (error) {
        if (
          command.transportRetry !== "idempotent" ||
          signal.aborted ||
          !isEnvironmentOwner(entry)
        ) {
          throw error;
        }
        await sleepWithAbort(Math.min(RETRY_DELAY_MS, Math.max(1, deadline - Date.now())), signal);
        continue;
      }
      if (!result.ok) {
        const code = result.error?.code ?? "UNAVAILABLE";
        if (code === NODE_WORKSPACE_TRANSFER_ERROR_CODE) {
          throw new NodeWorkerWorkspaceTransferError(
            result.error?.message ?? "workspace-transfer-failed: transfer did not complete",
          );
        }
        if (command.transportRetry === "idempotent" && RETRYABLE_TRANSPORT_CODES.has(code)) {
          await sleepWithAbort(Math.min(RETRY_DELAY_MS, remainingMs), signal);
          continue;
        }
        throw new Error(
          result.error?.message && code === "INVALID_REQUEST"
            ? `node workspace command failed (${code}): ${result.error.message}`
            : `node workspace command failed (${code})`,
        );
      }
      const parsed = parseNodeWorkerWorkspaceExecResult(payloadJson(result.payloadJSON));
      if (!parsed) {
        throw new Error("node workspace command violated its private result contract");
      }
      return parsed;
    }
  };

  const createHandle = (
    entry: NodeTunnelEntry,
    restoredWorkspace: NodeWorkerWorkspaceBinding | undefined,
  ): { handle: WorkerTurnTunnelHandle; validateRestoredWorkspace: () => Promise<void> } => {
    const { validateRestoredWorkspace, ...workspaceActions } = createNodeWorkerWorkspaceActions({
      environmentId: entry.environmentId,
      ownerEpoch: entry.ownerEpoch,
      sessionId: entry.sessionId,
      ownerSignal: entry.abortController.signal,
      isOwnerCurrent: () => isLiveEntry(entry),
      restoredWorkspace,
      workspaceTransfer: options.workspaceTransfer,
      runWorkspaceCommand: (command) => runWorkspaceCommand(entry, command),
    });
    const handle: WorkerTurnTunnelHandle = {
      ...workspaceActions,
      environmentId: entry.environmentId,
      ownerEpoch: entry.ownerEpoch,
      launchTurn: async (request) => {
        if (entry.executionMode !== "worker-turn") {
          throw new Error("remote-exec environments do not launch embedded worker turns");
        }
        const plan = request.plan;
        const claim = request.turnClaim;
        const isDispatchAuthorized = () =>
          isEnvironmentOwner(entry) &&
          claim.owner.kind === "worker" &&
          claim.owner.environmentId === entry.environmentId &&
          claim.owner.ownerEpoch === entry.ownerEpoch &&
          claim.sessionId === plan.admission.sessionId &&
          claim.runId === plan.assignment.runId &&
          options.validateWorkerTurn(claim);
        const operation = options.launchNodeWorker({
          deviceId: entry.deviceId,
          input: {
            environmentSession: 1,
            launchId: plan.assignment.turnId,
            gatewayNamespace,
            expectedBundleHash: entry.expectedBuild.bundleHash,
            placementGeneration: claim.placementGeneration,
            descriptor: plan,
          },
          isDispatchAuthorized,
          isCancellationAuthorized: () => hasDurableBinding(entry),
          timeoutMs: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
          ...(request.credentialExpiresAtMs === undefined
            ? {}
            : { credentialExpiresAtMs: request.credentialExpiresAtMs }),
          onDispatchReady: request.onDispatchReady,
          signal: request.signal
            ? AbortSignal.any([entry.abortController.signal, request.signal])
            : entry.abortController.signal,
        });
        entry.launchTasks.add(operation);
        try {
          return spawnResultFromReceipt(await operation);
        } finally {
          entry.launchTasks.delete(operation);
        }
      },
      stop: async () => {
        await stopEntry(entry);
      },
    };
    return { handle, validateRestoredWorkspace };
  };

  function stopEntry(entry: NodeTunnelEntry, reason?: WorkerTunnelStopReason): Promise<void> {
    if (entries.get(entry.environmentId) === entry) {
      entries.delete(entry.environmentId);
    }
    entry.abortController.abort(new Error("node worker tunnel owner stopped"));
    entry.readiness.reject(new Error("node worker tunnel stopped before connecting"));
    return stopEnvironmentOwner(entry, reason, async () => {
      await entry.initialization?.catch(() => undefined);
      await Promise.allSettled(entry.launchTasks);
    });
  }

  function stopEnvironmentOwner(
    entry: NodeEnvironmentOwner,
    reason?: WorkerTunnelStopReason,
    drain?: () => Promise<void>,
  ): Promise<void> {
    if (entry.stopPromise) {
      if (entry.stopReason === reason || !retiredEntries.has(entry)) {
        return entry.stopPromise;
      }
      // Shutdown and provider reconciliation can overlap. Drain the earlier operation,
      // then apply the stronger proof without treating local fencing as physical cleanup.
      return entry.stopPromise
        .catch((error: unknown) => {
          if (!reason) {
            throw error;
          }
        })
        .then(() => (retiredEntries.has(entry) ? stopEnvironmentOwner(entry, reason) : undefined));
    }
    retiredEntries.add(entry);
    entry.stopReason = reason;
    entry.stopPromise = (async () => {
      await drain?.();
      let stopping = true;
      try {
        // Remote-exec runtimes own their processes separately; this is only the embedded
        // worker's environment lifetime, not a new requirement on the workspace transport.
        if (entry.executionMode === "worker-turn" && reason === undefined) {
          const signal = AbortSignal.timeout(DEFAULT_COMMAND_TIMEOUT_MS);
          const { transport, node } = await findNode(entry, signal);
          if (node.workerHost.environmentSession !== NODE_WORKER_ENVIRONMENT_SESSION_VERSION) {
            throw new Error(
              formatNodeRunnerUpdateRequired(node.nodeId, NODE_RUNNER_UPDATE_REQUIRED_ISSUE),
            );
          }
          // Retirement retains only authority to stop this exact old scope, including after
          // replacement. The node must match the tuple before touching any physical worker.
          const operation = transport.invoke({
            node,
            command: NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
            params: {
              gatewayNamespace,
              environmentId: entry.environmentId,
              sessionId: entry.sessionId,
              ownerEpoch: entry.ownerEpoch,
            },
            timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
            signal,
            isDispatchAuthorized: () => stopping && retiredEntries.has(entry),
          });
          const result = await raceNodeWorkerOperation(operation, signal);
          if (!result.ok) {
            throw new Error(
              `node worker environment stop failed (${result.error?.code ?? "UNAVAILABLE"})`,
            );
          }
        }
      } finally {
        stopping = false;
        await options.workspaceTransfer.close(entry.environmentId);
      }
      if (reason !== "provider-destroying") {
        retiredEntries.delete(entry);
      }
    })().finally(() => {
      // Failed or unconfirmed provider teardown keeps the exact owner retryable. Only
      // physical-stop proof may release it and make subsequent stops idempotent.
      if (retiredEntries.has(entry)) {
        entry.stopPromise = undefined;
      }
    });
    return entry.stopPromise;
  }

  async function stop(
    environmentId: string,
    ownerEpoch?: number,
    reason?: WorkerTunnelStopReason,
  ): Promise<void> {
    const matches = (entry: NodeEnvironmentOwner) =>
      entry.environmentId === environmentId &&
      (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch);
    const live = [...entries.values()].filter(matches);
    const retired = [...retiredEntries].filter(matches);
    const operations = [
      ...live.map((entry) => stopEntry(entry, reason)),
      ...retired.map((entry) => stopEnvironmentOwner(entry, reason)),
    ];
    if (operations.length === 0) {
      // A restarted Gateway has no tunnel object. The durable attachment is the only
      // source of the retired scope; bundle metadata is not cleanup authority.
      const record = options.getEnvironment(environmentId);
      if (record?.nodeDeviceId && (ownerEpoch === undefined || record.ownerEpoch === ownerEpoch)) {
        if (reason) {
          // Provider teardown owns the whole dedicated machine. No remote session tuple is
          // needed for local transfer cleanup; durable ownership remains until its proof.
          operations.push(options.workspaceTransfer.close(environmentId));
        } else {
          if (record.attachedSessionIds.length > 1) {
            throw new Error("node worker environment teardown has an ambiguous session owner");
          }
          const sessionId = record.attachedSessionIds[0];
          if (sessionId) {
            operations.push(
              stopEnvironmentOwner({
                deviceId: record.nodeDeviceId,
                environmentId,
                ownerEpoch: record.ownerEpoch,
                sessionId,
                executionMode:
                  record.profileSnapshot.executionMode === "remote-exec"
                    ? "remote-exec"
                    : "worker-turn",
              }),
            );
          }
        }
      }
    }
    const outcomes = await Promise.allSettled(operations);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }

  return {
    bindWorkspaceBindingResolver(resolver: NodeWorkerWorkspaceBindingResolver): void {
      resolveWorkspaceBinding = resolver;
    },
    async start(request: NodeWorkerTunnelStartRequest): Promise<WorkerTurnTunnelHandle> {
      const current = entries.get(request.environmentId);
      const retiring = [...retiredEntries].filter(
        (entry) => entry.environmentId === request.environmentId,
      );
      if (retiring.some((entry) => entry.ownerEpoch > request.ownerEpoch)) {
        throw new Error("node worker tunnel owner epoch is stale");
      }
      if (current) {
        if (request.ownerEpoch < current.ownerEpoch) {
          throw new Error("node worker tunnel owner epoch is stale");
        }
        if (request.ownerEpoch === current.ownerEpoch) {
          if (
            current.abortController.signal.aborted ||
            current.executionMode !== request.executionMode ||
            current.deviceId !== request.deviceId ||
            current.sessionId !== request.sessionId ||
            !sameWorkerBuild(current.expectedBuild, request.expectedBuild)
          ) {
            throw new Error("node worker tunnel owner binding changed within one epoch");
          }
          return current.readiness.promise; // Share restored-workspace validation without false readiness.
        }
      }
      const readiness = createDeferredCore<WorkerTurnTunnelHandle>();
      void readiness.promise.catch(() => undefined);
      const entry: NodeTunnelEntry = {
        ...request,
        abortController: new AbortController(),
        launchTasks: new Set(),
        readiness,
      };
      // Publish the new epoch before any teardown or initialization await so stop and replacement
      // can fence it, while exact same-owner callers share this readiness barrier.
      entries.set(entry.environmentId, entry);
      entry.initialization = (async () => {
        if (current) {
          await stopEntry(current);
        }
        await Promise.all(retiring.map((owner) => stopEnvironmentOwner(owner)));
        if (!isLiveEntry(entry)) {
          return;
        }
        const restoredWorkspace = resolveWorkspaceBinding
          ? await raceNodeWorkerOperation(
              resolveWorkspaceBinding({
                environmentId: request.environmentId,
                ownerEpoch: request.ownerEpoch,
                sessionId: request.sessionId,
              }),
              entry.abortController.signal,
            )
          : undefined;
        if (!isLiveEntry(entry)) {
          return;
        }
        const created = createHandle(entry, restoredWorkspace);
        await created.validateRestoredWorkspace();
        if (!isLiveEntry(entry)) {
          return;
        }
        entry.handle = created.handle;
        readiness.resolve(created.handle);
      })();
      void entry.initialization.catch((error: unknown) => {
        readiness.reject(error);
        // Startup already reports the owning error through readiness. Keep secondary cleanup
        // failures visible without replacing that shared result for concurrent callers.
        void stopEntry(entry).catch((cleanupError: unknown) => {
          tunnelLog.warn("node worker tunnel cleanup failed after initialization error", {
            environmentId: entry.environmentId,
            ownerEpoch: entry.ownerEpoch,
            error: boundedWorkerError(cleanupError),
          });
        });
      });
      return await readiness.promise;
    },
    stop,
    async stopAll(): Promise<void> {
      const environmentIds = new Set([
        ...entries.keys(),
        ...[...retiredEntries].map((entry) => entry.environmentId),
        ...options
          .listEnvironments()
          .filter((record) => record.nodeDeviceId)
          .map((record) => record.environmentId),
      ]);
      const stopped = await Promise.allSettled(
        [...environmentIds].map((environmentId) => stop(environmentId)),
      );
      // Shared transfer state outlives every tunnel, even when a sibling's cleanup fails.
      stopped.push(...(await Promise.allSettled([options.workspaceTransfer.closeAll()])));
      const failure = stopped.find((result) => result.status === "rejected");
      if (failure) {
        throw failure.reason;
      }
    },
    status(environmentId: string): WorkerTunnelStatus {
      const entry = entries.get(environmentId);
      return entry && !entry.abortController.signal.aborted
        ? entry.handle
          ? "connected"
          : "connecting"
        : "stopped";
    },
  };
}

export type NodeWorkerTunnelManager = ReturnType<typeof createNodeWorkerTunnelManager>;
