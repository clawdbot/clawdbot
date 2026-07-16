import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type { CoreConfig } from "../../types.js";
import { formatMatrixEncryptionUnavailableError } from "../encryption-guidance.js";
import { withResolvedActionClient, withStartedActionClient } from "./client.js";
import type { MatrixActionClientOpts } from "./types.js";

function requireCrypto(
  client: import("../sdk.js").MatrixClient,
  opts: MatrixActionClientOpts,
): NonNullable<import("../sdk.js").MatrixClient["crypto"]> {
  if (!client.crypto) {
    const cfg = opts.cfg ?? (getMatrixRuntime().config.loadConfig() as CoreConfig);
    throw new Error(formatMatrixEncryptionUnavailableError(cfg, opts.accountId));
  }
  return client.crypto;
}

function resolveVerificationId(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    throw new Error("Matrix verification request id is required");
  }
  return normalized;
}

export async function listMatrixVerifications(opts: MatrixActionClientOpts = {}) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.listVerifications();
  });
}

export async function requestMatrixVerification(
  params: MatrixActionClientOpts & {
    ownUser?: boolean;
    userId?: string;
    deviceId?: string;
    roomId?: string;
  } = {},
) {
  return await withStartedActionClient(params, async (client) => {
    const crypto = requireCrypto(client, params);
    const ownUser = params.ownUser ?? (!params.userId && !params.deviceId && !params.roomId);
    return await crypto.requestVerification({
      ownUser,
      userId: normalizeOptionalString(params.userId),
      deviceId: normalizeOptionalString(params.deviceId),
      roomId: normalizeOptionalString(params.roomId),
    });
  });
}

export async function acceptMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.acceptVerification(resolveVerificationId(requestId));
  });
}

export async function cancelMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts & { reason?: string; code?: string } = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.cancelVerification(resolveVerificationId(requestId), {
      reason: normalizeOptionalString(opts.reason),
      code: normalizeOptionalString(opts.code),
    });
  });
}

export async function startMatrixVerification(
  requestId: string,
  opts: MatrixActionClientOpts & { method?: "sas" } = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.startVerification(resolveVerificationId(requestId), opts.method ?? "sas");
  });
}

export async function generateMatrixVerificationQr(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.generateVerificationQr(resolveVerificationId(requestId));
  });
}

export async function scanMatrixVerificationQr(
  requestId: string,
  qrDataBase64: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    const payload = qrDataBase64.trim();
    if (!payload) {
      throw new Error("Matrix QR data is required");
    }
    return await crypto.scanVerificationQr(resolveVerificationId(requestId), payload);
  });
}

export async function getMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.getVerificationSas(resolveVerificationId(requestId));
  });
}

export async function confirmMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.confirmVerificationSas(resolveVerificationId(requestId));
  });
}

export async function mismatchMatrixVerificationSas(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.mismatchVerificationSas(resolveVerificationId(requestId));
  });
}

export async function confirmMatrixVerificationReciprocateQr(
  requestId: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    return await crypto.confirmVerificationReciprocateQr(resolveVerificationId(requestId));
  });
}

export async function getMatrixEncryptionStatus(
  opts: MatrixActionClientOpts & { includeRecoveryKey?: boolean } = {},
) {
  return await withResolvedActionClient(opts, async (client) => {
    const crypto = requireCrypto(client, opts);
    const recoveryKey = await crypto.getRecoveryKey();
    return {
      encryptionEnabled: true,
      recoveryKeyStored: Boolean(recoveryKey),
      recoveryKeyCreatedAt: recoveryKey?.createdAt ?? null,
      ...(opts.includeRecoveryKey ? { recoveryKey: recoveryKey?.encodedPrivateKey ?? null } : {}),
      pendingVerifications: (await crypto.listVerifications()).length,
    };
  });
}

export async function getMatrixVerificationStatus(
  opts: MatrixActionClientOpts & { includeRecoveryKey?: boolean } = {},
) {
  return await withResolvedActionClient(opts, async (client) => {
    const status = await client.getOwnDeviceVerificationStatus();
    const payload = {
      ...status,
      pendingVerifications: client.crypto ? (await client.crypto.listVerifications()).length : 0,
    };
    if (!opts.includeRecoveryKey) {
      return payload;
    }
    const recoveryKey = client.crypto ? await client.crypto.getRecoveryKey() : null;
    return {
      ...payload,
      recoveryKey: recoveryKey?.encodedPrivateKey ?? null,
    };
  });
}

export async function getMatrixRoomKeyBackupStatus(opts: MatrixActionClientOpts = {}) {
  return await withResolvedActionClient(
    opts,
    async (client) => await client.getRoomKeyBackupStatus(),
  );
}

export async function verifyMatrixRecoveryKey(
  recoveryKey: string,
  opts: MatrixActionClientOpts = {},
) {
  return await withStartedActionClient(
    opts,
    async (client) => await client.verifyWithRecoveryKey(recoveryKey),
  );
}

export async function restoreMatrixRoomKeyBackup(
  opts: MatrixActionClientOpts & {
    recoveryKey?: string;
  } = {},
) {
  return await withStartedActionClient(
    opts,
    async (client) =>
      await client.restoreRoomKeyBackup({
        recoveryKey: normalizeOptionalString(opts.recoveryKey),
      }),
  );
}

export async function resetMatrixRoomKeyBackup(opts: MatrixActionClientOpts = {}) {
  return await withStartedActionClient(opts, async (client) => await client.resetRoomKeyBackup());
}

export async function bootstrapMatrixVerification(
  opts: MatrixActionClientOpts & {
    recoveryKey?: string;
    forceResetCrossSigning?: boolean;
  } = {},
) {
  return await withStartedActionClient(
    opts,
    async (client) =>
      await client.bootstrapOwnDeviceVerification({
        recoveryKey: normalizeOptionalString(opts.recoveryKey),
        forceResetCrossSigning: opts.forceResetCrossSigning === true,
      }),
  );
}
