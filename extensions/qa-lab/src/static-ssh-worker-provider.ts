// QA Lab static-SSH worker provider for cloud-worker feature development.
import type {
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
} from "openclaw/plugin-sdk/plugin-entry";
import { WorkerProviderError } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef, isValidSecretRef } from "openclaw/plugin-sdk/secret-input";

export const STATIC_SSH_WORKER_PROVIDER_ID = "static-ssh";

const STATIC_SSH_LEASE_PREFIX = `${STATIC_SSH_WORKER_PROVIDER_ID}:`;
const DEFAULT_SSH_PORT = 22;
// Host public keys are small; cap provider-controlled input before persistence.
const MAX_HOST_KEY_LENGTH = 16_384;
const OPENSSH_HOST_KEY_TYPE_PATTERN =
  /^(?:ssh|ecdsa-sha2|sk-(?:ssh|ecdsa-sha2))-[A-Za-z0-9@._+-]+$/u;
const OPENSSH_HOST_KEY_DATA_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/u;
const INVALID_HOST_KEY_MESSAGE =
  "static-ssh profile hostKey must be one OpenSSH public key line containing only the key type and base64 key, without options or comments";

function readRequiredString(profile: WorkerProfile, key: "host" | "user"): string {
  const value = profile[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new WorkerProviderError(`static-ssh profile ${key} must be a non-empty string`);
  }
  return value.trim();
}

function readRequiredHostKey(profile: WorkerProfile): string {
  const value = profile.hostKey;
  if (typeof value !== "string" || value.length > MAX_HOST_KEY_LENGTH || /[\r\n]/u.test(value)) {
    throw new WorkerProviderError(INVALID_HOST_KEY_MESSAGE);
  }
  const trimmed = value.trim();
  const tokens = trimmed.split(/[ \t]+/u);
  const [keyType, keyData] = tokens;
  if (
    !trimmed ||
    tokens.length !== 2 ||
    !OPENSSH_HOST_KEY_TYPE_PATTERN.test(keyType ?? "") ||
    !OPENSSH_HOST_KEY_DATA_PATTERN.test(keyData ?? "") ||
    (keyData?.length ?? 0) % 4 !== 0
  ) {
    throw new WorkerProviderError(INVALID_HOST_KEY_MESSAGE);
  }
  return trimmed;
}

function parseStaticSshWorkerSettings(profile: WorkerProfile): WorkerSshEndpoint {
  const port = profile.port ?? DEFAULT_SSH_PORT;
  if (typeof port !== "number" || !Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WorkerProviderError(
      "static-ssh profile port must be an integer from 1 through 65535",
    );
  }
  const keyRef = profile.keyRef;
  if (!isSecretRef(keyRef) || !isValidSecretRef(keyRef)) {
    throw new WorkerProviderError("static-ssh profile keyRef must be a SecretRef");
  }
  return {
    host: readRequiredString(profile, "host"),
    port,
    user: readRequiredString(profile, "user"),
    hostKey: readRequiredHostKey(profile),
    keyRef,
  };
}

export function createStaticSshWorkerProvider(): WorkerProvider {
  return {
    id: STATIC_SSH_WORKER_PROVIDER_ID,
    async provision(profile, opId) {
      if (!opId.trim()) {
        throw new Error("static-ssh provision operation id must be non-empty");
      }
      return {
        leaseId: `${STATIC_SSH_LEASE_PREFIX}${opId}`,
        ssh: parseStaticSshWorkerSettings(profile),
      };
    },
    async inspect({ leaseId }) {
      const active =
        leaseId.startsWith(STATIC_SSH_LEASE_PREFIX) &&
        leaseId.length > STATIC_SSH_LEASE_PREFIX.length;
      return { status: active ? "active" : "unknown" };
    },
    // Development-only: a static worker is a shared host, not an isolation boundary.
    // Destroy releases the logical lease; it does not stop or clean the host.
    async destroy(_lease) {},
  };
}
