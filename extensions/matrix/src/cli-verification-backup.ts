import type { Command } from "commander";
import * as cli from "./cli-shared.js";
import * as verification from "./matrix/actions/verification.js";

export function registerMatrixVerificationBackupCommands(verify: Command): void {
  const backup = verify.command("backup").description("Matrix room-key backup health and restore");

  backup
    .command("status")
    .description("Show Matrix room-key backup status for this device")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(async (options: { account?: string; verbose?: boolean; json?: boolean }) => {
      const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
      await cli.runMatrixCliCommand({
        verbose: options.verbose === true,
        json: options.json === true,
        run: async () => await verification.getMatrixRoomKeyBackupStatus({ accountId, cfg }),
        onText: (status, verbose) => {
          cli.printAccountLabel(accountId);
          cli.printBackupSummary(status);
          if (verbose) {
            cli.printBackupStatus(status);
          }
          cli.printBackupGuidance(status, accountId);
        },
        errorPrefix: "Backup status failed",
      });
    });

  backup
    .command("reset")
    .description(
      "Delete the current server backup and create a fresh room-key backup baseline, repairing secret storage if needed for a durable reset",
    )
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--yes", "Confirm destructive backup reset", false)
    .option("--rotate-recovery-key", "Create a new Matrix recovery key for the fresh backup")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        yes?: boolean;
        rotateRecoveryKey?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () => {
            if (options.yes !== true) {
              throw new Error(
                `Refusing to reset Matrix room-key backup without --yes. If you accept losing unrecoverable history, re-run ${cli.formatMatrixCliCommand("verify backup reset --yes", accountId)}.`,
              );
            }
            return await verification.resetMatrixRoomKeyBackup({
              accountId,
              cfg,
              rotateRecoveryKey: options.rotateRecoveryKey === true,
            });
          },
          onText: (result, verbose) => {
            cli.printAccountLabel(accountId);
            console.log(`Reset success: ${result.success ? "yes" : "no"}`);
            if (result.error) {
              console.log(`Error: ${cli.formatMatrixCliText(result.error)}`);
            }
            console.log(
              `Previous backup version: ${cli.formatMatrixCliText(result.previousVersion, "none")}`,
            );
            console.log(
              `Deleted backup version: ${cli.formatMatrixCliText(result.deletedVersion, "none")}`,
            );
            console.log(
              `Current backup version: ${cli.formatMatrixCliText(result.createdVersion, "none")}`,
            );
            cli.printBackupSummary(result.backup);
            if (verbose) {
              cli.printTimestamp("Reset at", result.resetAt);
              cli.printBackupStatus(result.backup);
            }
            cli.printBackupGuidance(result.backup, accountId);
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Backup reset failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  backup
    .command("restore")
    .description("Restore encrypted room keys from server backup")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option(
      "--recovery-key <key>",
      "Optional recovery key to load before restoring (prefer --recovery-key-stdin)",
    )
    .option("--recovery-key-stdin", "Read the Matrix recovery key from stdin")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (options: {
        account?: string;
        recoveryKey?: string;
        recoveryKeyStdin?: boolean;
        verbose?: boolean;
        json?: boolean;
      }) => {
        const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await verification.restoreMatrixRoomKeyBackup({
              accountId,
              cfg,
              recoveryKey: await cli.resolveMatrixCliRecoveryKeyInput(options),
            }),
          onText: (result, verbose) => {
            cli.printAccountLabel(accountId);
            console.log(`Restore success: ${result.success ? "yes" : "no"}`);
            if (result.error) {
              console.log(`Error: ${cli.formatMatrixCliText(result.error)}`);
            }
            console.log(`Backup version: ${cli.formatMatrixCliText(result.backupVersion, "none")}`);
            console.log(`Imported keys: ${result.imported}/${result.total}`);
            cli.printBackupSummary(result.backup);
            if (verbose) {
              console.log(
                `Loaded key from secret storage: ${result.loadedFromSecretStorage ? "yes" : "no"}`,
              );
              cli.printTimestamp("Restored at", result.restoredAt);
              cli.printBackupStatus(result.backup);
            }
            cli.printBackupGuidance(result.backup, accountId, {
              recoveryKeyStored: result.loadedFromSecretStorage,
            });
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Backup restore failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  verify
    .command("bootstrap")
    .description("Bootstrap Matrix cross-signing and device verification state")
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
        const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await verification.bootstrapMatrixVerification({
              accountId,
              cfg,
              recoveryKey: await cli.resolveMatrixCliRecoveryKeyInput(options),
              forceResetCrossSigning: options.forceResetCrossSigning === true,
            }),
          onText: (result, verbose) => {
            cli.printAccountLabel(accountId);
            console.log(`Bootstrap success: ${result.success ? "yes" : "no"}`);
            if (result.error) {
              console.log(`Error: ${cli.formatMatrixCliText(result.error)}`);
            }
            console.log(`Verified by owner: ${result.verification.verified ? "yes" : "no"}`);
            cli.printVerificationIdentity(result.verification);
            if (verbose) {
              cli.printVerificationTrustDiagnostics(result.verification);
              console.log(
                `Cross-signing published: ${result.crossSigning.published ? "yes" : "no"} (master=${result.crossSigning.masterKeyPublished ? "yes" : "no"}, self=${result.crossSigning.selfSigningKeyPublished ? "yes" : "no"}, user=${result.crossSigning.userSigningKeyPublished ? "yes" : "no"})`,
              );
              cli.printVerificationBackupStatus(result.verification);
              cli.printTimestamp(
                "Recovery key created at",
                result.verification.recoveryKeyCreatedAt,
              );
              console.log(`Pending verifications: ${result.pendingVerifications}`);
            } else {
              console.log(
                `Cross-signing published: ${result.crossSigning.published ? "yes" : "no"}`,
              );
              cli.printVerificationBackupSummary(result.verification);
            }
            cli.printVerificationGuidance(
              {
                ...result.verification,
                pendingVerifications: result.pendingVerifications,
              },
              accountId,
            );
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Verification bootstrap failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );

  verify
    .command("device [key]")
    .description("Verify device using a Matrix recovery key")
    .option("--account <id>", "Account ID (for multi-account setups)")
    .option("--recovery-key-stdin", "Read the Matrix recovery key from stdin")
    .option("--verbose", "Show detailed diagnostics")
    .option("--json", "Output as JSON")
    .action(
      async (
        key: string | undefined,
        options: {
          account?: string;
          recoveryKeyStdin?: boolean;
          verbose?: boolean;
          json?: boolean;
        },
      ) => {
        const { accountId, cfg } = cli.resolveMatrixCliAccountContext(options.account);
        await cli.runMatrixCliCommand({
          verbose: options.verbose === true,
          json: options.json === true,
          run: async () =>
            await verification.verifyMatrixRecoveryKey(
              await cli.requireMatrixCliRecoveryKeyInput({
                recoveryKey: key,
                recoveryKeyStdin: options.recoveryKeyStdin,
              }),
              { accountId, cfg },
            ),
          onText: (result, verbose) => {
            cli.printAccountLabel(accountId);
            if (!result.success) {
              console.error(`Verification failed: ${cli.formatMatrixCliText(result.error)}`);
              cli.printVerificationIdentity(result);
              console.log(`Recovery key accepted: ${result.recoveryKeyAccepted ? "yes" : "no"}`);
              console.log(`Backup usable: ${result.backupUsable ? "yes" : "no"}`);
              console.log(`Device verified by owner: ${result.deviceOwnerVerified ? "yes" : "no"}`);
              cli.printVerificationBackupSummary(result);
              if (verbose) {
                cli.printVerificationTrustDiagnostics(result);
                cli.printVerificationBackupStatus(result);
                cli.printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
              }
              cli.printVerificationGuidance(
                {
                  ...result,
                  pendingVerifications: 0,
                },
                accountId,
              );
              return;
            }
            console.log("Device verification completed successfully.");
            cli.printVerificationIdentity(result);
            console.log(`Recovery key accepted: ${result.recoveryKeyAccepted ? "yes" : "no"}`);
            console.log(`Backup usable: ${result.backupUsable ? "yes" : "no"}`);
            console.log(`Device verified by owner: ${result.deviceOwnerVerified ? "yes" : "no"}`);
            cli.printVerificationBackupSummary(result);
            if (verbose) {
              cli.printVerificationTrustDiagnostics(result);
              cli.printVerificationBackupStatus(result);
              cli.printTimestamp("Recovery key created at", result.recoveryKeyCreatedAt);
              cli.printTimestamp("Verified at", result.verifiedAt);
            }
            cli.printVerificationGuidance(
              {
                ...result,
                pendingVerifications: 0,
              },
              accountId,
            );
          },
          shouldFail: (result) => !result.success,
          errorPrefix: "Verification failed",
          onJsonError: (message) => ({ success: false, error: message }),
        });
      },
    );
}
