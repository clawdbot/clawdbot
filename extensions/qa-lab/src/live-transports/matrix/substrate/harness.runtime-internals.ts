import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { FetchLike } from "../../../docker-runtime.js";

const MATRIX_QA_DEFAULT_IMAGE = "ghcr.io/matrix-construct/tuwunel:v1.5.1";
const MATRIX_QA_DEFAULT_SERVER_NAME = "matrix-qa.test";
export const MATRIX_QA_DEFAULT_PORT = 28008;
export const MATRIX_QA_INTERNAL_PORT = 8008;
export const MATRIX_QA_SERVICE = "matrix-qa-homeserver";
export const MATRIX_QA_CLEANUP_TIMEOUT_MS = 90_000;

type MatrixQaHarnessManifest = {
  image: string;
  serverName: string;
  homeserverPort: number;
  composeFile: string;
  dataDir: string;
};

export type MatrixQaHarnessFiles = {
  outputDir: string;
  composeFile: string;
  manifestPath: string;
  image: string;
  serverName: string;
  homeserverPort: number;
  registrationToken: string;
};

export function buildVersionsUrl(baseUrl: string) {
  return `${baseUrl}_matrix/client/versions`;
}

export async function isMatrixVersionsReachable(baseUrl: string, fetchImpl: FetchLike) {
  let response: Awaited<ReturnType<FetchLike>> | undefined;
  try {
    response = await fetchImpl(buildVersionsUrl(baseUrl));
    return response.ok;
  } catch {
    return false;
  } finally {
    try {
      await response?.body?.cancel?.();
    } catch {}
  }
}

export async function withMatrixQaHarnessTimeout<T>(
  label: string,
  timeoutMs: number,
  task: Promise<T>,
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

export async function waitForReachableMatrixBaseUrl(params: {
  composeFile: string;
  containerBaseUrl: string | null;
  fetchImpl: FetchLike;
  hostBaseUrl: string;
  sleepImpl: (ms: number) => Promise<unknown>;
  timeoutMs?: number;
  pollMs?: number;
}) {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const pollMs = params.pollMs ?? 1_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await isMatrixVersionsReachable(params.hostBaseUrl, params.fetchImpl)) {
      return params.hostBaseUrl;
    }
    if (
      params.containerBaseUrl &&
      (await isMatrixVersionsReachable(params.containerBaseUrl, params.fetchImpl))
    ) {
      return params.containerBaseUrl;
    }
    await params.sleepImpl(pollMs);
  }

  const candidateLabel = params.containerBaseUrl
    ? `${params.hostBaseUrl} or ${params.containerBaseUrl}`
    : params.hostBaseUrl;
  throw new Error(
    [
      `Matrix homeserver did not become healthy within ${Math.round(timeoutMs / 1000)}s.`,
      `Last checked: ${candidateLabel}`,
      `Hint: check container logs with \`docker compose -f ${params.composeFile} logs ${MATRIX_QA_SERVICE}\`.`,
    ].join("\n"),
  );
}

function resolveMatrixQaHarnessImage(image?: string) {
  return (
    image?.trim() || process.env.OPENCLAW_QA_MATRIX_TUWUNEL_IMAGE?.trim() || MATRIX_QA_DEFAULT_IMAGE
  );
}

function renderMatrixQaCompose(params: {
  homeserverPort: number;
  image: string;
  registrationToken: string;
  serverName: string;
}) {
  return `services:
  ${MATRIX_QA_SERVICE}:
    image: ${params.image}
    ports:
      - "127.0.0.1:${params.homeserverPort}:${MATRIX_QA_INTERNAL_PORT}"
    environment:
      TUWUNEL_ADDRESS: "0.0.0.0"
      TUWUNEL_ALLOW_ENCRYPTION: "true"
      TUWUNEL_ALLOW_FEDERATION: "false"
      TUWUNEL_ALLOW_REGISTRATION: "true"
      TUWUNEL_DATABASE_PATH: "/var/lib/tuwunel"
      TUWUNEL_PORT: "${MATRIX_QA_INTERNAL_PORT}"
      TUWUNEL_REGISTRATION_TOKEN: "${params.registrationToken}"
      TUWUNEL_SERVER_NAME: "${params.serverName}"
    volumes:
      - ./data:/var/lib/tuwunel
`;
}

export async function writeMatrixQaHarnessFiles(params: {
  outputDir: string;
  image?: string;
  homeserverPort: number;
  registrationToken?: string;
  serverName?: string;
}): Promise<MatrixQaHarnessFiles> {
  const image = resolveMatrixQaHarnessImage(params.image);
  const registrationToken = params.registrationToken?.trim() || `matrix-qa-${randomUUID()}`;
  const serverName = params.serverName?.trim() || MATRIX_QA_DEFAULT_SERVER_NAME;
  const composeFile = path.join(params.outputDir, "docker-compose.matrix-qa.yml");
  const dataDir = path.join(params.outputDir, "data");
  const manifestPath = path.join(params.outputDir, "matrix-qa-harness.json");

  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(
    composeFile,
    `${renderMatrixQaCompose({
      homeserverPort: params.homeserverPort,
      image,
      registrationToken,
      serverName,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const manifest: MatrixQaHarnessManifest = {
    image,
    serverName,
    homeserverPort: params.homeserverPort,
    composeFile,
    dataDir,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  return {
    outputDir: params.outputDir,
    composeFile,
    manifestPath,
    image,
    serverName,
    homeserverPort: params.homeserverPort,
    registrationToken,
  };
}
