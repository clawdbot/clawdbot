import { hasExplicitMatrixAccountConfig } from "./matrix/account-config.js";
import { resolveMatrixAccountConfig } from "./matrix/accounts.js";
import { bootstrapMatrixVerification } from "./matrix/actions/verification.js";
import { formatMatrixErrorMessage } from "./matrix/errors.js";
import type { RuntimeEnv } from "./runtime-api.js";
import type { CoreConfig } from "./types.js";

export type MatrixSetupVerificationBootstrapResult = {
  attempted: boolean;
  success: boolean;
  recoveryKeyCreatedAt: string | null;
  backupVersion: string | null;
  error?: string;
};

export async function maybeBootstrapNewEncryptedMatrixAccount(params: {
  previousCfg: CoreConfig;
  cfg: CoreConfig;
  accountId: string;
}): Promise<MatrixSetupVerificationBootstrapResult> {
  const accountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });

  if (
    hasExplicitMatrixAccountConfig(params.previousCfg, params.accountId) ||
    accountConfig.encryption !== true
  ) {
    return {
      attempted: false,
      success: false,
      recoveryKeyCreatedAt: null,
      backupVersion: null,
    };
  }

  try {
    const bootstrap = await bootstrapMatrixVerification({ accountId: params.accountId });
    return {
      attempted: true,
      success: bootstrap.success,
      recoveryKeyCreatedAt: bootstrap.verification.recoveryKeyCreatedAt,
      backupVersion: bootstrap.verification.backupVersion,
      ...(bootstrap.success
        ? {}
        : { error: bootstrap.error ?? "Matrix verification bootstrap failed" }),
    };
  } catch (err) {
    return {
      attempted: true,
      success: false,
      recoveryKeyCreatedAt: null,
      backupVersion: null,
      error: formatMatrixErrorMessage(err),
    };
  }
}

export async function runMatrixSetupBootstrapAfterConfigWrite(params: {
  previousCfg: CoreConfig;
  cfg: CoreConfig;
  accountId: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const nextAccountConfig = resolveMatrixAccountConfig({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (nextAccountConfig.encryption !== true) {
    return;
  }

  const bootstrap = await maybeBootstrapNewEncryptedMatrixAccount({
    previousCfg: params.previousCfg,
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!bootstrap.attempted) {
    return;
  }
  if (bootstrap.success) {
    params.runtime.log(`Matrix verification bootstrap: complete for "${params.accountId}".`);
    if (bootstrap.backupVersion) {
      params.runtime.log(
        `Matrix backup version for "${params.accountId}": ${bootstrap.backupVersion}`,
      );
    }
    return;
  }
  params.runtime.error(
    `Matrix verification bootstrap warning for "${params.accountId}": ${bootstrap.error ?? "unknown bootstrap failure"}`,
  );
}
