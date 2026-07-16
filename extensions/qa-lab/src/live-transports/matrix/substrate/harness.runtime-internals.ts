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
const MATRIX_QA_HEALTH_REQUEST_TIMEOUT_MS = 2_000;

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

export async function isMatrixVersionsReachable(
  baseUrl: string,
  fetchImpl: FetchLike,
  timeoutMs = MATRIX_QA_HEALTH_REQUEST_TIMEOUT_MS,
  signal?: AbortSignal,
) {
  let response: Awaited<ReturnType<FetchLike>> | undefined;
  try {
    const timeoutSignal = AbortSignal.timeout(Math.max(1, timeoutMs));
    response = await fetchImpl(buildVersionsUrl(baseUrl), {
      signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
    });
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
  const deadline = startedAt + timeoutMs;
  const candidateBaseUrls = params.containerBaseUrl
    ? [params.hostBaseUrl, params.containerBaseUrl]
    : [params.hostBaseUrl];

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const probeController = new AbortController();
    let reachableCandidate: string | undefined;
    try {
      // Race both network paths so neither stalled probe can starve or delay
      // a healthy peer. The outer deadline also bounds injected fetch fakes.
      reachableCandidate = await withMatrixQaHarnessTimeout(
        "Matrix health probes",
        remainingMs,
        Promise.any(
          candidateBaseUrls.map(async (baseUrl) => {
            if (
              await isMatrixVersionsReachable(
                baseUrl,
                params.fetchImpl,
                Math.min(MATRIX_QA_HEALTH_REQUEST_TIMEOUT_MS, remainingMs),
                probeController.signal,
              )
            ) {
              return baseUrl;
            }
            throw new Error("Matrix versions endpoint unreachable");
          }),
        ),
      );
    } catch {
      // Poll again after every candidate fails or the discovery deadline expires.
    } finally {
      probeController.abort();
    }
    if (reachableCandidate) {
      return reachableCandidate;
    }
    const remainingSleepMs = deadline - Date.now();
    if (remainingSleepMs > 0) {
      await params.sleepImpl(Math.min(pollMs, remainingSleepMs));
    }
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
