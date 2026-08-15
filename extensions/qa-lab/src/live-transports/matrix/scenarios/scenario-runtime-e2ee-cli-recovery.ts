// Qa Matrix plugin module implements recovery-key CLI E2EE scenarios.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createMatrixQaClient } from "../substrate/client.js";
import {
  assertMatrixQaCliE2eeStatus,
  buildMatrixQaCliE2eeAccountConfig,
  runMatrixQaCliExpectedFailure,
} from "./scenario-runtime-e2ee-cli-config.js";
import { createMatrixQaCliE2eeSetupRuntime } from "./scenario-runtime-e2ee-cli-runtime.js";
import {
  createMatrixQaE2eeCliOwnerClient,
  isMatrixQaCliBackupUsable,
  parseMatrixQaCliJson,
  registerMatrixQaCliE2eeAccount,
  type MatrixQaCliEncryptionSetupStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import { ensureMatrixQaE2eeOwnDeviceVerified } from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeCliRecoveryKeySetupScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-recovery-key-setup";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Recovery Key Owner",
    scenarioId: "matrix-e2ee-cli-recovery-key-setup",
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({
    account,
    context,
    scenarioId: "matrix-e2ee-cli-recovery-key-setup",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
    client: owner,
    label: "driver",
  });
  const encodedRecoveryKey = ready.recoveryKey?.encodedPrivateKey?.trim();
  if (!encodedRecoveryKey) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI recovery-key setup did not expose a recovery key");
  }
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Recovery Key Setup Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI recovery-key setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-recovery-key-setup",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Recovery Key Setup",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const setupResult = await cli.run(
      ["matrix", "encryption", "setup", "--account", accountId, "--recovery-key-stdin", "--json"],
      context.timeoutMs,
      `${encodedRecoveryKey}\n`,
    );
    const setupArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "recovery-key-setup",
      result: setupResult,
      rootDir: cli.rootDir,
    });
    const setup = parseMatrixQaCliJson(setupResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      setup.accountId !== accountId ||
      setup.success !== true ||
      setup.encryptionChanged !== true ||
      setup.bootstrap?.success !== true ||
      !setup.status
    ) {
      throw new Error(
        `Matrix CLI recovery-key encryption setup did not succeed: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI recovery-key encryption setup", setup.status, {
      allowUntrustedMatchingKey: true,
    });

    return {
      artifacts: {
        accountId,
        backupVersion: setup.status.backupVersion ?? ready.verification.backupVersion ?? null,
        cliDeviceId: setup.status.deviceId ?? cliDevice.deviceId,
        encryptionChanged: setup.encryptionChanged,
        recoveryKeyId: ready.recoveryKey?.keyId ?? null,
        recoveryKeyStored: true,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup accepted a recovery key on a second device",
        `recovery setup stdout: ${setupArtifacts.stdoutPath}`,
        `recovery setup stderr: ${setupArtifacts.stderrPath}`,
        `owner backup version: ${ready.verification.backupVersion ?? "<none>"}`,
        `recovery key id: ${ready.recoveryKey?.keyId ?? "<none>"}`,
        `cli device: ${setup.status.deviceId ?? cliDevice.deviceId}`,
        `cli verified by owner: ${setup.status.verified ? "yes" : "no"}`,
        `cli backup usable: ${
          isMatrixQaCliBackupUsable(setup.status.backup, { allowUntrustedMatchingKey: true })
            ? "yes"
            : "no"
        }`,
      ].join("\n"),
    };
  } finally {
    try {
      await owner.stop().catch(() => undefined);
      await owner.deleteOwnDevices([cliDevice.deviceId]).catch(() => undefined);
    } finally {
      await cli.dispose();
    }
  }
}

export async function runMatrixQaE2eeCliRecoveryKeyInvalidScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-invalid-recovery-key";
  const invalidRecoveryKey = "not-a-valid-matrix-recovery-key";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Invalid Recovery Key Owner",
    scenarioId: "matrix-e2ee-cli-recovery-key-invalid",
  });
  const owner = await createMatrixQaE2eeCliOwnerClient({
    account,
    context,
    scenarioId: "matrix-e2ee-cli-recovery-key-invalid",
  });
  const ready = await ensureMatrixQaE2eeOwnDeviceVerified({
    client: owner,
    label: "cli invalid recovery-key owner",
  });
  if (!ready.recoveryKey?.encodedPrivateKey?.trim()) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI invalid recovery-key setup did not seed secret storage");
  }
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Invalid Recovery Key Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    await owner.stop().catch(() => undefined);
    throw new Error("Matrix E2EE CLI invalid recovery-key login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-recovery-key-invalid",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Invalid Recovery Key",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const failed = await runMatrixQaCliExpectedFailure({
      args: [
        "matrix",
        "encryption",
        "setup",
        "--account",
        accountId,
        "--recovery-key-stdin",
        "--json",
      ],
      start: cli.start,
      stdin: `${invalidRecoveryKey}\n`,
      timeoutMs: context.timeoutMs,
    });
    const artifacts = await writeMatrixQaCliOutputArtifacts({
      label: "recovery-key-invalid",
      result: failed,
      rootDir: cli.rootDir,
    });
    const payload = parseMatrixQaCliJson(failed) as MatrixQaCliEncryptionSetupStatus & {
      error?: string;
    };
    if (payload.success !== false && payload.bootstrap?.success !== false) {
      throw new Error("Matrix CLI invalid recovery-key setup did not report failure");
    }
    const failure = payload.bootstrap?.error ?? payload.error ?? "";
    if (!/recovery|secret|key/i.test(failure)) {
      throw new Error(
        `Matrix CLI invalid recovery-key setup failed for an unexpected reason: ${failure}`,
      );
    }
    if (failed.stdout.includes(invalidRecoveryKey) || failed.stderr.includes(invalidRecoveryKey)) {
      throw new Error("Matrix CLI invalid recovery-key output leaked the recovery key");
    }

    return {
      artifacts: {
        accountId,
        bootstrapErrorPreview: truncateUtf16Safe(failure, 240),
        bootstrapSuccess: false,
        cliDeviceId: cliDevice.deviceId,
        encryptionChanged: payload.encryptionChanged,
        recoveryKeyAccepted: false,
        recoveryKeyRejected: true,
        setupSuccess: false,
      },
      details: [
        "Matrix CLI encryption setup rejected an invalid recovery key without leaking it",
        `failure stdout: ${artifacts.stdoutPath}`,
        `failure stderr: ${artifacts.stderrPath}`,
        `cli device: ${cliDevice.deviceId}`,
        `failure: ${failure}`,
      ].join("\n"),
    };
  } finally {
    try {
      await owner.stop().catch(() => undefined);
      await owner.deleteOwnDevices([cliDevice.deviceId]).catch(() => undefined);
    } finally {
      await cli.dispose();
    }
  }
}
