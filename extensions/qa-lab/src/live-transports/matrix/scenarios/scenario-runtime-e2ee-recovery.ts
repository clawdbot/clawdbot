// Qa Matrix plugin module implements recovery scenario runtime E2EE behavior.
import { randomUUID } from "node:crypto";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createMatrixQaClient } from "../substrate/client.js";
import { createMatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import {
  assertMatrixQaExpectedBootstrapFailure,
  assertMatrixQaFaultedRecoveryOwnerVerificationRequired,
  runMatrixQaFaultedE2eeBootstrap,
  runMatrixQaFaultedRecoveryOwnerVerification,
  withMatrixQaE2eeDriver,
} from "./scenario-runtime-e2ee-room.js";
import {
  assertMatrixQaBootstrapSucceeded,
  ensureMatrixQaE2eeOwnDeviceVerified,
  MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID,
  MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT,
  requireMatrixQaE2eeOutputDir,
  requireMatrixQaPassword,
  resolveMatrixQaE2eeScenarioGroupRoom,
  waitForMatrixQaNonEmptyRoomKeyRestore,
} from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeBootstrapSuccessScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(context, "matrix-e2ee-bootstrap-success", async (client) => {
    const initial = await client.bootstrapOwnDeviceVerification();
    assertMatrixQaBootstrapSucceeded("driver initial", initial);
    const result = await client.bootstrapOwnDeviceVerification({
      forceResetCrossSigning: true,
    });
    assertMatrixQaBootstrapSucceeded("driver", result);
    return {
      artifacts: {
        backupCreatedVersion: result.verification.backupVersion,
        bootstrapActor: "driver",
        bootstrapSuccess: true,
        currentDeviceId: result.verification.deviceId,
        recoveryKeyId: result.verification.recoveryKeyId,
        recoveryKeyStored: result.verification.recoveryKeyStored,
      },
      details: [
        "driver bootstrap and guarded cross-signing reset succeeded through real Matrix crypto bootstrap",
        `device verified: ${result.verification.verified ? "yes" : "no"}`,
        `cross-signing verified: ${result.verification.crossSigningVerified ? "yes" : "no"}`,
        `signed by owner: ${result.verification.signedByOwner ? "yes" : "no"}`,
        `cross-signing published: ${result.crossSigning.published ? "yes" : "no"}`,
        `room-key backup version: ${result.verification.backupVersion ?? "<none>"}`,
        `recovery key id: ${result.verification.recoveryKeyId ?? "<none>"}`,
      ].join("\n"),
    };
  });
}

export async function runMatrixQaE2eeRecoveryKeyLifecycleScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const driverPassword = requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-recovery-key-lifecycle",
    async (client) => {
      const { roomId } = resolveMatrixQaE2eeScenarioGroupRoom(
        context,
        "matrix-e2ee-recovery-key-lifecycle",
      );
      const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
        client,
        label: "driver",
      });
      const recoveryKey = ready.recoveryKey;
      const encodedRecoveryKey = recoveryKey?.encodedPrivateKey?.trim();
      if (!encodedRecoveryKey) {
        throw new Error("Matrix E2EE bootstrap did not expose an encoded recovery key");
      }
      const seededEventId = await client.sendTextMessage({
        body: `E2EE recovery-key restore seed ${randomUUID().slice(0, 8)}`,
        roomId,
      });
      const loginClient = createMatrixQaClient({
        baseUrl: context.baseUrl,
      });
      const recoveryDevice = await loginClient.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Recovery Restore Device",
        password: driverPassword,
        userId: context.driverUserId,
      });
      if (!recoveryDevice.deviceId) {
        throw new Error("Matrix E2EE recovery login did not return a secondary device id");
      }
      const recoveryClient = await createMatrixQaE2eeScenarioClient({
        accessToken: recoveryDevice.accessToken,
        actorId: `driver-recovery-${randomUUID().slice(0, 8)}`,
        baseUrl: context.baseUrl,
        deviceId: recoveryDevice.deviceId,
        observedEvents: context.observedEvents,
        outputDir: requireMatrixQaE2eeOutputDir(context),
        password: recoveryDevice.password,
        scenarioId: "matrix-e2ee-recovery-key-lifecycle",
        timeoutMs: context.timeoutMs,
        userId: recoveryDevice.userId,
      });
      let cleanupRecoveryDevice = true;
      try {
        const recoveryVerification = await recoveryClient.verifyWithRecoveryKey(encodedRecoveryKey);
        if (!recoveryVerification.success) {
          throw new Error(
            `Matrix E2EE recovery device verification failed: ${recoveryVerification.error ?? "unknown error"}`,
          );
        }
        const restored = await waitForMatrixQaNonEmptyRoomKeyRestore({
          client: recoveryClient,
          recoveryKey: encodedRecoveryKey,
          timeoutMs: context.timeoutMs,
        });
        const reset = await recoveryClient.resetRoomKeyBackup();
        if (!reset.success) {
          throw new Error(
            `Matrix E2EE room-key backup reset failed: ${reset.error ?? "unknown error"}`,
          );
        }
        const resetRecoveryKey = await recoveryClient.getRecoveryKey();
        const resetEncodedRecoveryKey = resetRecoveryKey?.encodedPrivateKey?.trim();
        if (resetEncodedRecoveryKey && resetEncodedRecoveryKey !== encodedRecoveryKey) {
          const ownerRecovery = await client.verifyWithRecoveryKey(resetEncodedRecoveryKey);
          if (!ownerRecovery.success) {
            throw new Error(
              `Matrix E2EE owner could not refresh recovery key after backup reset: ${
                ownerRecovery.error ?? "unknown error"
              }`,
            );
          }
        }
        await recoveryClient.stop();
        await client.stop().catch(() => undefined);
        await client.deleteOwnDevices([recoveryDevice.deviceId]).catch(() => undefined);
        cleanupRecoveryDevice = false;
        return {
          artifacts: {
            backupCreatedVersion: reset.createdVersion,
            backupReset: reset.success,
            backupRestored: restored.success,
            bootstrapActor: "driver",
            bootstrapSuccess: ready.bootstrap?.success ?? true,
            recoveryDeviceId: recoveryDevice.deviceId,
            recoveryKeyId: recoveryKey?.keyId ?? null,
            recoveryKeyUsable:
              recoveryVerification.recoveryKeyAccepted && recoveryVerification.backupUsable,
            recoveryKeyStored: true,
            recoveryVerified: recoveryVerification.deviceOwnerVerified,
            restoreImported: restored.imported,
            restoreTotal: restored.total,
            seededEventId,
          },
          details: [
            "driver recovery lifecycle completed through real Matrix recovery APIs",
            `bootstrap backup version: ${ready.verification.backupVersion ?? "<none>"}`,
            `seeded encrypted event: ${seededEventId}`,
            `recovery device: ${recoveryDevice.deviceId}`,
            `recovery key usable: ${recoveryVerification.backupUsable ? "yes" : "no"}`,
            `recovery device verified: ${recoveryVerification.deviceOwnerVerified ? "yes" : "no"}`,
            `restore imported/total: ${restored.imported}/${restored.total}`,
            `restore loaded from secret storage: ${restored.loadedFromSecretStorage ? "yes" : "no"}`,
            `reset previous version: ${reset.previousVersion ?? "<none>"}`,
            `reset created version: ${reset.createdVersion ?? "<none>"}`,
          ].join("\n"),
        };
      } finally {
        if (cleanupRecoveryDevice) {
          await recoveryClient.stop().catch(() => undefined);
          await client.stop().catch(() => undefined);
          await client.deleteOwnDevices([recoveryDevice.deviceId]).catch(() => undefined);
        }
      }
    },
  );
}

export async function runMatrixQaE2eeRecoveryOwnerVerificationRequiredScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const driverPassword = requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-recovery-owner-verification-required",
    async (client) => {
      const { roomId } = resolveMatrixQaE2eeScenarioGroupRoom(
        context,
        "matrix-e2ee-recovery-owner-verification-required",
      );
      const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
        client,
        label: "driver",
      });
      const recoveryKey = ready.recoveryKey;
      const encodedRecoveryKey = recoveryKey?.encodedPrivateKey?.trim();
      if (!encodedRecoveryKey) {
        throw new Error("Matrix E2EE bootstrap did not expose an encoded recovery key");
      }
      const seededEventId = await client.sendTextMessage({
        body: `E2EE recovery owner-verification seed ${randomUUID().slice(0, 8)}`,
        roomId,
      });
      const loginClient = createMatrixQaClient({
        baseUrl: context.baseUrl,
      });
      const recoveryDevice = await loginClient.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Owner Verification Required Device",
        password: driverPassword,
        userId: context.driverUserId,
      });
      if (!recoveryDevice.deviceId) {
        throw new Error("Matrix E2EE recovery login did not return a secondary device id");
      }
      try {
        const faulted = await runMatrixQaFaultedRecoveryOwnerVerification({
          accessToken: recoveryDevice.accessToken,
          context,
          deviceId: recoveryDevice.deviceId,
          encodedRecoveryKey,
          userId: recoveryDevice.userId,
        });
        assertMatrixQaFaultedRecoveryOwnerVerificationRequired(faulted);
        return {
          artifacts: {
            backupRestored: faulted.restore.success,
            backupUsable: faulted.verification.backupUsable,
            faultHitCount: faulted.faultHits.length,
            faultedEndpoints: faulted.faultHits.map((hit) => hit.path),
            faultRuleId: MATRIX_QA_OWNER_SIGNATURE_UPLOAD_BLOCKED_RULE_ID,
            recoveryDeviceId: recoveryDevice.deviceId,
            recoveryKeyAccepted: faulted.verification.recoveryKeyAccepted,
            recoveryKeyId: recoveryKey?.keyId ?? null,
            recoveryVerified: faulted.verification.deviceOwnerVerified,
            restoreImported: faulted.restore.imported,
            restoreTotal: faulted.restore.total,
            verificationSuccess: faulted.verification.success,
          },
          details: [
            "driver recovery key unlocked backup while owner signature upload was blocked",
            `seeded encrypted event: ${seededEventId}`,
            `recovery device: ${recoveryDevice.deviceId}`,
            `fault hits: ${faulted.faultHits.length}`,
            `recovery key accepted: ${faulted.verification.recoveryKeyAccepted ? "yes" : "no"}`,
            `backup usable: ${faulted.verification.backupUsable ? "yes" : "no"}`,
            `device owner verified: ${faulted.verification.deviceOwnerVerified ? "yes" : "no"}`,
            `restore imported/total: ${faulted.restore.imported}/${faulted.restore.total}`,
          ].join("\n"),
        };
      } finally {
        await client.stop().catch(() => undefined);
        await client.deleteOwnDevices([recoveryDevice.deviceId]).catch(() => undefined);
      }
    },
  );
}

export async function runMatrixQaE2eeKeyBootstrapFailureScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const { faultHits, result } = await runMatrixQaFaultedE2eeBootstrap(context);
  const bootstrapError = assertMatrixQaExpectedBootstrapFailure({ faultHits, result });

  return {
    artifacts: {
      bootstrapActor: "driver",
      bootstrapErrorPreview: truncateUtf16Safe(bootstrapError, 240),
      bootstrapSuccess: result.success,
      faultedEndpoint: MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT,
      faultHitCount: faultHits.length,
      ...(faultHits[0]?.ruleId ? { faultRuleId: faultHits[0].ruleId } : {}),
    },
    details: [
      "Matrix E2EE bootstrap failure surfaced through real SDK bootstrap.",
      `faulted endpoint: GET ${MATRIX_QA_ROOM_KEY_BACKUP_VERSION_ENDPOINT}`,
      `fault hits: ${faultHits.length}`,
      `bootstrap success: ${result.success ? "yes" : "no"}`,
      `bootstrap error: ${bootstrapError || "<none>"}`,
    ].join("\n"),
  };
}
