// Qa Matrix plugin module implements account setup CLI E2EE scenarios.
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createMatrixQaClient } from "../substrate/client.js";
import { startMatrixQaFaultProxy } from "../substrate/fault-proxy.js";
import {
  assertMatrixQaCliAccountAddBootstrapStatus,
  assertMatrixQaCliE2eeStatus,
  buildMatrixQaCliE2eeAccountConfig,
  runMatrixQaCliExpectedFailure,
} from "./scenario-runtime-e2ee-cli-config.js";
import { createMatrixQaCliE2eeSetupRuntime } from "./scenario-runtime-e2ee-cli-runtime.js";
import {
  isMatrixQaCliBackupUsable,
  parseMatrixQaCliJson,
  registerMatrixQaCliE2eeAccount,
  type MatrixQaCliAccountAddStatus,
  type MatrixQaCliEncryptionSetupStatus,
  type MatrixQaCliVerificationStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import { buildRoomKeyBackupUnavailableFaultRule } from "./scenario-runtime-e2ee-room.js";
import { MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID } from "./scenario-runtime-e2ee-shared.js";
import type { MatrixQaScenarioContext } from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeCliAccountAddEnableE2eeScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-add-e2ee";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Account Add Owner",
    scenarioId: "matrix-e2ee-cli-account-add-enable-e2ee",
  });
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-account-add-enable-e2ee",
    context,
  });
  try {
    const addResult = await cli.run([
      "matrix",
      "account",
      "add",
      "--account",
      accountId,
      "--name",
      "Matrix QA CLI Account Add E2EE",
      "--homeserver",
      context.baseUrl,
      "--user-id",
      account.userId,
      "--password",
      account.password,
      "--device-name",
      "OpenClaw Matrix QA CLI Account Add E2EE",
      "--allow-private-network",
      "--enable-e2ee",
      "--json",
    ]);
    const addArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "account-add-enable-e2ee",
      result: addResult,
      rootDir: cli.rootDir,
    });
    const added = parseMatrixQaCliJson(addResult) as MatrixQaCliAccountAddStatus;
    if (added.accountId !== accountId || added.encryptionEnabled !== true) {
      throw new Error(
        "Matrix CLI account add did not report E2EE enabled for the expected account",
      );
    }
    if (added.verificationBootstrap?.attempted !== true) {
      throw new Error("Matrix CLI account add did not attempt verification bootstrap");
    }
    if (added.verificationBootstrap.success !== true) {
      throw new Error(
        `Matrix CLI account add verification bootstrap failed: ${added.verificationBootstrap.error ?? "unknown error"}`,
      );
    }

    const statusResult = await cli.run([
      "matrix",
      "verify",
      "status",
      "--account",
      accountId,
      "--allow-degraded-local-state",
      "--json",
    ]);
    const statusArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "verify-status",
      result: statusResult,
      rootDir: cli.rootDir,
    });
    const status = parseMatrixQaCliJson(statusResult) as MatrixQaCliVerificationStatus;
    assertMatrixQaCliAccountAddBootstrapStatus({
      expectedBackupVersion: added.verificationBootstrap.backupVersion,
      expectedUserId: account.userId,
      status,
    });
    const cliDeviceId = status.deviceId ?? null;

    return {
      artifacts: {
        accountId,
        backupVersion: added.verificationBootstrap.backupVersion ?? null,
        cliDeviceId,
        encryptionEnabled: added.encryptionEnabled,
        verificationBootstrapAttempted: added.verificationBootstrap.attempted,
        verificationBootstrapSuccess: added.verificationBootstrap.success,
      },
      details: [
        "Matrix CLI account add --enable-e2ee created an encrypted account and bootstrapped recovery state",
        `account add stdout: ${addArtifacts.stdoutPath}`,
        `account add stderr: ${addArtifacts.stderrPath}`,
        `verify status stdout: ${statusArtifacts.stdoutPath}`,
        `verify status stderr: ${statusArtifacts.stderrPath}`,
        `cli device: ${cliDeviceId ?? "<unknown>"}`,
        `cli verified by owner: ${status.verified ? "yes" : "no"}`,
        `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-setup";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Setup Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Encryption Setup Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI encryption setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Encryption Setup",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const setupResult = await cli.run([
      "matrix",
      "encryption",
      "setup",
      "--account",
      accountId,
      "--json",
    ]);
    const setupArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup",
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
        `Matrix CLI encryption setup did not report a successful E2EE upgrade: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup", setup.status);

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
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup status", status);

    return {
      artifacts: {
        accountId,
        cliDeviceId: status.deviceId ?? cliDevice.deviceId,
        encryptionChanged: setup.encryptionChanged,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup upgraded an existing account and bootstrapped verification",
        `encryption setup stdout: ${setupArtifacts.stdoutPath}`,
        `encryption setup stderr: ${setupArtifacts.stderrPath}`,
        `verify status stdout: ${statusArtifacts.stdoutPath}`,
        `verify status stderr: ${statusArtifacts.stderrPath}`,
        `cli device: ${status.deviceId ?? cliDevice.deviceId}`,
        `cli verified by owner: ${status.verified ? "yes" : "no"}`,
        `cli backup usable: ${isMatrixQaCliBackupUsable(status.backup) ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupIdempotentScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-idempotent";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Idempotent Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-idempotent",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Encryption Idempotent Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI idempotent setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup-idempotent",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: context.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: true,
      name: "Matrix QA CLI Encryption Setup Idempotent",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const setupArgs = ["matrix", "encryption", "setup", "--account", accountId, "--json"];
    const firstResult = await cli.run(setupArgs);
    const firstArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-first",
      result: firstResult,
      rootDir: cli.rootDir,
    });
    const first = parseMatrixQaCliJson(firstResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      first.accountId !== accountId ||
      first.success !== true ||
      first.encryptionChanged !== false ||
      first.bootstrap?.success !== true ||
      !first.status
    ) {
      throw new Error(
        `Matrix CLI encryption setup was not idempotent on first run: ${first.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup idempotent first run", first.status);

    const secondResult = await cli.run(setupArgs);
    const secondArtifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-second",
      result: secondResult,
      rootDir: cli.rootDir,
    });
    const second = parseMatrixQaCliJson(secondResult) as MatrixQaCliEncryptionSetupStatus;
    if (
      second.accountId !== accountId ||
      second.success !== true ||
      second.encryptionChanged !== false ||
      second.bootstrap?.success !== true ||
      !second.status
    ) {
      throw new Error(
        `Matrix CLI encryption setup was not idempotent on second run: ${second.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI encryption setup idempotent second run", second.status);

    return {
      artifacts: {
        accountId,
        cliDeviceId: second.status.deviceId ?? cliDevice.deviceId,
        firstEncryptionChanged: first.encryptionChanged,
        secondEncryptionChanged: second.encryptionChanged,
        setupSuccess: second.success,
        verificationBootstrapSuccess: second.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup stayed idempotent on an already encrypted account",
        `first setup stdout: ${firstArtifacts.stdoutPath}`,
        `first setup stderr: ${firstArtifacts.stderrPath}`,
        `second setup stdout: ${secondArtifacts.stdoutPath}`,
        `second setup stderr: ${secondArtifacts.stderrPath}`,
        `cli device: ${second.status.deviceId ?? cliDevice.deviceId}`,
        `first encryption changed: ${first.encryptionChanged ? "yes" : "no"}`,
        `second encryption changed: ${second.encryptionChanged ? "yes" : "no"}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliEncryptionSetupBootstrapFailureScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-encryption-failure";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Encryption Failure Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-bootstrap-failure",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Encryption Failure Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI bootstrap-failure login did not return a device id");
  }
  const proxy = await startMatrixQaFaultProxy({
    targetBaseUrl: context.faultProxyTargetBaseUrl ?? context.baseUrl,
    ...context.faultProxyObserver,
    rules: [buildRoomKeyBackupUnavailableFaultRule(cliDevice.accessToken)],
  });
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup-bootstrap-failure",
    context,
    initialConfig: buildMatrixQaCliE2eeAccountConfig({
      accountId,
      accessToken: cliDevice.accessToken,
      baseUrl: proxy.baseUrl,
      deviceId: cliDevice.deviceId,
      encryption: false,
      name: "Matrix QA CLI Encryption Setup Bootstrap Failure",
      password: account.password,
      userId: cliDevice.userId,
    }),
  });
  try {
    const failed = await runMatrixQaCliExpectedFailure({
      args: ["matrix", "encryption", "setup", "--account", accountId, "--json"],
      start: cli.start,
      timeoutMs: context.timeoutMs,
    });
    const artifacts = await writeMatrixQaCliOutputArtifacts({
      label: "encryption-setup-bootstrap-failure",
      result: failed,
      rootDir: cli.rootDir,
    });
    const payload = parseMatrixQaCliJson(failed) as MatrixQaCliEncryptionSetupStatus;
    if (payload.success !== false && payload.bootstrap?.success !== false) {
      throw new Error("Matrix CLI encryption setup failure did not report unsuccessful bootstrap");
    }
    const faultHits = proxy.hits();
    if (faultHits.length === 0) {
      throw new Error("Matrix CLI encryption setup bootstrap-failure proxy was not exercised");
    }
    const bootstrapError = payload.bootstrap?.error ?? "";
    if (!bootstrapError.toLowerCase().includes("room key backup")) {
      throw new Error(
        `Matrix CLI encryption setup failed for an unexpected reason: ${bootstrapError}`,
      );
    }

    return {
      artifacts: {
        accountId,
        bootstrapErrorPreview: truncateUtf16Safe(bootstrapError, 240),
        bootstrapSuccess: false,
        cliDeviceId: cliDevice.deviceId,
        faultedEndpoint: faultHits[0]?.path,
        faultHitCount: faultHits.length,
        faultRuleId: MATRIX_QA_ROOM_KEY_BACKUP_FAULT_RULE_ID,
      },
      details: [
        "Matrix CLI encryption setup surfaced a bootstrap failure from a faulted room-key backup endpoint",
        `failure stdout: ${artifacts.stdoutPath}`,
        `failure stderr: ${artifacts.stderrPath}`,
        `fault hits: ${faultHits.length}`,
        `fault endpoint: ${faultHits[0]?.path ?? "<none>"}`,
        `bootstrap error: ${bootstrapError}`,
      ].join("\n"),
    };
  } finally {
    await Promise.all([cli.dispose(), proxy.stop().catch(() => undefined)]);
  }
}
