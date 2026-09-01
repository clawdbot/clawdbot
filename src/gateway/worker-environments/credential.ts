import { sha256Base64Url } from "../../infra/crypto-digest.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import {
  serializeWorkerSessionTurnClaim,
  type WorkerSessionTurnClaim,
} from "./placement-record.js";

export const WORKER_CREDENTIAL_TTL_MS = 10 * 60_000;
const WORKER_CREDENTIAL_HASH_DOMAIN = "openclaw-worker-credential-v1\0";
const WORKER_TURN_CREDENTIAL_HASH_DOMAIN = "openclaw-worker-turn-credential-v1\0";
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
> & { credential: string; deliveryId: string; turnClaim?: WorkerSessionTurnClaim };

export type WorkerCredentialBinding = Pick<
  WorkerCredentialRecord,
  "environmentId" | "ownerEpoch" | "sessionId"
>;

type WorkerCredentialMaterial = {
  credential: string;
  credentialHash: string;
};

/** Hash opaque worker credentials with their exact durable authority before persistence. */
export function hashWorkerCredential(credential: string, claim?: WorkerSessionTurnClaim): string {
  if (!claim) {
    return sha256Base64Url(`${WORKER_CREDENTIAL_HASH_DOMAIN}${credential}`);
  }
  const binding = serializeWorkerSessionTurnClaim(claim);
  return sha256Base64Url(`${WORKER_TURN_CREDENTIAL_HASH_DOMAIN}${binding}\0${credential}`);
}

/** Generate one high-entropy credential. Plaintext is returned only to its delivery owner. */
export function createWorkerCredentialMaterial(
  generateToken: (bytes: number) => string = generateSecureToken,
  claim?: WorkerSessionTurnClaim,
): WorkerCredentialMaterial {
  const credential = generateToken(WORKER_CREDENTIAL_BYTES);
  registerSecretValueForRedaction(credential);
  return {
    credential,
    credentialHash: hashWorkerCredential(credential, claim),
  };
}
