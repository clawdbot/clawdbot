// QA Lab Matrix helper module supports scenario runtime config behavior.
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { isRecord as isMatrixQaPlainRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildMatrixQaToken,
  buildMentionPrompt,
  resolveMatrixQaNoReplyWindowMs,
  runConfigurableTopLevelScenario,
  runNoReplyExpectedScenario,
  type MatrixQaScenarioContext,
} from "./scenario-runtime-shared.js";
import type { MatrixQaScenarioExecution } from "./scenario-types.js";

export { isMatrixQaPlainRecord };

function requireMatrixQaGatewayConfigObject(config: unknown): Record<string, unknown> {
  if (!isMatrixQaPlainRecord(config)) {
    throw new Error("Matrix QA gateway config file must contain an object");
  }
  return config;
}

async function readMatrixQaGatewayConfigFile(configPath: string) {
  return requireMatrixQaGatewayConfigObject(
    JSON.parse(await readFile(configPath, "utf8")) as unknown,
  );
}

async function writeMatrixQaGatewayConfigFile(configPath: string, config: unknown) {
  await replaceFileAtomic({
    filePath: configPath,
    content: `${JSON.stringify(config, null, 2)}\n`,
    mode: 0o600,
    tempPrefix: ".matrix-qa-config",
  });
}

export async function readMatrixQaGatewayMatrixAccount(params: {
  accountId: string;
  configPath: string;
}) {
  const config = await readMatrixQaGatewayConfigFile(params.configPath);
  const channels = isMatrixQaPlainRecord(config.channels) ? config.channels : {};
  const matrix = isMatrixQaPlainRecord(channels.matrix) ? channels.matrix : {};
  const accounts = isMatrixQaPlainRecord(matrix.accounts) ? matrix.accounts : {};
  const account = accounts[params.accountId];
  if (!isMatrixQaPlainRecord(account)) {
    throw new Error(`Matrix QA gateway account "${params.accountId}" missing from config`);
  }
  return account;
}

export async function replaceMatrixQaGatewayMatrixAccount(params: {
  accountConfig: Record<string, unknown>;
  accountId: string;
  configPath: string;
}) {
  const config = await readMatrixQaGatewayConfigFile(params.configPath);
  const channels = isMatrixQaPlainRecord(config.channels) ? config.channels : {};
  const matrix = isMatrixQaPlainRecord(channels.matrix) ? channels.matrix : {};
  channels.matrix = {
    ...matrix,
    defaultAccount: params.accountId,
    accounts: {
      [params.accountId]: params.accountConfig,
    },
  };
  config.channels = channels;
  await writeMatrixQaGatewayConfigFile(params.configPath, config);
}

export async function patchMatrixQaGatewayMatrixAccount(params: {
  accountId: string;
  accountPatch: Record<string, unknown>;
  configPath: string;
}) {
  const config = await readMatrixQaGatewayConfigFile(params.configPath);
  const channels = isMatrixQaPlainRecord(config.channels) ? config.channels : {};
  const matrix = isMatrixQaPlainRecord(channels.matrix) ? channels.matrix : {};
  const accounts = isMatrixQaPlainRecord(matrix.accounts) ? matrix.accounts : {};
  const existing = accounts[params.accountId];
  if (!isMatrixQaPlainRecord(existing)) {
    throw new Error(`Matrix QA gateway account "${params.accountId}" missing from config`);
  }
  channels.matrix = {
    ...matrix,
    defaultAccount: params.accountId,
    accounts: {
      [params.accountId]: {
        ...existing,
        ...params.accountPatch,
      },
    },
  };
  config.channels = channels;
  await writeMatrixQaGatewayConfigFile(params.configPath, config);
}

function requireMatrixQaAccountReload(context: MatrixQaScenarioContext) {
  if (!context.readGatewayAccountStartAt || !context.waitGatewayAccountReady) {
    throw new Error("Matrix QA allowlist reload requires gateway generation readiness support");
  }
  const readStartAt = context.readGatewayAccountStartAt;
  return {
    readStartAt: async (accountId: string) => {
      const startAt = await readStartAt(accountId);
      if (startAt === undefined) {
        throw new Error(`Matrix QA account "${accountId}" has no active start generation`);
      }
      return startAt;
    },
    waitReady: context.waitGatewayAccountReady,
  };
}

export async function runMatrixQaAllowlistHotReloadScenario(
  context: MatrixQaScenarioContext,
): Promise<MatrixQaScenarioExecution> {
  const configPath = context.gatewayRuntimeEnv?.OPENCLAW_CONFIG_PATH;
  const accountId = context.sutAccountId;
  if (!configPath || !accountId) {
    throw new Error("Matrix QA allowlist reload requires the gateway config path and account id");
  }
  const originalAccount = await readMatrixQaGatewayMatrixAccount({ accountId, configPath });
  const accountReload = requireMatrixQaAccountReload(context);
  const { observerAccessToken: accessToken } = context;

  try {
    const acceptedStartAt = await accountReload.readStartAt(accountId);
    await patchMatrixQaGatewayMatrixAccount({
      accountId,
      accountPatch: { groupAllowFrom: [context.driverUserId, context.observerUserId] },
      configPath,
    });
    await accountReload.waitReady(accountId, {
      afterStartAt: acceptedStartAt,
      timeoutMs: context.timeoutMs,
    });
    const acceptedMarkerPrefix = "MATRIX_QA_GROUP_RELOAD_ACCEPTED";
    const accepted = await runConfigurableTopLevelScenario({
      accessToken,
      actorId: "observer",
      baseUrl: context.baseUrl,
      observedEvents: context.observedEvents,
      roomId: context.roomId,
      syncState: context.syncState,
      syncStreams: context.syncStreams,
      sutUserId: context.sutUserId,
      timeoutMs: context.timeoutMs,
      tokenPrefix: acceptedMarkerPrefix,
    });

    const blockedStartAt = await accountReload.readStartAt(accountId);
    await patchMatrixQaGatewayMatrixAccount({
      accountId,
      accountPatch: { groupAllowFrom: [context.driverUserId] },
      configPath,
    });
    await accountReload.waitReady(accountId, {
      afterStartAt: blockedStartAt,
      timeoutMs: context.timeoutMs,
    });
    const { marker: token } = {
      marker: buildMatrixQaToken("MATRIX_QA_GROUP_RELOAD_REMOVED"),
    };
    const blocked = await runNoReplyExpectedScenario({
      accessToken,
      actorId: "observer",
      actorUserId: context.observerUserId,
      baseUrl: context.baseUrl,
      body: buildMentionPrompt(context.sutUserId, token),
      mentionUserIds: [context.sutUserId],
      observedEvents: context.observedEvents,
      roomId: context.roomId,
      syncState: context.syncState,
      syncStreams: context.syncStreams,
      sutUserId: context.sutUserId,
      timeoutMs: resolveMatrixQaNoReplyWindowMs(context.timeoutMs),
      token,
    });
    const { body: triggerBody, ...acceptedArtifacts } = accepted;

    return {
      artifacts: {
        accepted: {
          actorUserId: context.observerUserId,
          ...acceptedArtifacts,
          triggerBody,
        },
        blocked: blocked.artifacts,
      },
      details: `${accepted.token} accepted; ${token} blocked after hot reload`,
    };
  } finally {
    const currentAccount = await readMatrixQaGatewayMatrixAccount({ accountId, configPath });
    if (!isDeepStrictEqual(currentAccount, originalAccount)) {
      const restoreStartAt = await accountReload.readStartAt(accountId);
      await replaceMatrixQaGatewayMatrixAccount({
        accountConfig: originalAccount,
        accountId,
        configPath,
      });
      await accountReload.waitReady(accountId, {
        afterStartAt: restoreStartAt,
        timeoutMs: context.timeoutMs,
      });
    }
  }
}
