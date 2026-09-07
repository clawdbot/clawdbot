import type { Command } from "commander";
import * as cli from "./cli-shared.js";
import { resolveMatrixAccount, resolveMatrixAccountConfig } from "./matrix/accounts.js";
import * as verificationActions from "./matrix/actions/verification.js";
import { resolveMatrixRoomKeyBackupIssue } from "./matrix/backup-health.js";
import { resolveMatrixConfigPath, updateMatrixAccountConfig } from "./matrix/config-update.js";

type MatrixCliVerificationBootstrap = Awaited<
  ReturnType<typeof verificationActions.bootstrapMatrixVerification>
>;

type MatrixCliEncryptionSetupResult = {
  accountId: string;
  configPath: string;
  encryptionChanged: boolean;
  bootstrap: MatrixCliVerificationBootstrap;
  status: cli.MatrixCliVerificationStatus;
};

function isMatrixVerificationSetupComplete(status: cli.MatrixCliVerificationStatus): boolean {
  return (
    status.encryptionEnabled &&
    status.verified &&
    status.crossSigningVerified &&
    status.signedByOwner &&
    status.serverDeviceKnown === true &&
    resolveMatrixRoomKeyBackupIssue(cli.resolveBackupStatus(status)).code === "ok"
  );
}

function buildNoopMatrixVerificationBootstrap(
  status: cli.MatrixCliVerificationStatus,
): MatrixCliVerificationBootstrap {
  const verification = {
    ...status,
    backup: cli.resolveBackupStatus(status),
    serverDeviceKnown: status.serverDeviceKnown ?? null,
  };
  return {
    success: true,
    verification,
    crossSigning: {
      userId: status.userId,
      masterKeyPublished: status.crossSigningVerified,
      selfSigningKeyPublished: status.signedByOwner,
      userSigningKeyPublished: status.signedByOwner,
      published: status.crossSigningVerified && status.signedByOwner,
    },
    pendingVerifications: status.pendingVerifications,
    cryptoBootstrap: null,
  };
}

async function setupMatrixEncryption(params: {
  account?: string;
  recoveryKey?: string;
  forceResetCrossSigning?: boolean;
}): Promise<MatrixCliEncryptionSetupResult> {
  const { accountId, cfg } = cli.resolveMatrixCliAccountContext(params.account);
  const publishConfig = cli.createMatrixCliAccountConfigPublisher({ accountId, previousCfg: cfg });
  const account = resolveMatrixAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(
      `Matrix account "${accountId}" is not configured; run ${cli.formatMatrixCliCommand(
        "account add",
        accountId,
      )} first.`,
    );
  }

  const currentAccountConfig = resolveMatrixAccountConfig({ cfg, accountId });
  const encryptionChanged = currentAccountConfig.encryption !== true;
  const updated = encryptionChanged
    ? updateMatrixAccountConfig(cfg, accountId, { encryption: true })
    : cfg;
  const canUseExistingBootstrap =
    !encryptionChanged && !params.recoveryKey && params.forceResetCrossSigning !== true;
  const existingStatus = canUseExistingBootstrap
    ? await verificationActions.getMatrixVerificationStatus({
        accountId,
        cfg: updated,
        readiness: "none",
      })
    : null;
  if (existingStatus && isMatrixVerificationSetupComplete(existingStatus)) {
    return {
      accountId,
      configPath: resolveMatrixConfigPath(updated, accountId),
      encryptionChanged,
      bootstrap: buildNoopMatrixVerificationBootstrap(existingStatus),
      status: existingStatus,
    };
  }

  try {
    const bootstrap = await verificationActions.bootstrapMatrixVerification({
      accountId,
      cfg: updated,
      recoveryKey: params.recoveryKey,
      forceResetCrossSigning: params.forceResetCrossSigning === true,
    });
    const status = await verificationActions.getMatrixVerificationStatus({
      accountId,
      cfg: updated,
    });

    return {
      accountId,
      configPath: resolveMatrixConfigPath(updated, accountId),
      encryptionChanged,
      bootstrap,
      status,
    };
  } finally {
    // Publishing enables Gateway crypto startup; release every CLI client first.
    // Keep the configured encryption choice even when bootstrap or status fails.
    if (encryptionChanged) {
      await publishConfig((current) =>
        updateMatrixAccountConfig(current, accountId, { encryption: true }),
      );
    }
  }
}

function printMatrixEncryptionSetupResult(
  result: MatrixCliEncryptionSetupResult,
  verbose = false,
): void {
  cli.printAccountLabel(result.accountId);
  console.log(
    `Encryption config: ${result.encryptionChanged ? "enabled" : "already enabled"} at ${cli.formatMatrixCliText(
      result.configPath,
    )}`,
  );
  console.log(`Bootstrap success: ${result.bootstrap.success ? "yes" : "no"}`);
  if (result.bootstrap.error) {
    console.log(`Bootstrap error: ${cli.formatMatrixCliText(result.bootstrap.error)}`);
  }
  console.log(`Verified by owner: ${result.status.verified ? "yes" : "no"}`);
  cli.printVerificationBackupSummary(result.status);
  if (verbose) {
    cli.printVerificationIdentity(result.status);
    cli.printVerificationTrustDiagnostics(result.status);
    cli.printVerificationBackupStatus(result.status);
    console.log(`Recovery key stored: ${result.status.recoveryKeyStored ? "yes" : "no"}`);
    cli.printTimestamp("Recovery key created at", result.status.recoveryKeyCreatedAt);
    console.log(`Pending verifications: ${result.status.pendingVerifications}`);
  }
  cli.printVerificationGuidance(result.status, result.accountId);
}

export function registerMatrixEncryptionCommands(root: Command): void {
  const encryption = root.command("encryption").description("Set up Matrix end-to-end encryption");

  encryption
    .command("setup")
    .description("Enable Matrix E2EE, bootstrap verification, and print next steps")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option(
      "--recovery-key <key>",
      "Recovery key to apply before bootstrap (prefer --recovery-key-stdin)",
    )
    .option("--recovery-key-stdin", "Read the Matrix recovery key from stdin")
    .option(
      "--force-reset-cross-signing",
      "Force reset cross-signing identity before bootstrap (requires active recovery key)",
    )
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        recoveryKey?: string;
        recoveryKeyStdin?: boolean;
        forceResetCrossSigning?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await setupMatrixEncryption({
              account: options.account,
              recoveryKey: await cli.resolveMatrixCliRecoveryKeyInput({
                recoveryKey: options.recoveryKey,
                recoveryKeyStdin: options.recoveryKeyStdin,
              }),
              forceResetCrossSigning: options.forceResetCrossSigning === true,
            }),
          onText: (result, verbose) => {
            printMatrixEncryptionSetupResult(result, verbose);
          },
          onJson: (result) => ({ success: result.bootstrap.success, ...result }),
          shouldFail: (result) => !result.bootstrap.success,
          errorPrefix: "Encryption setup failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );
}
