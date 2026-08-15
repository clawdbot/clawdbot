import fsp from "node:fs/promises";
import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";
import type { NodeWorkerBundleInstallInput } from "../../worker/node-bundle-install-protocol.js";
import type { NodeWorkerSupervisorNodeProof } from "../node-registry-private.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";
import type { WorkerInstallationArtifact } from "./bundle.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

type WorkerBundleArtifact = Extract<WorkerInstallationArtifact, { install: "bundle" }>;

type BundleTransferCapability = {
  token: string;
  nodeId: string;
  connId: string;
  pairingGeneration: string;
  gatewayNamespace: string;
  artifact: WorkerBundleArtifact;
  expiresAtMs: number;
  state: "ready" | "serving";
  abortController: AbortController;
  stopWatchingSignal?: () => void;
  isAuthorized: () => boolean;
};

function mintToken(generateToken: (bytes: number) => string): string {
  const token = generateToken(32);
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("Worker bundle transfer token generator returned an invalid bearer");
  }
  registerSecretValueForRedaction(token);
  return token;
}

export function createNodeWorkerBundleTransferService(
  options: {
    now?: () => number;
    generateToken?: (bytes: number) => string;
  } = {},
) {
  const now = options.now ?? Date.now;
  const generateToken = options.generateToken ?? generateSecureToken;
  const capabilities = new Map<string, BundleTransferCapability>();

  const isCurrent = (capability: BundleTransferCapability): boolean =>
    capabilities.get(capability.token) === capability &&
    capability.state === "serving" &&
    capability.expiresAtMs > now() &&
    !capability.abortController.signal.aborted &&
    capability.isAuthorized();

  const revokeCapability = (capability: BundleTransferCapability): void => {
    if (capabilities.get(capability.token) === capability) {
      capabilities.delete(capability.token);
    }
    capability.stopWatchingSignal?.();
    if (!capability.abortController.signal.aborted) {
      capability.abortController.abort(new Error("Worker bundle transfer capability closed"));
    }
  };

  return {
    prepare(params: {
      node: NodeWorkerSupervisorNodeProof;
      gatewayNamespace: string;
      artifact: WorkerBundleArtifact;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }): { token: string; input: NodeWorkerBundleInstallInput } {
      if (
        !Number.isSafeInteger(params.artifact.tarballBytes) ||
        params.artifact.tarballBytes < 1 ||
        params.artifact.tarballBytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES
      ) {
        throw new Error("Worker bundle archive exceeds the node transfer limit");
      }
      if (!params.isAuthorized()) {
        throw new Error("Worker bundle transfer authority is unavailable");
      }
      const token = mintToken(generateToken);
      const abortController = new AbortController();
      const capability: BundleTransferCapability = {
        token,
        nodeId: params.node.nodeId,
        connId: params.node.connId,
        pairingGeneration: params.node.pairingGeneration,
        gatewayNamespace: params.gatewayNamespace,
        artifact: params.artifact,
        expiresAtMs: now() + workerBootstrapOperationTimeoutMs(params.artifact),
        state: "ready",
        abortController,
        isAuthorized: params.isAuthorized,
      };
      if (params.signal) {
        const abort = () => revokeCapability(capability);
        params.signal.addEventListener("abort", abort, { once: true });
        capability.stopWatchingSignal = () => params.signal?.removeEventListener("abort", abort);
        if (params.signal.aborted) {
          abort();
        }
      }
      if (abortController.signal.aborted) {
        throw new Error("Worker bundle transfer authority is unavailable");
      }
      capabilities.set(token, capability);
      return {
        token,
        input: {
          gatewayNamespace: params.gatewayNamespace,
          build: {
            bundleHash: params.artifact.bundleHash,
            openclawVersion: params.artifact.openclawVersion,
            protocolFeatures: [...params.artifact.protocolFeatures],
          },
          archive: {
            token,
            sha256: params.artifact.tarballSha256,
            bytes: params.artifact.tarballBytes,
          },
        },
      };
    },

    authorize(params: { token: string; bundleHash: string }): BundleTransferCapability | undefined {
      const capability = capabilities.get(params.token);
      if (
        !capability ||
        capability.state !== "ready" ||
        capability.expiresAtMs <= now() ||
        capability.abortController.signal.aborted ||
        !capability.isAuthorized() ||
        capability.artifact.bundleHash !== params.bundleHash
      ) {
        return undefined;
      }
      capability.state = "serving";
      return capability;
    },

    isAuthorizationCurrent: isCurrent,

    authorizationSignal(capability: BundleTransferCapability): AbortSignal {
      return capability.abortController.signal;
    },

    async file(capability: BundleTransferCapability): Promise<{
      path: string;
      bytes: number;
      sha256: string;
    } | null> {
      if (!isCurrent(capability)) {
        return null;
      }
      const stats = await fsp.lstat(capability.artifact.tarballPath);
      if (
        stats.isSymbolicLink() ||
        !stats.isFile() ||
        stats.size !== capability.artifact.tarballBytes ||
        !isCurrent(capability)
      ) {
        return null;
      }
      return {
        path: capability.artifact.tarballPath,
        bytes: capability.artifact.tarballBytes,
        sha256: capability.artifact.tarballSha256,
      };
    },

    revoke(capabilityOrToken: BundleTransferCapability | string): void {
      const capability =
        typeof capabilityOrToken === "string"
          ? capabilities.get(capabilityOrToken)
          : capabilityOrToken;
      if (capability) {
        revokeCapability(capability);
      }
    },

    closeAll(): void {
      for (const capability of capabilities.values()) {
        revokeCapability(capability);
      }
    },
  };
}

export type NodeWorkerBundleTransferService = ReturnType<
  typeof createNodeWorkerBundleTransferService
>;
