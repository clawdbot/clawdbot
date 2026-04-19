import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatMatrixErrorMessage } from "./matrix/errors.js";

type MatrixVerificationRuntime = typeof import("./matrix/actions/verification.js");

let matrixVerificationRuntimePromise: Promise<MatrixVerificationRuntime> | undefined;

function loadMatrixVerificationRuntime(): Promise<MatrixVerificationRuntime> {
  matrixVerificationRuntimePromise ??= import("./matrix/actions/verification.js");
  return matrixVerificationRuntimePromise;
}

function sendError(respond: (ok: boolean, payload?: unknown) => void, err: unknown) {
  respond(false, { error: formatMatrixErrorMessage(err) });
}

export async function ensureMatrixCryptoRuntime(
  ...args: Parameters<typeof import("./matrix/deps.js").ensureMatrixCryptoRuntime>
): Promise<void> {
  const { ensureMatrixCryptoRuntime: ensureRuntime } = await import("./matrix/deps.js");
  await ensureRuntime(...args);
}

export async function handleVerifyRecoveryKey({
  params,
  respond,
}: GatewayRequestHandlerOptions): Promise<void> {
  try {
    const { verifyMatrixRecoveryKey } = await loadMatrixVerificationRuntime();
    const key = normalizeOptionalString(params?.key);
    if (!key) {
      respond(false, { error: "key required" });
      return;
    }
    const accountId = normalizeOptionalString(params?.accountId);
    const result = await verifyMatrixRecoveryKey(key, { accountId });
    respond(result.success, result);
  } catch (err) {
    sendError(respond, err);
  }
}

export async function handleVerificationBootstrap({
  params,
  respond,
}: GatewayRequestHandlerOptions): Promise<void> {
  try {
    const { bootstrapMatrixVerification } = await loadMatrixVerificationRuntime();
    const accountId = normalizeOptionalString(params?.accountId);
    const recoveryKey = typeof params?.recoveryKey === "string" ? params.recoveryKey : undefined;
    const forceResetCrossSigning = params?.forceResetCrossSigning === true;
    const result = await bootstrapMatrixVerification({
      accountId,
      recoveryKey,
      forceResetCrossSigning,
    });
    respond(result.success, result);
  } catch (err) {
    sendError(respond, err);
  }
}

export async function handleVerificationStatus({
  params,
  respond,
}: GatewayRequestHandlerOptions): Promise<void> {
  try {
    const { getMatrixVerificationStatus } = await loadMatrixVerificationRuntime();
    const accountId = normalizeOptionalString(params?.accountId);
    const includeRecoveryKey = params?.includeRecoveryKey === true;
    const status = await getMatrixVerificationStatus({ accountId, includeRecoveryKey });
    respond(true, status);
  } catch (err) {
    sendError(respond, err);
  }
}
