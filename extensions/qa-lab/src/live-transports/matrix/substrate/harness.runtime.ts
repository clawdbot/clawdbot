// QA Lab Matrix module implements harness behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import {
  execCleanupCommand,
  execCommand,
  fetchHealthUrl,
  resolveComposeServiceUrl,
  waitForDockerServiceHealth,
  waitForHealth,
  type FetchLike,
  type RunCommand,
} from "../../../docker-runtime.js";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  MATRIX_QA_INTERNAL_PORT,
  MATRIX_QA_SERVICE,
  buildVersionsUrl,
  isMatrixVersionsReachable,
  waitForReachableMatrixBaseUrl,
  withMatrixQaHarnessTimeout,
  writeMatrixQaHarnessFiles,
  type MatrixQaHarnessFiles,
} from "./harness.runtime-internals.js";
import { startMatrixQaRecordingProxy, type MatrixQaRecordingProxy } from "./recording-proxy.js";

type MatrixQaHarness = MatrixQaHarnessFiles & {
  baseUrl: string;
  recording: MatrixQaRecordingProxy;
  restartService(): Promise<void>;
  stopCommand: string;
  stop(): Promise<void>;
  upstreamBaseUrl: string;
};

async function collectCleanupFailures(
  tasks: ReadonlyArray<() => Promise<unknown>>,
): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (const task of tasks) {
    failures.push(
      ...(await task().then(
        () => [],
        (error: unknown) => [error],
      )),
    );
  }
  return failures;
}

function buildStartupCleanupError(error: unknown, cleanupFailures: unknown[]): AggregateError {
  return new AggregateError(
    [error, ...cleanupFailures],
    "Matrix QA harness startup and cleanup both failed",
    { cause: error },
  );
}

export async function startMatrixQaHarness(
  params: {
    repoRoot?: string;
    image?: string;
    homeserverPort?: number;
    serverName?: string;
  },
  deps?: {
    fetchImpl?: FetchLike;
    runCommand?: RunCommand;
    sleepImpl?: (ms: number) => Promise<unknown>;
    startRecordingProxyImpl?: typeof startMatrixQaRecordingProxy;
    removeRuntimeDirImpl?: (runtimeDir: string) => Promise<void>;
  },
): Promise<MatrixQaHarness> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const runCommand = deps?.runCommand ?? execCommand;
  const cleanupRunCommand = deps?.runCommand ?? execCleanupCommand;
  const fetchImpl = deps?.fetchImpl ?? fetchHealthUrl;
  const sleepImpl = deps?.sleepImpl ?? sleep;
  const startRecordingProxyImpl = deps?.startRecordingProxyImpl ?? startMatrixQaRecordingProxy;
  const removeRuntimeDirImpl =
    deps?.removeRuntimeDirImpl ??
    (async (runtimeDir: string) => {
      await fs.rm(runtimeDir, { force: true, recursive: true });
    });
  const requestedHomeserverPort = params.homeserverPort ?? 0;
  const tempRoot = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tempRoot, { recursive: true });
  // The compose file embeds the registration token and the data directory holds
  // live Tuwunel state, so neither belongs in the publishable QA artifact tree.
  const runtimeDir = await fs.mkdtemp(path.join(tempRoot, "openclaw-qa-matrix-harness-"));
  let files: MatrixQaHarnessFiles;
  try {
    files = await writeMatrixQaHarnessFiles({
      runtimeDir,
      image: params.image,
      homeserverPort: requestedHomeserverPort,
      serverName: params.serverName,
    });
  } catch (error) {
    const cleanupFailures = await collectCleanupFailures([() => removeRuntimeDirImpl(runtimeDir)]);
    if (cleanupFailures.length > 0) {
      throw buildStartupCleanupError(error, cleanupFailures);
    }
    throw error;
  }

  try {
    await runCommand(
      "docker",
      ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
      repoRoot,
    );
  } catch {
    // First run or already stopped.
  }

  try {
    await runCommand("docker", ["compose", "-f", files.composeFile, "up", "-d"], repoRoot);
    const publishedPortOutput = requestedHomeserverPort
      ? ""
      : (
          await runCommand(
            "docker",
            [
              "compose",
              "-f",
              files.composeFile,
              "port",
              MATRIX_QA_SERVICE,
              String(MATRIX_QA_INTERNAL_PORT),
            ],
            repoRoot,
          )
        ).stdout;
    const homeserverPort =
      requestedHomeserverPort || parseMatrixQaPublishedPort(publishedPortOutput);
    const resolveReadyUpstreamBaseUrl = async (publishedPort: number) => {
      await sleepImpl(1_000);
      await waitForDockerServiceHealth(
        MATRIX_QA_SERVICE,
        files.composeFile,
        repoRoot,
        runCommand,
        sleepImpl,
      );
      const hostBaseUrl = `http://127.0.0.1:${publishedPort}/`;
      let readyBaseUrl = hostBaseUrl;
      if (!(await isMatrixVersionsReachable(hostBaseUrl, fetchImpl))) {
        const containerBaseUrl = await resolveComposeServiceUrl(
          MATRIX_QA_SERVICE,
          MATRIX_QA_INTERNAL_PORT,
          files.composeFile,
          repoRoot,
          runCommand,
        );
        readyBaseUrl = await waitForReachableMatrixBaseUrl({
          composeFile: files.composeFile,
          containerBaseUrl,
          fetchImpl,
          hostBaseUrl,
          sleepImpl,
        });
      }
      await waitForHealth(buildVersionsUrl(readyBaseUrl), {
        label: "Matrix homeserver",
        composeFile: files.composeFile,
        fetchImpl,
        sleepImpl,
      });
      return readyBaseUrl;
    };
    let upstreamBaseUrl = await resolveReadyUpstreamBaseUrl(homeserverPort);
    const recording = await startRecordingProxyImpl({ targetBaseUrl: upstreamBaseUrl });

    return {
      ...files,
      homeserverPort,
      baseUrl: recording.baseUrl,
      recording,
      async restartService() {
        await withMatrixQaHarnessTimeout(
          "Matrix homeserver restart",
          MATRIX_QA_CLEANUP_TIMEOUT_MS,
          (async () => {
            await runCommand(
              "docker",
              ["compose", "-f", files.composeFile, "restart", MATRIX_QA_SERVICE],
              repoRoot,
            );
            const restartedPort = requestedHomeserverPort
              ? homeserverPort
              : parseMatrixQaPublishedPort(
                  (
                    await runCommand(
                      "docker",
                      [
                        "compose",
                        "-f",
                        files.composeFile,
                        "port",
                        MATRIX_QA_SERVICE,
                        String(MATRIX_QA_INTERNAL_PORT),
                      ],
                      repoRoot,
                    )
                  ).stdout,
                );
            upstreamBaseUrl = await resolveReadyUpstreamBaseUrl(restartedPort);
            recording.setTargetBaseUrl(upstreamBaseUrl);
          })(),
        );
      },
      stopCommand: `docker compose -f ${files.composeFile} down --remove-orphans`,
      async stop() {
        const failures = await collectCleanupFailures([
          () => recording.stop(),
          () =>
            cleanupRunCommand(
              "docker",
              ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
              repoRoot,
            ),
          () => removeRuntimeDirImpl(runtimeDir),
        ]);
        if (failures.length === 1) {
          throw failures[0];
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, "Matrix QA harness cleanup failed", {
            cause: failures[0],
          });
        }
      },
      get upstreamBaseUrl() {
        return upstreamBaseUrl;
      },
    };
  } catch (error) {
    const cleanupFailures = await collectCleanupFailures([
      () =>
        cleanupRunCommand(
          "docker",
          ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
          repoRoot,
        ),
      () => removeRuntimeDirImpl(runtimeDir),
    ]);
    if (cleanupFailures.length > 0) {
      throw buildStartupCleanupError(error, cleanupFailures);
    }
    throw error;
  }
}

function parseMatrixQaPublishedPort(output: string): number {
  const port = Number.parseInt(
    output
      .trim()
      .split(/\r?\n/, 1)[0]
      ?.match(/:(\d+)$/)?.[1] ?? "",
    10,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Unable to resolve Matrix QA published port from Docker output: ${output.trim()}`,
    );
  }
  return port;
}
