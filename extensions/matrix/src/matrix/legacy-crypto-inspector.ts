import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ensureMatrixCryptoRuntime } from "./deps.js";

export type MatrixLegacyCryptoInspectionResult = {
  deviceId: string | null;
  roomKeyCounts: {
    total: number;
    backedUp: number;
  } | null;
  backupVersion: string | null;
  decryptionKeyBase64: string | null;
};

function resolveLegacyMachineStorePath(params: {
  cryptoRootDir: string;
  deviceId: string;
}): string | null {
  const hashedDir = path.join(
    params.cryptoRootDir,
    crypto.createHash("sha256").update(params.deviceId).digest("hex"),
  );
  if (fs.existsSync(path.join(hashedDir, "matrix-sdk-crypto.sqlite3"))) {
    return hashedDir;
  }
  if (fs.existsSync(path.join(params.cryptoRootDir, "matrix-sdk-crypto.sqlite3"))) {
    return params.cryptoRootDir;
  }
  const match = fs
    .readdirSync(params.cryptoRootDir, { withFileTypes: true })
    .find(
      (entry) =>
        entry.isDirectory() &&
        fs.existsSync(path.join(params.cryptoRootDir, entry.name, "matrix-sdk-crypto.sqlite3")),
    );
  return match ? path.join(params.cryptoRootDir, match.name) : null;
}

export async function inspectLegacyMatrixCryptoStore(params: {
  cryptoRootDir: string;
  userId: string;
  deviceId: string;
  log?: (message: string) => void;
}): Promise<MatrixLegacyCryptoInspectionResult> {
  const machineStorePath = resolveLegacyMachineStorePath(params);
  if (!machineStorePath) {
    throw new Error(`Matrix legacy crypto store not found for device ${params.deviceId}`);
  }

  const requireFn = createRequire(import.meta.url);
  await ensureMatrixCryptoRuntime({
    requireFn,
    resolveFn: requireFn.resolve.bind(requireFn),
    log: params.log,
  });

  const { DeviceId, OlmMachine, StoreType, UserId } = requireFn(
    "@matrix-org/matrix-sdk-crypto-nodejs",
  ) as typeof import("@matrix-org/matrix-sdk-crypto-nodejs");
  const machine = await OlmMachine.initialize(
    new UserId(params.userId),
    new DeviceId(params.deviceId),
    machineStorePath,
    "",
    StoreType.Sqlite,
  );

  try {
    const [backupKeys, roomKeyCounts] = await Promise.all([
      machine.getBackupKeys(),
      machine.roomKeyCounts(),
    ]);
    return {
      deviceId: params.deviceId,
      roomKeyCounts: roomKeyCounts
        ? {
            total: typeof roomKeyCounts.total === "number" ? roomKeyCounts.total : 0,
            backedUp: typeof roomKeyCounts.backedUp === "number" ? roomKeyCounts.backedUp : 0,
          }
        : null,
      backupVersion:
        typeof backupKeys?.backupVersion === "string" && backupKeys.backupVersion.trim()
          ? backupKeys.backupVersion
          : null,
      decryptionKeyBase64:
        typeof backupKeys?.decryptionKeyBase64 === "string" && backupKeys.decryptionKeyBase64.trim()
          ? backupKeys.decryptionKeyBase64
          : null,
    };
  } finally {
    machine.close();
  }
}
