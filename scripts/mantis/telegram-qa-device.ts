import { copyFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { generateStoredDeviceIdentity } from "../../src/infra/device-identity-store.ts";
import { approveDevicePairing } from "../../src/infra/device-pairing-approval.ts";
import { requestDevicePairing } from "../../src/infra/device-pairing.ts";
import { publicKeyRawBase64UrlFromEd25519Pem } from "../../src/infra/ed25519-signature.ts";
import { closeOpenClawStateDatabaseByPath } from "../../src/state/openclaw-state-db-cache.ts";
import { openOpenClawStateDatabase } from "../../src/state/openclaw-state-db.ts";

export const telegramQaObserverScopes = ["operator.read", "operator.write"];

// Standard owner pairing for a fresh synthetic Gateway. Only its server-side
// state crosses into the candidate; the observer private identity stays in RAM.
export async function prepareTelegramQaDevice(scratch: string) {
  const identity = generateStoredDeviceIdentity();
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(identity.publicKeyPem);
  const seed = await mkdtemp(path.join(scratch, ".pairing-"));
  const databasePath = path.join(seed, "state", "openclaw.sqlite");
  try {
    const pending = await requestDevicePairing(
      {
        deviceId: identity.deviceId,
        publicKey,
        platform: process.platform,
        clientId: "gateway-client",
        clientMode: "backend",
        role: "operator",
        scopes: [...telegramQaObserverScopes],
      },
      seed,
    );
    const approved = await approveDevicePairing(
      pending.request.requestId,
      { callerScopes: telegramQaObserverScopes, approvedVia: "owner" },
      seed,
    );
    if (
      approved?.status !== "approved" ||
      approved.device.deviceId !== identity.deviceId ||
      approved.device.publicKey !== publicKey ||
      JSON.stringify(approved.device.approvedScopes?.toSorted()) !==
        JSON.stringify(telegramQaObserverScopes.toSorted())
    ) {
      throw new Error("Synthetic QA observer pairing was not approved exactly");
    }
    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: seed },
    });
    if (!database.walMaintenance.close({ checkpointMode: "TRUNCATE" })) {
      throw new Error("Synthetic QA pairing checkpoint did not complete");
    }
    closeOpenClawStateDatabaseByPath(databasePath);
    // Includes synthetic server tokens, never the observer's private key.
    // This file is private scratch, not a retained evidence artifact.
    await copyFile(databasePath, path.join(scratch, "candidate-pairing.sqlite"));
    return identity;
  } finally {
    closeOpenClawStateDatabaseByPath(databasePath);
    await rm(seed, { recursive: true, force: true });
  }
}
