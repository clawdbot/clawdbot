import { sha256Base64Url } from "../../infra/crypto-digest.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";

export const WORKER_CREDENTIAL_TTL_MS = 10 * 60_000;
const WORKER_CREDENTIAL_HASH_DOMAIN = "openclaw-worker-credential-v1\0";
const WORKER_CREDENTIAL_BYTES = 32;

export type WorkerCredentialRecord = {
  environmentId: string;
  credentialHash: string;
  bundleHash: string;
  sessionId: string | null;
  rpcSetVersion: number;
  ownerEpoch: number;
  expiresAtMs: number;
  deliveredAtMs: number | null;
};

export type MintedWorkerCredential = Omit<
  WorkerCredentialRecord,
  "credentialHash" | "deliveredAtMs"
> & { credential: string; deliveryId: string };

export type WorkerCredentialBinding = Pick<
  WorkerCredentialRecord,
  "environmentId" | "ownerEpoch" | "sessionId"
>;

export type WorkerCredentialDeliveryClaim = WorkerCredentialBinding &
  Pick<MintedWorkerCredential, "deliveryId">;

type WorkerCredentialMaterial = {
  credential: string;
  credentialHash: string;
};

/** Hash opaque worker credentials with a domain separator before persistence. */
export function hashWorkerCredential(credential: string): string {
  return sha256Base64Url(`${WORKER_CREDENTIAL_HASH_DOMAIN}${credential}`);
}

/** Generate one high-entropy credential. Plaintext is returned only to its delivery owner. */
export function createWorkerCredentialMaterial(
  generateToken: (bytes: number) => string = generateSecureToken,
): WorkerCredentialMaterial {
  const credential = generateToken(WORKER_CREDENTIAL_BYTES);
  registerSecretValueForRedaction(credential);
  return {
    credential,
    credentialHash: hashWorkerCredential(credential),
  };
}
