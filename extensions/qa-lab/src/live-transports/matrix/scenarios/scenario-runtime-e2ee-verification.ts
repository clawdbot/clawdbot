// Qa Matrix plugin module implements verification scenario runtime E2EE behavior.
import { createMatrixQaClient } from "../substrate/client.js";
import {
  MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY,
  resolveMatrixQaScenarioRoomId,
} from "./scenario-contract.js";
import { withMatrixQaE2eeDriver } from "./scenario-runtime-e2ee-room.js";
import {
  assertMatrixQaPeerDeviceTrusted,
  completeMatrixQaSasVerification,
  ensureMatrixQaE2eeOwnDeviceVerified,
  requireMatrixQaPassword,
  sameMatrixQaVerificationTransaction,
  waitForMatrixQaVerificationSummary,
  withMatrixQaE2eeDriverAndObserver,
} from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeDeviceSasVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  requireMatrixQaPassword(context, "observer");
  if (!context.observerDeviceId) {
    throw new Error("Matrix E2EE observer device id is required for device SAS verification");
  }
  if (!context.driverDeviceId) {
    throw new Error("Matrix E2EE driver device id is required for device SAS verification");
  }
  const observerDeviceId = context.observerDeviceId;
  const driverDeviceId = context.driverDeviceId;
  return await withMatrixQaE2eeDriverAndObserver(
    context,
    "matrix-e2ee-device-sas-verification",
    async ({ driver, observer }) => {
      await Promise.all([
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: driver,
          label: "driver",
        }),
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: observer,
          label: "observer",
        }),
      ]);
      const result = await completeMatrixQaSasVerification({
        initiator: driver,
        recipient: observer,
        recipientUserId: context.observerUserId,
        request: {
          deviceId: observerDeviceId,
          userId: context.observerUserId,
        },
        timeoutMs: context.timeoutMs,
      });
      const driverTrust = await assertMatrixQaPeerDeviceTrusted({
        client: driver,
        deviceId: observerDeviceId,
        label: "driver",
        timeoutMs: context.timeoutMs,
        userId: context.observerUserId,
      });
      const observerTrust = await assertMatrixQaPeerDeviceTrusted({
        client: observer,
        deviceId: driverDeviceId,
        label: "observer",
        timeoutMs: context.timeoutMs,
        userId: context.driverUserId,
      });
      return {
        artifacts: {
          completedVerificationIds: [result.completedInitiator.id, result.completedRecipient.id],
          currentDeviceId: driverDeviceId,
          driverTrustsObserverDevice: driverTrust.verified,
          observerTrustsDriverDevice: observerTrust.verified,
          sasEmoji: result.sasEmoji,
          secondaryDeviceId: observerDeviceId,
        },
        details: [
          "driver-to-observer device verification completed with real SAS",
          `initiator transaction: ${result.completedInitiator.transactionId ?? "<none>"}`,
          `recipient transaction: ${result.completedRecipient.transactionId ?? "<none>"}`,
          `driver trusts observer device: ${driverTrust.verified ? "yes" : "no"}`,
          `observer trusts driver device: ${observerTrust.verified ? "yes" : "no"}`,
          `emoji: ${result.sasEmoji.join(", ")}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeQrVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  requireMatrixQaPassword(context, "observer");
  if (!context.observerDeviceId) {
    throw new Error("Matrix E2EE observer device id is required for QR verification");
  }
  if (!context.driverDeviceId) {
    throw new Error("Matrix E2EE driver device id is required for QR verification");
  }
  const observerDeviceId = context.observerDeviceId;
  const driverDeviceId = context.driverDeviceId;
  return await withMatrixQaE2eeDriverAndObserver(
    context,
    "matrix-e2ee-qr-verification",
    async ({ driver, observer }) => {
      await Promise.all([
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: driver,
          label: "driver",
        }),
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: observer,
          label: "observer",
        }),
      ]);
      const initiated = await driver.requestVerification({
        deviceId: observerDeviceId,
        userId: context.observerUserId,
      });
      const incoming = await waitForMatrixQaVerificationSummary({
        client: observer,
        label: "QR recipient request",
        predicate: (summary) =>
          !summary.initiatedByMe && sameMatrixQaVerificationTransaction(summary, initiated),
        timeoutMs: context.timeoutMs,
      });
      if (incoming.canAccept) {
        await observer.acceptVerification(incoming.id);
      }
      await waitForMatrixQaVerificationSummary({
        client: driver,
        label: "QR request ready",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, initiated) && summary.phaseName === "ready",
        timeoutMs: context.timeoutMs,
      });
      const qr = await driver.generateVerificationQr(initiated.id);
      await observer.scanVerificationQr(incoming.id, qr.qrDataBase64);
      const reciprocate = await waitForMatrixQaVerificationSummary({
        client: driver,
        label: "QR reciprocate",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, initiated) && summary.hasReciprocateQr,
        timeoutMs: context.timeoutMs,
      });
      await driver.confirmVerificationReciprocateQr(reciprocate.id);
      const qrByteCount = Buffer.from(qr.qrDataBase64, "base64").byteLength;
      const completedDriver = await waitForMatrixQaVerificationSummary({
        client: driver,
        label: "QR driver complete",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, initiated) && summary.completed,
        timeoutMs: context.timeoutMs,
      });
      const completedObserver = await waitForMatrixQaVerificationSummary({
        client: observer,
        label: "QR observer complete",
        predicate: (summary) =>
          sameMatrixQaVerificationTransaction(summary, completedDriver) && summary.completed,
        timeoutMs: context.timeoutMs,
      });
      const driverTrust = await assertMatrixQaPeerDeviceTrusted({
        client: driver,
        deviceId: observerDeviceId,
        label: "driver",
        timeoutMs: context.timeoutMs,
        userId: context.observerUserId,
      });
      const observerTrust = await assertMatrixQaPeerDeviceTrusted({
        client: observer,
        deviceId: driverDeviceId,
        label: "observer",
        timeoutMs: context.timeoutMs,
        userId: context.driverUserId,
      });
      return {
        artifacts: {
          completedVerificationIds: [completedDriver.id, completedObserver.id],
          driverTrustsObserverDevice: driverTrust.verified,
          identityVerificationCompleted: true,
          observerTrustsDriverDevice: observerTrust.verified,
          qrBytes: qrByteCount,
          secondaryDeviceId: observerDeviceId,
        },
        details: [
          "driver-to-observer QR verification completed through real QR scan",
          `transaction: ${completedDriver.transactionId ?? "<none>"}`,
          `driver trusts observer device: ${driverTrust.verified ? "yes" : "no"}`,
          `observer trusts driver device: ${observerTrust.verified ? "yes" : "no"}`,
          `qr bytes: ${qrByteCount}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeStaleDeviceHygieneScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const driverPassword = requireMatrixQaPassword(context, "driver");
  return await withMatrixQaE2eeDriver(
    context,
    "matrix-e2ee-stale-device-hygiene",
    async (client) => {
      await ensureMatrixQaE2eeOwnDeviceVerified({
        client,
        label: "driver",
      });
      const loginClient = createMatrixQaClient({
        baseUrl: context.baseUrl,
      });
      const secondary = await loginClient.loginWithPassword({
        deviceName: "OpenClaw Matrix QA Stale Device",
        password: driverPassword,
        userId: context.driverUserId,
      });
      if (!secondary.deviceId) {
        throw new Error("Matrix stale-device login did not return a secondary device id");
      }
      const before = await client.listOwnDevices();
      if (!before.some((device) => device.deviceId === secondary.deviceId)) {
        throw new Error("Matrix stale-device list did not include the secondary login");
      }
      await client.stop().catch(() => undefined);
      const deleted = await client.deleteOwnDevices([secondary.deviceId]);
      const remainingDeviceIds = deleted.remainingDevices.map((device) => device.deviceId);
      if (remainingDeviceIds.includes(secondary.deviceId)) {
        throw new Error(
          "Matrix stale-device deletion left the secondary device in the device list",
        );
      }
      if (
        deleted.currentDeviceId &&
        !deleted.remainingDevices.some((device) => device.deviceId === deleted.currentDeviceId)
      ) {
        throw new Error("Matrix stale-device deletion removed the current device");
      }
      return {
        artifacts: {
          currentDeviceId: deleted.currentDeviceId,
          deletedDeviceIds: deleted.deletedDeviceIds,
          remainingDeviceIds,
          secondaryDeviceId: secondary.deviceId,
        },
        details: [
          "driver secondary device was created, observed, and removed through real device APIs",
          `current device: ${deleted.currentDeviceId ?? "<none>"}`,
          `deleted device: ${secondary.deviceId}`,
          `remaining devices: ${remainingDeviceIds.join(", ")}`,
        ].join("\n"),
      };
    },
  );
}

export async function runMatrixQaE2eeDmSasVerificationScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  requireMatrixQaPassword(context, "driver");
  requireMatrixQaPassword(context, "observer");
  const roomId = resolveMatrixQaScenarioRoomId(context, MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY);
  return await withMatrixQaE2eeDriverAndObserver(
    context,
    "matrix-e2ee-dm-sas-verification",
    async ({ driver, observer }) => {
      await Promise.all([
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: driver,
          label: "driver",
        }),
        ensureMatrixQaE2eeOwnDeviceVerified({
          client: observer,
          label: "observer",
        }),
      ]);
      const result = await completeMatrixQaSasVerification({
        initiator: driver,
        recipient: observer,
        recipientUserId: context.observerUserId,
        request: {
          roomId,
          userId: context.observerUserId,
        },
        timeoutMs: context.timeoutMs,
      });
      if (
        result.completedInitiator.roomId !== roomId ||
        result.completedRecipient.roomId !== roomId
      ) {
        throw new Error("Matrix E2EE DM verification completed outside the expected DM room");
      }
      return {
        artifacts: {
          completedVerificationIds: [result.completedInitiator.id, result.completedRecipient.id],
          roomKey: MATRIX_QA_E2EE_VERIFICATION_DM_ROOM_KEY,
          sasEmoji: result.sasEmoji,
          verificationRoomId: roomId,
        },
        details: [
          "driver/observer encrypted DM verification completed with SAS in the expected room",
          `verification DM room: ${roomId}`,
          `transaction: ${result.completedInitiator.transactionId ?? "<none>"}`,
          `emoji: ${result.sasEmoji.join(", ")}`,
        ].join("\n"),
      };
    },
  );
}
