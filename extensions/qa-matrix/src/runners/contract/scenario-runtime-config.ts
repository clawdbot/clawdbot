import { readFile } from "node:fs/promises";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";

export function isMatrixQaPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

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
