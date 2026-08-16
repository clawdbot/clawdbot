import fsp from "node:fs/promises";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { sleepWithAbort } from "../../infra/backoff.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
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
import { nodeWorkerGatewayNamespace } from "./node-worker-gateway-namespace.js";
import {
  createNodeWorkerWorkspaceFallback,
  recordNodeSyncPath,
} from "./node-worker-workspace-fallback.js";
import type { NodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type {
  WorkerTunnelHandle,
  WorkerTunnelStatus,
  WorkerWorkspaceCommand,
} from "./tunnel-contract.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { createWorkerWorkspaceQuiescence } from "./workspace-quiescence.js";
import {
  applyStagedWorkerWorkspace,
  assertWorkspaceResultStable,
  recoverWorkerWorkspaceReconciliation,
  type WorkerWorkspaceApplyResult,
} from "./workspace-reconcile.js";
import { workerWorkspaceResultStaging } from "./workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "./workspace-sync-scripts.js";

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
    expectedBundleHash: string;
    placementGeneration: number;
    descriptor: Parameters<WorkerTunnelHandle["launchTurn"]>[0]["plan"];
  };
  isDispatchAuthorized: () => boolean;
  isCancellationAuthorized: () => boolean;
  timeoutMs: number;
  signal?: AbortSignal;
  onDispatchReady?: () => void;
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
  workspaceTransfer: NodeWorkspaceTransferService;
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
  handle?: WorkerTunnelHandle;
  initialization?: Promise<void>;
  launchTasks: Set<Promise<unknown>>;
  readiness: Deferred<WorkerTunnelHandle>;
  stopPromise?: Promise<void>;
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
      (candidate) => candidate.nodeId === entry.deviceId,
    );
    if (!node) {
      throw new Error("device worker node is not connected with the supervisor dialect");
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
    entry: Omit<NodeTunnelEntry, "handle" | "readiness" | "initialization">,
    restoredWorkspace: NodeWorkerWorkspaceBinding | undefined,
  ): { handle: WorkerTunnelHandle; validateRestoredWorkspace: () => Promise<void> } => {
    let workspaceReady = restoredWorkspace !== undefined;
    const exec = async (command: Parameters<typeof runWorkspaceCommand>[2]) => {
      if (!workspaceReady) {
        throw new Error("node worker workspace is unavailable before sync");
      }
      return await runWorkspaceCommand(entry as NodeTunnelEntry, entry.ownerEpoch, command);
    };
    const workspace = createNodeWorkerWorkspaceFallback(exec);
    const quiesceWorkspace = createWorkerWorkspaceQuiescence({
      ownerSignal: entry.abortController.signal,
      sharedHost: true,
      runWorkspaceCommand: async (command) => await exec(command),
    });
    const captureManifest = async (remoteWorkspaceDir: string, baseCommit: string | null) => {
      const captured = await exec({
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_MANIFEST_JS,
          remoteWorkspaceDir,
          ...(baseCommit ? [baseCommit, "eligible"] : []),
        ],
        transportRetry: "idempotent",
      });
      const manifestRef = captured.stdout.trim();
      if (
        captured.termination !== "exit" ||
        captured.code !== 0 ||
        !/^sha256:[a-f0-9]{64}$/u.test(manifestRef)
      ) {
        throw new Error("Node workspace manifest capture failed");
      }
      return manifestRef;
    };
    const validateRestoredWorkspace = async (): Promise<void> => {
      if (!restoredWorkspace) {
        return;
      }
      const prepared = await options.workspaceTransfer.prepareSync({
        environmentId: entry.environmentId,
        ownerEpoch: entry.ownerEpoch,
        sessionId: entry.sessionId,
        generation: entry.ownerEpoch,
        localPath: restoredWorkspace.localPath,
        // The transfer service re-reads the durable environment and credential together.
        // This closure fences the exact in-memory tunnel instance without duplicating that read.
        isAuthorized: () => isLiveEntry(entry as NodeTunnelEntry),
        signal: entry.abortController.signal,
      });
      options.workspaceTransfer.revoke(entry.environmentId, prepared.token);
      if (prepared.snapshot.manifestRef !== restoredWorkspace.manifestRef) {
        throw new Error("Gateway workspace changed before node tunnel recovery");
      }
      const quiescence = await quiesceWorkspace(restoredWorkspace.remoteWorkspaceDir);
      try {
        const remoteManifestRef = await captureManifest(
          restoredWorkspace.remoteWorkspaceDir,
          prepared.snapshot.manifest.baseCommit,
        );
        if (remoteManifestRef !== restoredWorkspace.manifestRef) {
          throw new Error("Node workspace changed before tunnel recovery");
        }
      } finally {
        await quiescence.resume();
      }
    };
    const reconcileWorkspace = async (
      request: Parameters<WorkerTunnelHandle["reconcileWorkspace"]>[0],
    ) => {
      const pending = request.journal.load();
      if (pending) {
        await recoverWorkerWorkspaceReconciliation({ root: request.localPath, journal: pending });
        request.journal.abort();
      }
      const uploadToken = options.workspaceTransfer.prepareUpload(
        entry.environmentId,
        request.baseManifestRef,
      );
      let uploadedResult: Awaited<ReturnType<typeof exec>>;
      try {
        uploadedResult = await exec({
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: {
            direction: "upload",
            token: uploadToken,
            baseManifestRef: request.baseManifestRef,
          },
          timeoutMs: 10 * 60_000,
          transportRetry: "never",
        });
      } finally {
        options.workspaceTransfer.revoke(entry.environmentId, uploadToken);
      }
      if (uploadedResult.termination !== "exit" || uploadedResult.code !== 0) {
        throw new Error("Node workspace reconcile upload failed");
      }
      const uploaded = options.workspaceTransfer.takeUpload(
        entry.environmentId,
        request.baseManifestRef,
      );
      try {
        const changed = uploaded.currentManifestRef !== request.baseManifestRef;
        let expectedRemoteRef = uploaded.currentManifestRef;
        const verifyStable = async () => {
          const observed = await captureManifest(
            request.remoteWorkspaceDir,
            uploaded.base.baseCommit,
          );
          if (observed !== expectedRemoteRef) {
            throw new Error("Cloud workspace changed during final reconciliation");
          }
        };
        await verifyStable();
        const publishAcceptedManifest = async (accepted: {
          manifestRef: string;
          manifest: typeof uploaded.current;
          conflictPaths: string[];
        }) => {
          if (accepted.manifestRef === expectedRemoteRef) {
            return;
          }
          const baseSnapshot = options.workspaceTransfer.getSnapshot(
            entry.environmentId,
            request.baseManifestRef,
          );
          const token = options.workspaceTransfer.publishSnapshot(entry.environmentId, {
            manifest: accepted.manifest,
            manifestRef: accepted.manifestRef,
            rawManifest: serializeWorkerWorkspaceManifest(accepted.manifest),
            root: await fsp.realpath(request.localPath),
            ...(baseSnapshot?.packPath ? { packPath: baseSnapshot.packPath } : {}),
          });
          try {
            const published = await exec({
              argv: ["openclaw-internal-workspace-transfer"],
              transfer: { direction: "download", token, manifestRef: accepted.manifestRef },
              timeoutMs: 10 * 60_000,
              transportRetry: "never",
            });
            if (
              published.termination !== "exit" ||
              published.code !== 0 ||
              published.stdout.trim() !== accepted.manifestRef
            ) {
              throw new Error("Node workspace accepted manifest publication failed");
            }
            expectedRemoteRef = accepted.manifestRef;
          } finally {
            options.workspaceTransfer.revoke(entry.environmentId, token);
          }
        };
        const preparedStagedResult = request.stagedResult
          ? await workerWorkspaceResultStaging.prepareRequestedWorkerWorkspaceResult({
              request,
              stagingRoot: uploaded.stagingRoot,
              currentManifestRef: uploaded.currentManifestRef,
              baseManifestRaw: uploaded.baseRaw,
              currentManifestRaw: uploaded.currentRaw,
              publishAcceptedManifest,
            })
          : undefined;
        let appliedWorkspaceResult: WorkerWorkspaceApplyResult | undefined;
        if (!preparedStagedResult) {
          appliedWorkspaceResult = await applyStagedWorkerWorkspace({
            root: request.localPath,
            stagingRoot: uploaded.stagingRoot,
            baseManifestRef: request.baseManifestRef,
            currentManifestRef: uploaded.currentManifestRef,
            base: uploaded.base,
            current: uploaded.current,
            journal: request.journal,
            publishAcceptedManifest,
          });
        }
        return {
          get manifestRef() {
            return expectedRemoteRef;
          },
          changed,
          verifyStable,
          verifyLocalStable: async () =>
            await (appliedWorkspaceResult?.verifyLocalStable() ??
              assertWorkspaceResultStable({
                root: request.localPath,
                base: uploaded.base,
                current: uploaded.current,
              })),
          getAppliedWorkspaceResult: () => appliedWorkspaceResult,
          ...(preparedStagedResult
            ? {
                ...preparedStagedResult,
                applyPreparedStagedResult: async () => {
                  await preparedStagedResult.applyPreparedStagedResult();
                  appliedWorkspaceResult = preparedStagedResult.getAppliedWorkspaceResult();
                },
              }
            : {}),
        };
      } finally {
        await fsp.rm(uploaded.stagingRoot, { recursive: true, force: true });
      }
    };
    const handle: WorkerTunnelHandle = {
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
            expectedBundleHash: entry.expectedBuild.bundleHash,
            placementGeneration: request.placementGeneration,
            descriptor: plan,
          },
          isDispatchAuthorized,
          isCancellationAuthorized: () => hasDurableBinding(entry as NodeTunnelEntry),
          timeoutMs: request.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
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
      runWorkspaceCommand: async (command) => await exec(command),
      syncWorkspace: async (request) => {
        workspaceReady = true;
        try {
          const prepared = await options.workspaceTransfer.prepareSync({
            environmentId: entry.environmentId,
            ownerEpoch: entry.ownerEpoch,
            sessionId: entry.sessionId,
            generation: entry.ownerEpoch,
            localPath: request.localPath,
            // Durable owner state is revalidated by the transfer service after every awaited I/O.
            isAuthorized: () => isLiveEntry(entry as NodeTunnelEntry),
            signal: entry.abortController.signal,
          });
          try {
            const originStartedAt = performance.now();
            const origin = await workspace.trySyncWorkspace(request, prepared.snapshot.manifestRef);
            recordNodeSyncPath(entry.environmentId, entry.sessionId, origin, originStartedAt);
            if (origin.kind === "synced") {
              return origin.result;
            }
            const transferred = await exec({
              argv: ["openclaw-internal-workspace-transfer"],
              transfer: {
                direction: "download",
                token: prepared.token,
                manifestRef: prepared.snapshot.manifestRef,
              },
              timeoutMs: 10 * 60_000,
              transportRetry: "never",
            });
            if (
              transferred.termination !== "exit" ||
              transferred.code !== 0 ||
              transferred.stdout.trim() !== prepared.snapshot.manifestRef
            ) {
              throw new Error("Node workspace transfer failed");
            }
            return {
              mode: prepared.snapshot.manifest.baseCommit ? ("git" as const) : ("plain" as const),
              remoteWorkspaceDir: transferred.workspaceDir,
              manifestRef: prepared.snapshot.manifestRef,
            };
          } finally {
            options.workspaceTransfer.revoke(entry.environmentId, prepared.token);
          }
        } catch (error) {
          workspaceReady = restoredWorkspace !== undefined;
          throw error;
        }
      },
      quiesceWorkspace,
      reconcileWorkspace,
      stop: async () => {
        await stopEntry(entry as NodeTunnelEntry);
      },
    };
    return { handle, validateRestoredWorkspace };
  };

  function stopEntry(entry: NodeTunnelEntry): Promise<void> {
    if (entry.stopPromise) {
      return entry.stopPromise;
    }
    if (entries.get(entry.environmentId) === entry) {
      entries.delete(entry.environmentId);
    }
    entry.abortController.abort(new Error("node worker tunnel owner stopped"));
    entry.readiness.reject(new Error("node worker tunnel stopped before connecting"));
    entry.stopPromise = (async () => {
      await entry.initialization?.catch(() => undefined);
      await Promise.allSettled(entry.launchTasks);
      await options.workspaceTransfer.close(entry.environmentId);
    })();
    return entry.stopPromise;
  }

  return {
    bindWorkspaceBindingResolver(resolver: NodeWorkerWorkspaceBindingResolver): void {
      resolveWorkspaceBinding = resolver;
    },
    async start(request: NodeWorkerTunnelStartRequest): Promise<WorkerTunnelHandle> {
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
            !sameWorkerBuild(current.expectedBuild, request.expectedBuild)
          ) {
            throw new Error("node worker tunnel owner binding changed within one epoch");
          }
          return current.readiness.promise; // Share restored-workspace validation without false readiness.
        }
      }
      const readiness = createDeferredCore<WorkerTunnelHandle>();
      void readiness.promise.catch(() => undefined);
      const entry: NodeTunnelEntry = {
        ...request,
        gatewayNamespace,
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
        if (!isLiveEntry(entry)) {
          return;
        }
        const restoredWorkspace = await resolveWorkspaceBinding?.({
          environmentId: request.environmentId,
          ownerEpoch: request.ownerEpoch,
          sessionId: request.sessionId,
        });
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
        void stopEntry(entry);
      });
      return await readiness.promise;
    },
    async stop(environmentId: string, ownerEpoch?: number): Promise<void> {
      const entry = entries.get(environmentId);
      if (entry && (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch)) {
        await stopEntry(entry);
      }
    },
    async stopAll(): Promise<void> {
      await Promise.all([...entries.values()].map(stopEntry));
      await options.workspaceTransfer.closeAll();
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
