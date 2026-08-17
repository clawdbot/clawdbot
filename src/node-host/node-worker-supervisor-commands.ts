import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
  NODE_WORKER_WORKSPACE_RETAIN_COMMAND,
} from "../infra/node-commands.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE,
  NodeWorkerBundleInstallError,
  parseNodeWorkerBundleInstallInput,
  type NodeWorkerBundleInstallResult,
} from "../worker/node-bundle-install-protocol.js";
import {
  parseNodeWorkerWorkspaceExecInput,
  type NodeWorkerWorkspaceExecResult,
} from "../worker/node-workspace-protocol.js";
import {
  parseNodeWorkerWorkspaceRetainInput,
  type NodeWorkerWorkspaceRetainResult,
} from "../worker/node-workspace-retain-protocol.js";
import {
  NODE_WORKSPACE_TRANSFER_ERROR_CODE,
  NodeWorkerWorkspaceTransferError,
} from "../worker/node-workspace-transfer-protocol.js";
import {
  parseWorkerConnectionEndpoint,
  type WorkerConnectionEndpoint,
} from "../worker/worker-connection-endpoint.js";
import type { NodeWorkerBundleInstallerControl } from "./node-worker-bundle-installer.js";
import { NodeWorkerCapacityExhaustedError } from "./node-worker-capacity.js";
import {
  parseNodeWorkerCancelInput,
  parseNodeWorkerLaunchInput,
  parseNodeWorkerLookupInput,
  projectNodeWorkerSupervisorReceipt,
  type NodeWorkerSupervisorControl,
  type NodeWorkerSupervisorReceipt,
} from "./node-worker-supervisor-contract.js";
import type { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

type NodeWorkerSupervisorCommandResult =
  | { handled: false }
  | {
      handled: true;
      ok: true;
      payload:
        | NodeWorkerBundleInstallResult
        | NodeWorkerSupervisorReceipt
        | NodeWorkerWorkspaceExecResult
        | NodeWorkerWorkspaceRetainResult
        | null;
    }
  | {
      handled: true;
      ok: false;
      code:
        | "INVALID_REQUEST"
        | "UNAVAILABLE"
        | typeof NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE
        | typeof NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE
        | typeof NODE_WORKSPACE_TRANSFER_ERROR_CODE;
      message: string;
    };

function resolveWorkerConnectionEndpoint(params: {
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
}): WorkerConnectionEndpoint {
  if (!params.gatewayUrl) {
    throw new Error("node worker gateway connection unavailable");
  }
  const gateway = new URL(params.gatewayUrl);
  if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
    throw new Error("node worker gateway connection must use WebSocket transport");
  }
  const endpointUrl = new URL(gateway.toString());
  const basePath = gateway.pathname.replace(/\/$/u, "");
  endpointUrl.pathname = `${basePath}${WORKER_PUBLIC_INGRESS_PATH}`;
  endpointUrl.search = "";
  endpointUrl.hash = "";
  if (endpointUrl.host !== gateway.host) {
    throw new Error("node worker endpoint must stay on the connected gateway host");
  }
  const endpoint = parseWorkerConnectionEndpoint({
    kind: "websocket",
    url: endpointUrl.toString(),
    ...(gateway.protocol === "wss:" && params.gatewayTlsFingerprint
      ? { tlsFingerprint: params.gatewayTlsFingerprint }
      : {}),
    ...(params.gatewayCloudflareAccess ? { cloudflareAccess: params.gatewayCloudflareAccess } : {}),
  });
  if (!endpoint) {
    throw new Error("node worker gateway connection could not form a worker endpoint");
  }
  return endpoint;
}

/** Dispatches the non-advertised worker control contract before public node commands. */
export async function invokeNodeWorkerSupervisorCommand(params: {
  command: string;
  paramsJSON?: string | null;
  supervisor?: NodeWorkerSupervisorControl;
  bundleInstaller?: NodeWorkerBundleInstallerControl;
  workspace?: NodeWorkerWorkspaceRuntime;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  signal?: AbortSignal;
}): Promise<NodeWorkerSupervisorCommandResult> {
  const recognized =
    params.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND ||
    params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND ||
    params.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND ||
    params.command === NODE_WORKER_SUPERVISOR_CANCEL_COMMAND ||
    params.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND ||
    params.command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND;
  if (!recognized) {
    return { handled: false };
  }
  if (
    (params.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND && !params.bundleInstaller) ||
    (params.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND && !params.workspace) ||
    (params.command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND && !params.supervisor) ||
    (params.command !== NODE_WORKER_BUNDLE_INSTALL_COMMAND &&
      params.command !== NODE_WORKER_WORKSPACE_EXEC_COMMAND &&
      params.command !== NODE_WORKER_WORKSPACE_RETAIN_COMMAND &&
      !params.supervisor)
  ) {
    return {
      handled: true,
      ok: false,
      code: "UNAVAILABLE",
      message: "node worker runtime unavailable",
    };
  }
  try {
    if (params.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND) {
      if (!params.gatewayUrl) {
        throw new Error("node worker gateway connection unavailable");
      }
      return {
        handled: true,
        ok: true,
        payload: await params.bundleInstaller!.ensure({
          input: parseNodeWorkerBundleInstallInput(params.paramsJSON),
          gatewayUrl: params.gatewayUrl,
          ...(params.gatewayTlsFingerprint
            ? { gatewayTlsFingerprint: params.gatewayTlsFingerprint }
            : {}),
          ...(params.gatewayCloudflareAccess
            ? { gatewayCloudflareAccess: params.gatewayCloudflareAccess }
            : {}),
          signal: params.signal,
        }),
      };
    }
    if (params.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND) {
      return {
        handled: true,
        ok: true,
        payload: await params.workspace!.exec(
          parseNodeWorkerWorkspaceExecInput(params.paramsJSON),
          params.signal,
          params.gatewayUrl
            ? {
                url: params.gatewayUrl,
                ...(params.gatewayTlsFingerprint
                  ? { tlsFingerprint: params.gatewayTlsFingerprint }
                  : {}),
                ...(params.gatewayCloudflareAccess
                  ? { cloudflareAccess: params.gatewayCloudflareAccess }
                  : {}),
              }
            : undefined,
        ),
      };
    }
    if (params.command === NODE_WORKER_WORKSPACE_RETAIN_COMMAND) {
      const input = parseNodeWorkerWorkspaceRetainInput(params.paramsJSON);
      const workspace = await params.supervisor!.retainWorkspaces(input, params.signal);
      let bundles: { deleted: number; hasMore: boolean; generation: number } | undefined;
      if (workspace.applied && input.bundleHashes) {
        if (!params.bundleInstaller?.retain) {
          throw new Error("node worker bundle retention unavailable");
        }
        bundles = await params.bundleInstaller.retain({
          gatewayNamespace: input.gatewayNamespace,
          bundleHashes: input.bundleHashes,
          ...(input.acknowledgedBundleGeneration !== undefined
            ? { acknowledgedGeneration: input.acknowledgedBundleGeneration }
            : {}),
        });
      }
      const hasMore = workspace.hasMore || bundles?.hasMore === true;
      const inspectBundle = params.bundleInstaller?.inspect?.bind(params.bundleInstaller);
      if (workspace.applied && input.bundleStatusHash && !hasMore && !inspectBundle) {
        throw new Error("node worker bundle status unavailable");
      }
      const bundleStatus =
        workspace.applied && input.bundleStatusHash && !hasMore && inspectBundle
          ? await inspectBundle({
              gatewayNamespace: input.gatewayNamespace,
              bundleHash: input.bundleStatusHash,
            })
          : undefined;
      return {
        handled: true,
        ok: true,
        payload:
          bundles || bundleStatus
            ? {
                ...workspace,
                ...(bundles
                  ? {
                      bundleDeleted: bundles.deleted,
                      bundleGeneration: bundles.generation,
                      hasMore,
                    }
                  : {}),
                ...(bundleStatus ? { bundleStatus } : {}),
              }
            : workspace,
      };
    }
    const receipt =
      params.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND
        ? await params.supervisor!.launch(
            parseNodeWorkerLaunchInput(params.paramsJSON),
            resolveWorkerConnectionEndpoint(params),
            params.signal,
          )
        : params.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND
          ? await params.supervisor!.status(parseNodeWorkerLookupInput(params.paramsJSON).launchId)
          : await params.supervisor!.cancel(parseNodeWorkerCancelInput(params.paramsJSON));
    return {
      handled: true,
      ok: true,
      payload: receipt ? projectNodeWorkerSupervisorReceipt(receipt) : null,
    };
  } catch (error) {
    const invalid = error instanceof Error && error.message.startsWith("INVALID_REQUEST:");
    const bundleInstallFailure = error instanceof NodeWorkerBundleInstallError;
    const capacityFailure = error instanceof NodeWorkerCapacityExhaustedError;
    const transferFailure = error instanceof NodeWorkerWorkspaceTransferError;
    return {
      handled: true,
      ok: false,
      code: invalid
        ? "INVALID_REQUEST"
        : bundleInstallFailure
          ? NODE_WORKER_BUNDLE_INSTALL_ERROR_CODE
          : capacityFailure
            ? NODE_WORKER_CAPACITY_EXHAUSTED_ERROR_CODE
            : transferFailure
              ? NODE_WORKSPACE_TRANSFER_ERROR_CODE
              : "UNAVAILABLE",
      message:
        invalid || bundleInstallFailure || capacityFailure || transferFailure
          ? error.message
          : "node worker supervisor command failed",
    };
  }
}
