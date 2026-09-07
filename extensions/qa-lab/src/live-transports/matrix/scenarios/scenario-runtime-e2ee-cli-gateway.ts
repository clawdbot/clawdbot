// Qa Matrix plugin module implements gateway CLI E2EE scenarios.
import { randomUUID } from "node:crypto";
import { createMatrixQaClient } from "../substrate/client.js";
import { createMatrixQaE2eeScenarioClient } from "../substrate/e2ee-client.js";
import { buildMatrixQaE2eeScenarioRoomKey } from "./scenario-contract.js";
import {
  patchMatrixQaGatewayMatrixAccount,
  replaceMatrixQaGatewayMatrixAccount,
} from "./scenario-runtime-config.js";
import {
  assertMatrixQaCliE2eeStatus,
  readMatrixQaCliConfig,
} from "./scenario-runtime-e2ee-cli-config.js";
import {
  createMatrixQaCliE2eeSetupRuntime,
  createMatrixQaCliGatewayRuntime,
} from "./scenario-runtime-e2ee-cli-runtime.js";
import {
  buildMatrixQaPluginActivationConfig,
  parseMatrixQaCliJson,
  registerMatrixQaCliE2eeAccount,
  type MatrixQaCliEncryptionSetupStatus,
  writeMatrixQaCliOutputArtifacts,
} from "./scenario-runtime-e2ee-cli-shared.js";
import { buildMatrixE2eeReplyArtifact } from "./scenario-runtime-e2ee-room.js";
import {
  ensureMatrixQaE2eeOwnDeviceVerified,
  requireMatrixQaE2eeOutputDir,
  requireMatrixQaGatewayConfigPath,
} from "./scenario-runtime-e2ee-shared.js";
import {
  assertTopLevelReplyArtifact,
  buildMatrixQaToken,
  buildMatrixReplyDetails,
  buildMentionPrompt,
  isMatrixQaExactMarkerReply,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export async function runMatrixQaE2eeCliEncryptionSetupMultiAccountScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const accountId = "cli-multi-target";
  const decoyAccountId = "cli-multi-decoy";
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Multi Account Owner",
    scenarioId: "matrix-e2ee-cli-encryption-setup-multi-account",
  });
  const loginClient = createMatrixQaClient({
    baseUrl: context.baseUrl,
  });
  const cliDevice = await loginClient.loginWithPassword({
    deviceName: "OpenClaw Matrix QA CLI Multi Account Target Device",
    password: account.password,
    userId: account.userId,
  });
  if (!cliDevice.deviceId) {
    throw new Error("Matrix E2EE CLI multi-account setup login did not return a device id");
  }
  const cli = await createMatrixQaCliE2eeSetupRuntime({
    artifactLabel: "cli-encryption-setup-multi-account",
    context,
    initialConfig: {
      ...buildMatrixQaPluginActivationConfig(),
      channels: {
        matrix: {
          defaultAccount: decoyAccountId,
          accounts: {
            [decoyAccountId]: {
              accessToken: "decoy-token",
              deviceId: "DECOYDEVICE",
              encryption: false,
              homeserver: context.baseUrl,
              initialSyncLimit: 1,
              name: "Matrix QA CLI Multi Account Decoy",
              startupVerification: "off",
              userId: "@decoy:matrix-qa.test",
            },
            [accountId]: {
              accessToken: cliDevice.accessToken,
              deviceId: cliDevice.deviceId,
              encryption: false,
              homeserver: context.baseUrl,
              initialSyncLimit: 1,
              name: "Matrix QA CLI Multi Account Target",
              network: {
                dangerouslyAllowPrivateNetwork: true,
              },
              password: account.password,
              startupVerification: "off",
              userId: cliDevice.userId,
            },
          },
        },
      },
    },
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
      label: "encryption-setup-multi-account",
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
        `Matrix CLI multi-account encryption setup did not target the requested account: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    assertMatrixQaCliE2eeStatus("Matrix CLI multi-account encryption setup", setup.status);

    const config = await readMatrixQaCliConfig(cli.configPath);
    const matrix = config.channels?.matrix;
    const target = matrix?.accounts?.[accountId];
    const decoy = matrix?.accounts?.[decoyAccountId];
    const defaultAccountPreserved = matrix?.defaultAccount === decoyAccountId;
    const decoyAccountPreserved =
      decoy?.encryption === false &&
      decoy?.accessToken === "decoy-token" &&
      decoy?.deviceId === "DECOYDEVICE";
    if (!defaultAccountPreserved) {
      throw new Error("Matrix CLI multi-account setup changed the default account");
    }
    if (!decoyAccountPreserved) {
      throw new Error("Matrix CLI multi-account setup mutated the decoy account");
    }
    if (target?.encryption !== true) {
      throw new Error("Matrix CLI multi-account setup did not enable encryption on the target");
    }

    return {
      artifacts: {
        accountId,
        cliDeviceId: setup.status.deviceId ?? cliDevice.deviceId,
        decoyAccountPreserved,
        defaultAccountPreserved,
        encryptionChanged: setup.encryptionChanged,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup changed only the requested account in a multi-account config",
        `setup stdout: ${setupArtifacts.stdoutPath}`,
        `setup stderr: ${setupArtifacts.stderrPath}`,
        `default account preserved: ${defaultAccountPreserved ? "yes" : "no"}`,
        `decoy account preserved: ${decoyAccountPreserved ? "yes" : "no"}`,
        `cli device: ${setup.status.deviceId ?? cliDevice.deviceId}`,
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}

export async function runMatrixQaE2eeCliSetupThenGatewayReplyScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  if (!context.restartGatewayAfterStateMutation) {
    throw new Error(
      "Matrix CLI setup gateway reply scenario requires hard gateway restart support",
    );
  }
  const gatewayConfigPath = requireMatrixQaGatewayConfigPath(context);
  const accountId = "cli-setup-gateway";
  const scenarioId = "matrix-e2ee-cli-setup-then-gateway-reply";
  const roomKey = buildMatrixQaE2eeScenarioRoomKey(scenarioId);
  const account = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Setup Gateway",
    scenarioId,
  });
  const driverAccount = await registerMatrixQaCliE2eeAccount({
    context,
    deviceName: "OpenClaw Matrix QA CLI Setup Driver",
    scenarioId,
  });
  const driverApi = createMatrixQaClient({
    accessToken: driverAccount.accessToken,
    baseUrl: context.baseUrl,
  });
  const gatewayApi = createMatrixQaClient({
    accessToken: account.accessToken,
    baseUrl: context.baseUrl,
  });
  const roomId = await driverApi.createPrivateRoom({
    encrypted: true,
    inviteUserIds: [account.userId],
    name: "Matrix QA CLI Setup Gateway E2EE",
  });
  await gatewayApi.joinRoom(roomId);

  const accountConfig = {
    accessToken: account.accessToken,
    deviceId: account.deviceId,
    dm: {
      allowFrom: [driverAccount.userId],
      enabled: true,
      policy: "allowlist",
      sessionScope: "per-room",
      threadReplies: "inbound",
    },
    enabled: true,
    encryption: false,
    groupAllowFrom: [driverAccount.userId],
    groupPolicy: "allowlist",
    groups: {
      [roomId]: {
        enabled: true,
        requireMention: true,
      },
    },
    homeserver: context.baseUrl,
    initialSyncLimit: 1,
    name: "Matrix QA CLI Setup Gateway",
    network: {
      dangerouslyAllowPrivateNetwork: true,
    },
    password: account.password,
    startupVerification: "off",
    threadReplies: "inbound",
    userId: account.userId,
  };
  await context.restartGatewayAfterStateMutation(
    async () => {
      await replaceMatrixQaGatewayMatrixAccount({
        accountConfig,
        accountId,
        configPath: gatewayConfigPath,
      });
    },
    {
      timeoutMs: context.timeoutMs,
      waitAccountId: accountId,
    },
  );
  await context.waitGatewayAccountReady?.(accountId, {
    timeoutMs: context.timeoutMs,
  });
  const cli = await createMatrixQaCliGatewayRuntime({
    artifactLabel: "cli-setup-then-gateway-reply",
    context,
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
      setup.bootstrap?.success !== true
    ) {
      throw new Error(
        `Matrix CLI gateway account setup did not succeed: ${setup.bootstrap?.error ?? "unknown error"}`,
      );
    }
    if (setup.status) {
      assertMatrixQaCliE2eeStatus("Matrix CLI gateway account setup", setup.status);
    }
    await context.restartGatewayAfterStateMutation(
      async () => {
        await patchMatrixQaGatewayMatrixAccount({
          accountPatch: {
            encryption: true,
            password: account.password,
          },
          accountId,
          configPath: gatewayConfigPath,
        });
      },
      {
        timeoutMs: context.timeoutMs,
        waitAccountId: accountId,
      },
    );
    await context.waitGatewayAccountReady?.(accountId, {
      timeoutMs: context.timeoutMs,
    });
    const driverClient = await createMatrixQaE2eeScenarioClient({
      accessToken: driverAccount.accessToken,
      actorId: `driver-cli-setup-gateway-${randomUUID().slice(0, 8)}`,
      baseUrl: context.baseUrl,
      deviceId: driverAccount.deviceId,
      observedEvents: context.observedEvents,
      outputDir: requireMatrixQaE2eeOutputDir(context),
      password: driverAccount.password,
      scenarioId,
      timeoutMs: context.timeoutMs,
      userId: driverAccount.userId,
    });
    const replied = await (async () => {
      try {
        await ensureMatrixQaE2eeOwnDeviceVerified({
          client: driverClient,
          label: "Matrix CLI setup scenario driver",
        });
        await driverClient.waitForJoinedMember({
          roomId,
          timeoutMs: context.timeoutMs,
          userId: account.userId,
        });
        await driverClient.prime();
        const token = buildMatrixQaToken("MATRIX_QA_E2EE_CLI_GATEWAY");
        const driverEventId = await driverClient.sendTextMessage({
          body: buildMentionPrompt(account.userId, token),
          mentionUserIds: [account.userId],
          roomId,
        });
        const matched = await driverClient.waitForRoomEvent({
          predicate: (event) =>
            isMatrixQaExactMarkerReply(event, {
              roomId,
              sutUserId: account.userId,
              token,
            }) && event.relatesTo === undefined,
          roomId,
          timeoutMs: context.timeoutMs,
        });
        const reply = buildMatrixE2eeReplyArtifact(matched.event, token);
        assertTopLevelReplyArtifact("gateway reply", reply);
        return {
          driverEventId,
          reply,
        };
      } finally {
        await driverClient.stop();
      }
    })();

    return {
      artifacts: {
        accountId,
        cliDeviceId: setup.status?.deviceId ?? account.deviceId ?? null,
        driverUserId: driverAccount.userId,
        encryptionChanged: setup.encryptionChanged,
        gatewayReply: replied.reply,
        gatewayUserId: account.userId,
        roomKey,
        roomId,
        setupSuccess: setup.success,
        verificationBootstrapSuccess: setup.bootstrap.success,
      },
      details: [
        "Matrix CLI encryption setup left the gateway able to reply in an encrypted room",
        `setup stdout: ${setupArtifacts.stdoutPath}`,
        `setup stderr: ${setupArtifacts.stderrPath}`,
        `driver user: ${driverAccount.userId}`,
        `gateway user: ${account.userId}`,
        `encrypted room key: ${roomKey}`,
        `encrypted room id: ${roomId}`,
        `driver event: ${replied.driverEventId}`,
        ...buildMatrixReplyDetails("gateway reply", replied.reply),
      ].join("\n"),
    };
  } finally {
    await cli.dispose();
  }
}
