import { openLocalFileSafely } from "../../infra/fs-safe.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { MAX_WORKER_BUNDLE_ARCHIVE_BYTES } from "../../shared/worker-bundle-limits.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export type TransferArtifact = {
  tarballPath: string;
  tarballSha256: string;
  tarballBytes: number;
};

type ArtifactTransferAuthorization = {
  token: string;
  artifactKey: string;
  artifact: TransferArtifact;
  expiresAtMs: number;
  state: "ready" | "serving";
  abortController: AbortController;
  stopWatching?: () => void;
  isAuthorized: () => boolean;
};

export type ArtifactTransferOptions = {
  now?: () => number;
  generateToken?: (bytes: number) => string;
};

export function createArtifactTransferService(options: ArtifactTransferOptions = {}) {
  const now = options.now ?? Date.now;
  const generateToken = options.generateToken ?? generateSecureToken;
  const capabilities = new Map<string, ArtifactTransferAuthorization>();

  const revokeCapability = (capability: ArtifactTransferAuthorization): void => {
    if (capabilities.get(capability.token) === capability) {
      capabilities.delete(capability.token);
    }
    capability.stopWatching?.();
    capability.abortController.abort(new Error("Worker artifact transfer authority closed"));
  };

  const hasAuthority = (capability: ArtifactTransferAuthorization): boolean => {
    try {
      if (
        capabilities.get(capability.token) === capability &&
        capability.expiresAtMs > now() &&
        !capability.abortController.signal.aborted &&
        capability.isAuthorized()
      ) {
        return true;
      }
    } catch {
      // A lost or throwing owner closes the capability; bearer possession cannot revive it.
    }
    revokeCapability(capability);
    return false;
  };

  const isCurrent = (capability: ArtifactTransferAuthorization): boolean =>
    hasAuthority(capability) && capability.state === "serving";

  return {
    prepare(params: {
      artifact: TransferArtifact;
      artifactKey: string;
      ttlMs: number;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }): { token: string; expiresAtMs: number } {
      if (
        !Number.isSafeInteger(params.artifact.tarballBytes) ||
        params.artifact.tarballBytes < 1 ||
        params.artifact.tarballBytes > MAX_WORKER_BUNDLE_ARCHIVE_BYTES ||
        !SHA256_PATTERN.test(params.artifact.tarballSha256) ||
        !SHA256_PATTERN.test(params.artifactKey)
      ) {
        throw new Error("Worker artifact archive is invalid or exceeds the transfer limit");
      }
      const token = generateToken(32);
      if (!TOKEN_PATTERN.test(token) || capabilities.has(token)) {
        throw new Error("Worker artifact transfer token generator returned an invalid bearer");
      }
      registerSecretValueForRedaction(token);
      const capability: ArtifactTransferAuthorization = {
        token,
        artifactKey: params.artifactKey,
        artifact: { ...params.artifact },
        expiresAtMs: now() + params.ttlMs,
        state: "ready",
        abortController: new AbortController(),
        isAuthorized: params.isAuthorized,
      };
      capabilities.set(token, capability);
      const revoke = () => revokeCapability(capability);
      const timeout = setTimeout(revoke, params.ttlMs);
      timeout.unref();
      params.signal?.addEventListener("abort", revoke, { once: true });
      capability.stopWatching = () => {
        clearTimeout(timeout);
        params.signal?.removeEventListener("abort", revoke);
      };
      if (params.signal?.aborted) {
        revoke();
      }
      if (!hasAuthority(capability)) {
        throw new Error("Worker artifact transfer authority is unavailable");
      }
      return { token, expiresAtMs: capability.expiresAtMs };
    },

    authorize(params: { token: string; artifactKey: string }) {
      const capability = capabilities.get(params.token);
      if (
        !capability ||
        !hasAuthority(capability) ||
        capability.state !== "ready" ||
        capability.artifactKey !== params.artifactKey
      ) {
        return undefined;
      }
      capability.state = "serving";
      return capability;
    },

    isAuthorizationCurrent: isCurrent,

    authorizationSignal(capability: ArtifactTransferAuthorization): AbortSignal {
      return capability.abortController.signal;
    },

    async openFile(capability: ArtifactTransferAuthorization) {
      if (!isCurrent(capability)) {
        return null;
      }
      // Keep the descriptor from validation through streaming; never reopen a swapped path.
      const { handle, stat } = await openLocalFileSafely({
        filePath: capability.artifact.tarballPath,
      });
      let accepted = false;
      try {
        if (stat.size !== capability.artifact.tarballBytes || !isCurrent(capability)) {
          return null;
        }
        accepted = true;
        return {
          handle,
          bytes: capability.artifact.tarballBytes,
          sha256: capability.artifact.tarballSha256,
        };
      } finally {
        if (!accepted) {
          await handle.close();
        }
      }
    },

    revoke(capabilityOrToken: ArtifactTransferAuthorization | string): void {
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

export type ArtifactTransferService = ReturnType<typeof createArtifactTransferService>;
