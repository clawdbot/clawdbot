import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  resolveHostPort,
  waitForDockerServiceHealth,
  waitForHealth,
  type FetchLike,
  type RunCommand,
} from "../docker-runtime.js";

const MATRIX_QA_DEFAULT_IMAGE = "ghcr.io/matrix-construct/tuwunel:v1.5.1";
const MATRIX_QA_DEFAULT_SERVER_NAME = "matrix-qa.test";
const MATRIX_QA_DEFAULT_PORT = 28008;
const MATRIX_QA_INTERNAL_PORT = 8008;
const MATRIX_QA_SERVICE = "matrix-qa-homeserver";

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

export type MatrixQaHarness = MatrixQaHarnessFiles & {
  baseUrl: string;
  restartService(): Promise<void>;
  stopCommand: string;
  stop(): Promise<void>;
};

function buildVersionsUrl(baseUrl: string) {
  return `${baseUrl}_matrix/client/versions`;
}

async function isMatrixVersionsReachable(baseUrl: string, fetchImpl: FetchLike) {
  return await fetchImpl(buildVersionsUrl(baseUrl))
    .then((response) => response.ok)
    .catch(() => false);
}

async function waitForReachableMatrixBaseUrl(params: {
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

export async function startMatrixQaHarness(
  params: {
    outputDir: string;
    repoRoot?: string;
    image?: string;
    homeserverPort?: number;
    serverName?: string;
  },
  deps?: {
    fetchImpl?: FetchLike;
    runCommand?: RunCommand;
    sleepImpl?: (ms: number) => Promise<unknown>;
    resolveHostPortImpl?: typeof resolveHostPort;
  },
): Promise<MatrixQaHarness> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const resolveHostPortImpl = deps?.resolveHostPortImpl ?? resolveHostPort;
  const runCommand = deps?.runCommand ?? execCommand;
  const fetchImpl = deps?.fetchImpl ?? fetchHealthUrl;
  const sleepImpl = deps?.sleepImpl ?? sleep;
  const homeserverPort = await resolveHostPortImpl(
    params.homeserverPort ?? MATRIX_QA_DEFAULT_PORT,
    params.homeserverPort != null,
  );
  const files = await writeMatrixQaHarnessFiles({
    outputDir: path.resolve(params.outputDir),
    image: params.image,
    homeserverPort,
    serverName: params.serverName,
  });

  try {
    await runCommand(
      "docker",
      ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
      repoRoot,
    );
  } catch {
    // First run or already stopped.
  }

  await runCommand("docker", ["compose", "-f", files.composeFile, "up", "-d"], repoRoot);
  await sleepImpl(1_000);
  await waitForDockerServiceHealth(
    MATRIX_QA_SERVICE,
    files.composeFile,
    repoRoot,
    runCommand,
    sleepImpl,
  );

  const hostBaseUrl = `http://127.0.0.1:${homeserverPort}/`;
  let baseUrl = hostBaseUrl;
  const hostReachable = await isMatrixVersionsReachable(hostBaseUrl, fetchImpl);
  if (!hostReachable) {
    const containerBaseUrl = await resolveComposeServiceUrl(
      MATRIX_QA_SERVICE,
      MATRIX_QA_INTERNAL_PORT,
      files.composeFile,
      repoRoot,
      runCommand,
    );
    baseUrl = await waitForReachableMatrixBaseUrl({
      composeFile: files.composeFile,
      containerBaseUrl,
      fetchImpl,
      hostBaseUrl,
      sleepImpl,
    });
  }

  await waitForHealth(buildVersionsUrl(baseUrl), {
    label: "Matrix homeserver",
    composeFile: files.composeFile,
    fetchImpl,
    sleepImpl,
  });

  const waitForReady = async () => {
    await sleepImpl(1_000);
    await waitForDockerServiceHealth(
      MATRIX_QA_SERVICE,
      files.composeFile,
      repoRoot,
      runCommand,
      sleepImpl,
    );
    await waitForHealth(buildVersionsUrl(baseUrl), {
      label: "Matrix homeserver",
      composeFile: files.composeFile,
      fetchImpl,
      sleepImpl,
    });
  };

  return {
    ...files,
    baseUrl,
    async restartService() {
      await runCommand(
        "docker",
        ["compose", "-f", files.composeFile, "restart", MATRIX_QA_SERVICE],
        repoRoot,
      );
      await waitForReady();
    },
    stopCommand: `docker compose -f ${files.composeFile} down --remove-orphans`,
    async stop() {
      await runCommand(
        "docker",
        ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
        repoRoot,
      );
    },
  };
}

export const __testing = {
  MATRIX_QA_DEFAULT_IMAGE,
  MATRIX_QA_DEFAULT_PORT,
  MATRIX_QA_DEFAULT_SERVER_NAME,
  MATRIX_QA_SERVICE,
  buildVersionsUrl,
  isMatrixVersionsReachable,
  renderMatrixQaCompose,
  resolveMatrixQaHarnessImage,
  waitForReachableMatrixBaseUrl,
};
