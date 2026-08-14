import { createHash } from "node:crypto";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import type { SpawnResult } from "../../process/exec.js";
import type { NodeWorkerSupervisorReceipt } from "../../worker/node-supervisor-protocol.js";
import {
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../../worker/node-workspace-protocol.js";
import type {
  NodeWorkerSupervisorNodeProof,
  NodeWorkerSupervisorTransport,
} from "../node-registry-private.js";
import { createNodeWorkerWorkspaceFallback } from "./node-worker-workspace-fallback.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelStatus,
  WorkerWorkspaceCommand,
} from "./tunnel-contract.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const RETRY_DELAY_MS = 100;
const RETRYABLE_TRANSPORT_CODES = new Set([
  "DISCONNECTED",
  "NOT_CONNECTED",
  "PAIRING_CHANGED",
  "PRIVATE_DIALECT_UNAVAILABLE",
  "ROUTE_CHANGED",
  "TIMEOUT",
  "UNAVAILABLE",
]);

type TerminalNodeWorkerSupervisorReceipt = Extract<
  NodeWorkerSupervisorReceipt,
  { state: "completed" | "failed" | "interrupted" | "cancelled" }
>;

type NodeWorkerLaunch = (request: {
  deviceId: string;
  input: {
    launchId: string;
    gatewayNamespace: string;
    installKind: "local";
    expectedBundleHash: string;
    placementGeneration: number;
    descriptor: Parameters<WorkerTunnelHandle["launchTurn"]>[0]["plan"];
  };
  isDispatchAuthorized: () => boolean;
  isCancellationAuthorized: () => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<TerminalNodeWorkerSupervisorReceipt>;

type NodeWorkerWorkspaceBinding = {
  localPath: string;
  manifestRef: string;
  remoteWorkspaceDir: string;
};

export type NodeWorkerWorkspaceBindingResolver = (binding: {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
}) => Promise<NodeWorkerWorkspaceBinding | undefined>;

type NodeWorkerTunnelManagerOptions = {
  gatewayDeviceId: string;
  getEnvironment: (environmentId: string) => WorkerEnvironmentRecord | undefined;
  getTransport: () => NodeWorkerSupervisorTransport | undefined;
  launchNodeWorker: NodeWorkerLaunch;
  validateWorkerTurn: (binding: {
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    runId: string;
  }) => boolean;
};

type NodeWorkerTunnelStartRequest = {
  environmentId: string;
  ownerEpoch: number;
  deviceId: string;
  sessionId: string;
  expectedBuild: WorkerAdmissionHandshake;
};

type NodeTunnelEntry = NodeWorkerTunnelStartRequest & {
  abortController: AbortController;
  gatewayNamespace: string;
  handle: WorkerTunnelHandle;
  launchTasks: Set<Promise<unknown>>;
  stopPromise?: Promise<void>;
};

function exactBuild(
  actual: WorkerAdmissionHandshake | undefined,
  expected: WorkerAdmissionHandshake,
): boolean {
  return (
    actual?.bundleHash === expected.bundleHash &&
    actual.openclawVersion === expected.openclawVersion &&
    actual.protocolFeatures.length === expected.protocolFeatures.length &&
    actual.protocolFeatures
      .toSorted()
      .every((feature, index) => feature === expected.protocolFeatures.toSorted()[index])
  );
}

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

function raceWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () =>
    signal.reason instanceof Error ? signal.reason : new Error("node worker operation aborted");
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error("node worker operation failed"));
      },
    );
  });
}

/** Owns node-channel handles without treating the persistent machine as a disposable lease. */
export function createNodeWorkerTunnelManager(options: NodeWorkerTunnelManagerOptions) {
  const entries = new Map<string, NodeTunnelEntry>();
  const pendingStarts = new Map<string, { ownerEpoch: number; cancelled: boolean }>();
  let resolveWorkspaceBinding: NodeWorkerWorkspaceBindingResolver | undefined;
  const gatewayNamespace = `gateway-${createHash("sha256")
    .update(options.gatewayDeviceId)
    .digest("hex")
    .slice(0, 32)}`;

  const hasDurableBinding = (entry: NodeTunnelEntry): boolean => {
    const current = options.getEnvironment(entry.environmentId);
    return Boolean(
      current &&
      current.ownerEpoch === entry.ownerEpoch &&
      current.bootstrapReceipt?.installKind === "local" &&
      exactBuild(current.bootstrapReceipt, entry.expectedBuild) &&
      current.attachedSessionIds.length <= 1 &&
      (current.attachedSessionIds.length === 0 ||
        current.attachedSessionIds[0] === entry.sessionId),
    );
  };

  const isEnvironmentOwner = (entry: NodeTunnelEntry): boolean =>
    hasDurableBinding(entry) &&
    entries.get(entry.environmentId) === entry &&
    !entry.abortController.signal.aborted;

  const findNode = async (
    entry: NodeTunnelEntry,
    signal: AbortSignal,
  ): Promise<{
    transport: NodeWorkerSupervisorTransport;
    node: NodeWorkerSupervisorNodeProof;
  }> => {
    const transport = options.getTransport();
    if (!transport) {
      throw new Error("device worker node transport is unavailable");
    }
    const node = (await raceWithSignal(transport.listCurrentNodes(), signal)).find(
      (candidate) =>
        candidate.nodeId === entry.deviceId &&
        exactBuild(candidate.workerRuns, entry.expectedBuild),
    );
    if (!node) {
      throw new Error("device worker node is not connected with the expected build");
    }
    return { transport, node };
  };

  const runWorkspaceCommand = async (
    entry: NodeTunnelEntry,
    generation: number,
    command: WorkerWorkspaceCommand & { resetWorkspace?: boolean },
  ): Promise<NodeWorkerWorkspaceExecResult> => {
    const timeoutMs = command.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const signals = [entry.abortController.signal, AbortSignal.timeout(timeoutMs)];
    if (command.signal) {
      signals.push(command.signal);
    }
    const signal = AbortSignal.any(signals);
    const input: NodeWorkerWorkspaceExecInput = {
      gatewayNamespace,
      environmentId: entry.environmentId,
      sessionId: entry.sessionId,
      generation,
      argv: [...command.argv],
      ...(command.input === undefined ? {} : { input: command.input }),
      ...(command.timeoutMs === undefined ? {} : { timeoutMs: command.timeoutMs }),
      ...(command.resetWorkspace === undefined ? {} : { resetWorkspace: command.resetWorkspace }),
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
        if (command.transportRetry === "idempotent" && RETRYABLE_TRANSPORT_CODES.has(code)) {
          await sleepWithAbort(Math.min(RETRY_DELAY_MS, remainingMs), signal);
          continue;
        }
        throw new Error(`node workspace command failed (${code})`);
      }
      const parsed = parseNodeWorkerWorkspaceExecResult(payloadJson(result.payloadJSON));
      if (!parsed) {
        throw new Error("node workspace command violated its private result contract");
      }
      return parsed;
    }
  };

  const createHandle = (
    entry: Omit<NodeTunnelEntry, "handle">,
    restoredWorkspace: NodeWorkerWorkspaceBinding | undefined,
  ): WorkerTunnelHandle => {
    let workspaceReady = restoredWorkspace !== undefined;
    const exec = async (command: Parameters<typeof runWorkspaceCommand>[2]) => {
      if (!workspaceReady) {
        throw new Error("node worker workspace is unavailable before sync");
      }
      return await runWorkspaceCommand(entry as NodeTunnelEntry, entry.ownerEpoch, command);
    };
    const workspace = createNodeWorkerWorkspaceFallback(exec, restoredWorkspace);
    return {
      environmentId: entry.environmentId,
      ownerEpoch: entry.ownerEpoch,
      launchTurn: async (request) => {
        const plan = request.plan;
        const isDispatchAuthorized = () =>
          isEnvironmentOwner(entry as NodeTunnelEntry) &&
          options.validateWorkerTurn({
            environmentId: entry.environmentId,
            ownerEpoch: entry.ownerEpoch,
            sessionId: plan.admission.sessionId,
            runId: plan.assignment.runId,
          });
        const operation = options.launchNodeWorker({
          deviceId: entry.deviceId,
          input: {
            launchId: plan.assignment.turnId,
            gatewayNamespace,
            installKind: "local",
            expectedBundleHash: entry.expectedBuild.bundleHash,
            placementGeneration: request.placementGeneration,
            descriptor: plan,
          },
          isDispatchAuthorized,
          isCancellationAuthorized: () => hasDurableBinding(entry as NodeTunnelEntry),
          timeoutMs: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
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
      runWorkspaceCommand: async (command) => await exec(command),
      syncWorkspace: async (request) => {
        workspaceReady = true;
        try {
          return await workspace.syncWorkspace(request);
        } catch (error) {
          workspaceReady = restoredWorkspace !== undefined;
          throw error;
        }
      },
      quiesceWorkspace: async (remoteWorkspaceDir) =>
        await workspace.quiesceWorkspace(remoteWorkspaceDir),
      reconcileWorkspace: async (request) => await workspace.reconcileWorkspace(request),
      stop: async () => {
        await stopEntry(entry as NodeTunnelEntry);
      },
    };
  };

  function stopEntry(entry: NodeTunnelEntry): Promise<void> {
    if (entry.stopPromise) {
      return entry.stopPromise;
    }
    entry.abortController.abort(new Error("node worker tunnel owner stopped"));
    entry.stopPromise = Promise.allSettled(entry.launchTasks).then(() => {
      if (entries.get(entry.environmentId) === entry) {
        entries.delete(entry.environmentId);
      }
    });
    return entry.stopPromise;
  }

  return {
    bindWorkspaceBindingResolver(resolver: NodeWorkerWorkspaceBindingResolver): void {
      resolveWorkspaceBinding = resolver;
    },
    async start(request: NodeWorkerTunnelStartRequest): Promise<WorkerTunnelHandle> {
      const pending = { ownerEpoch: request.ownerEpoch, cancelled: false };
      pendingStarts.set(request.environmentId, pending);
      try {
        const current = entries.get(request.environmentId);
        if (current) {
          if (request.ownerEpoch < current.ownerEpoch) {
            throw new Error("node worker tunnel owner epoch is stale");
          }
          if (request.ownerEpoch === current.ownerEpoch) {
            if (
              current.abortController.signal.aborted ||
              current.deviceId !== request.deviceId ||
              current.sessionId !== request.sessionId ||
              !exactBuild(current.expectedBuild, request.expectedBuild)
            ) {
              throw new Error("node worker tunnel owner binding changed within one epoch");
            }
            return current.handle;
          }
          await stopEntry(current);
        }
        if (pending.cancelled || pendingStarts.get(request.environmentId) !== pending) {
          throw new Error("node worker tunnel start was cancelled");
        }
        const restoredWorkspace = await resolveWorkspaceBinding?.({
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          sessionId: request.sessionId,
        });
        if (pending.cancelled || pendingStarts.get(request.environmentId) !== pending) {
          throw new Error("node worker tunnel start was cancelled");
        }
        const base = {
          ...request,
          gatewayNamespace,
          abortController: new AbortController(),
          launchTasks: new Set<Promise<unknown>>(),
        };
        const entry = { ...base, handle: undefined as unknown as WorkerTunnelHandle };
        entry.handle = createHandle(entry, restoredWorkspace);
        entries.set(entry.environmentId, entry);
        try {
          if (restoredWorkspace) {
            await entry.handle.quiesceWorkspace(restoredWorkspace.remoteWorkspaceDir);
          }
          if (pending.cancelled || pendingStarts.get(request.environmentId) !== pending) {
            throw new Error("node worker tunnel start was cancelled");
          }
          return entry.handle;
        } catch (error) {
          await stopEntry(entry);
          throw error;
        }
      } finally {
        if (pendingStarts.get(request.environmentId) === pending) {
          pendingStarts.delete(request.environmentId);
        }
      }
    },
    async stop(environmentId: string, ownerEpoch?: number): Promise<void> {
      const pending = pendingStarts.get(environmentId);
      if (pending && (ownerEpoch === undefined || ownerEpoch === pending.ownerEpoch)) {
        pending.cancelled = true;
      }
      const entry = entries.get(environmentId);
      if (entry && (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch)) {
        await stopEntry(entry);
      }
    },
    async stopAll(): Promise<void> {
      for (const pending of pendingStarts.values()) {
        pending.cancelled = true;
      }
      await Promise.all([...entries.values()].map(stopEntry));
    },
    status(environmentId: string): WorkerTunnelStatus {
      const entry = entries.get(environmentId);
      return entry && !entry.abortController.signal.aborted ? "connected" : "stopped";
    },
  };
}

export type NodeWorkerTunnelManager = ReturnType<typeof createNodeWorkerTunnelManager>;
