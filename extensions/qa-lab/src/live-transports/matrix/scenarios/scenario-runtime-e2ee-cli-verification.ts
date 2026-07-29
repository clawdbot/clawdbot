// Qa Matrix plugin module implements self-verification CLI E2EE scenarios.
import { createMatrixQaClient } from "../substrate/client.js";
import { createMatrixQaCliSelfVerificationRuntime } from "./scenario-runtime-e2ee-cli-runtime.js";
import {
  assertMatrixQaCliSasMatches,
  createMatrixQaE2eeCliOwnerClient,
  isMatrixQaCliBackupUsable,
  isMatrixQaCliOwnerSelfVerification,
  parseMatrixQaCliJson,
  parseMatrixQaCliSasText,
  parseMatrixQaCliSummaryField,
  registerMatrixQaCliE2eeAccount,
  type MatrixQaCliBackupRestoreStatus,
  type MatrixQaCliVerificationStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import {
  ensureMatrixQaE2eeOwnDeviceVerified,
  waitForMatrixQaVerificationSummary,
} from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeCliSelfVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Self Verification Owner",
    scenarioId: "matrix-e2ee-cli-self-verification",
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({
    account,
    context,
    scenarioId: "matrix-e2ee-cli-self-verification",
  });
  try {
    const ownerReady = await ensureMatrixQaE2eeOwnDeviceVerified({
      client: owner,
      label: "CLI self-verification owner",
    });
    const encodedRecoveryKey = ownerReady.recoveryKey?.encodedPrivateKey?.trim();
    if (!encodedRecoveryKey) {
      throw new Error("Matrix E2EE self-verification scenario did not expose a recovery key");
    }
    const loginClient = createMatrixQaClient({
      baseUrl: context.baseUrl,
    });
    const cliDevice = await loginClient.loginWithPassword({
      deviceName: "OpenClaw Matrix QA CLI Self Verification Device",
      password: account.password,
      userId: account.userId,
    });
    if (!cliDevice.deviceId) {
      throw new Error("Matrix E2EE CLI verification login did not return a device id");
    }

    const cli = await createMatrixQaCliSelfVerificationRuntime({
      accountId,
      accessToken: cliDevice.accessToken,
      context,
      deviceId: cliDevice.deviceId,
      userId: cliDevice.userId,
    });
    try {
      const restoreResult = await cli.run(
        [
          "matrix",
          "verify",
          "backup",
          "restore",
          "--account",
          accountId,
          "--recovery-key-stdin",
          "--json",
        ],
        context.timeoutMs,
        `${encodedRecoveryKey}\n`,
      );
      const restoreArtifacts = await writeMatrixQaCliOutputArtifacts({
        label: "verify-backup-restore",
        result: restoreResult,
        rootDir: cli.rootDir,
      });
      const restored = parseMatrixQaCliJson(restoreResult) as MatrixQaCliBackupRestoreStatus;
      if (
        restored.success !== true ||
        restored.backup?.decryptionKeyCached !== true ||
        restored.backup?.matchesDecryptionKey !== true ||
        restored.backup?.keyLoadError
      ) {
        throw new Error(
          `Matrix CLI recovery key did not load matching room-key backup material before self-verification: ${
            restored.error ?? restored.backup?.keyLoadError ?? "unknown backup state"
          }`,
        );
      }
      const session = cli.start(
        [
          "matrix",
          "verify",
          "self",
          "--account",
          accountId,
          "--timeout-ms",
          String(context.timeoutMs),
        ],
        context.timeoutMs * 2,
      );
      try {
        const requestOutput = await session.waitForOutput(
          (output) => output.text.includes("Accept this verification request"),
          "self-verification request guidance",
          context.timeoutMs,
        );
        const cliTransactionId = parseMatrixQaCliSummaryField(requestOutput.text, "Transaction id");
        const ownerRequested = await waitForMatrixQaVerificationSummary({
          client: owner,
          label: "owner received CLI self-verification request",
          predicate: (summary) =>
            isMatrixQaCliOwnerSelfVerification({
              cliDeviceId: cliTransactionId ? undefined : cliDevice.deviceId,
              ownerUserId: account.userId,
              requirePending: true,
              summary,
              transactionId: cliTransactionId ?? undefined,
            }),
          timeoutMs: context.timeoutMs,
        });
        if (ownerRequested.canAccept) {
          await owner.acceptVerification(ownerRequested.id);
        }

        const sasOutput = await session.waitForOutput(
          (output) => /^SAS (?:emoji|decimals):/m.test(output.text),
          "SAS emoji or decimals",
          context.timeoutMs,
        );
        const cliSas = parseMatrixQaCliSasText(
          sasOutput.text,
          "interactive openclaw matrix verify self",
        );
        const ownerSas = await waitForMatrixQaVerificationSummary({
          client: owner,
          label: "owner SAS for CLI self-verification",
          predicate: (summary) =>
            isMatrixQaCliOwnerSelfVerification({
              cliDeviceId: cliTransactionId ? undefined : cliDevice.deviceId,
              ownerUserId: account.userId,
              requireSas: true,
              summary,
              transactionId: cliTransactionId ?? undefined,
            }),
          timeoutMs: context.timeoutMs,
        });
        const sasArtifact = assertMatrixQaCliSasMatches({
          cliSas,
          owner: ownerSas,
        });
        const ownerConfirm = owner.confirmVerificationSas(ownerSas.id);
        await session.writeStdin("yes\n");
        session.endStdin();
        await ownerConfirm;
        const completedCli = await session.wait();
        const selfVerificationArtifacts = await writeMatrixQaCliOutputArtifacts({
          label: "verify-self",
          result: completedCli,
          rootDir: cli.rootDir,
        });
        if (!/^Device verified by owner:\s*yes$/m.test(completedCli.stdout)) {
          throw new Error(
            "Interactive Matrix CLI self-verification did not report final device verification",
          );
        }
        if (!/^Cross-signing verified:\s*yes$/m.test(completedCli.stdout)) {
          throw new Error(
            "Interactive Matrix CLI self-verification did not report full Matrix identity trust",
          );
        }
        const completedOwner = await waitForMatrixQaVerificationSummary({
          client: owner,
          label: "owner completed CLI self-verification",
          predicate: (summary) =>
            isMatrixQaCliOwnerSelfVerification({
              cliDeviceId: cliTransactionId ? undefined : cliDevice.deviceId,
              ownerUserId: account.userId,
              requireCompleted: true,
              summary,
              transactionId: cliTransactionId ?? undefined,
            }),
          timeoutMs: context.timeoutMs,
        });
        const cliVerificationId =
          completedCli.stdout.match(/^Verification id:\s*(\S+)/m)?.[1] ?? "interactive-cli";
        const statusResult = await cli.run([
          "matrix",
          "verify",
          "status",
          "--account",
          accountId,
          "--json",
        ]);
        const statusArtifacts = await writeMatrixQaCliOutputArtifacts({
          label: "verify-status",
          result: statusResult,
          rootDir: cli.rootDir,
        });
        const status = parseMatrixQaCliJson(statusResult) as MatrixQaCliVerificationStatus;
        if (
          status.verified !== true ||
          status.crossSigningVerified !== true ||
          status.signedByOwner !== true ||
          status.backup?.trusted !== true ||
          status.backup?.matchesDecryptionKey !== true ||
          status.backup?.keyLoadError
        ) {
          throw new Error(
            `Matrix CLI device was not fully usable after SAS completion: ownerVerified=${
              status.verified === true &&
              status.crossSigningVerified === true &&
              status.signedByOwner === true
                ? "yes"
                : "no"
            }, backupUsable=${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}${
              status.backup?.keyLoadError ? `, backupError=${status.backup.keyLoadError}` : ""
            }`,
          );
        }
        return {
          artifacts: {
            completedVerificationIds: [cliVerificationId, completedOwner.id],
            currentDeviceId: status.deviceId ?? cliDevice.deviceId,
            ...(cliSas.kind === "emoji" ? { sasEmoji: sasArtifact } : {}),
            secondaryDeviceId: cliDevice.deviceId,
          },
          details: [
            "Matrix CLI self-verification established full Matrix identity trust through interactive openclaw matrix verify self",
            "cli secret config cleaned after run: yes",
            `cli backup restore stdout: ${restoreArtifacts.stdoutPath}`,
            `cli backup restore stderr: ${restoreArtifacts.stderrPath}`,
            `cli verify self stdout: ${selfVerificationArtifacts.stdoutPath}`,
            `cli verify self stderr: ${selfVerificationArtifacts.stderrPath}`,
            `cli verify status stdout: ${statusArtifacts.stdoutPath}`,
            `cli verify status stderr: ${statusArtifacts.stderrPath}`,
            `cli device: ${cliDevice.deviceId}`,
            `cli verification id: ${cliVerificationId}`,
            `owner-side verification id: ${completedOwner.id}`,
            `transaction: ${completedOwner.transactionId ?? "<none>"}`,
            `cli verified by owner: ${status.verified ? "yes" : "no"}`,
            `cli cross-signing verified: ${status.crossSigningVerified ? "yes" : "no"}`,
            `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
          ].join("\n"),
        };
      } finally {
        session.kill();
      }
    } finally {
      try {
        await cli.dispose();
      } finally {
        await owner.stop().catch(() => undefined);
        await owner.deleteOwnDevices([cliDevice.deviceId]).catch(() => undefined);
      }
    }
  } finally {
    await owner.stop().catch(() => undefined);
  }
}
