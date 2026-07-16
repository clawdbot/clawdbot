// QA Lab Matrix module implements harness behavior.
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
} from "../../../docker-runtime.js";
import {
  MATRIX_QA_CLEANUP_TIMEOUT_MS,
  MATRIX_QA_DEFAULT_PORT,
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
    startRecordingProxyImpl?: typeof startMatrixQaRecordingProxy;
  },
): Promise<MatrixQaHarness> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const resolveHostPortImpl = deps?.resolveHostPortImpl ?? resolveHostPort;
  const runCommand = deps?.runCommand ?? execCommand;
  const fetchImpl = deps?.fetchImpl ?? fetchHealthUrl;
  const sleepImpl = deps?.sleepImpl ?? sleep;
  const startRecordingProxyImpl = deps?.startRecordingProxyImpl ?? startMatrixQaRecordingProxy;
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

  try {
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
    let upstreamBaseUrl = hostBaseUrl;
    const hostReachable = await isMatrixVersionsReachable(hostBaseUrl, fetchImpl);
    if (!hostReachable) {
      const containerBaseUrl = await resolveComposeServiceUrl(
        MATRIX_QA_SERVICE,
        MATRIX_QA_INTERNAL_PORT,
        files.composeFile,
        repoRoot,
        runCommand,
      );
      upstreamBaseUrl = await waitForReachableMatrixBaseUrl({
        composeFile: files.composeFile,
        containerBaseUrl,
        fetchImpl,
        hostBaseUrl,
        sleepImpl,
      });
    }

    await waitForHealth(buildVersionsUrl(upstreamBaseUrl), {
      label: "Matrix homeserver",
      composeFile: files.composeFile,
      fetchImpl,
      sleepImpl,
    });
    const recording = await startRecordingProxyImpl({ targetBaseUrl: upstreamBaseUrl });

    const waitForReady = async () => {
      await sleepImpl(1_000);
      await waitForDockerServiceHealth(
        MATRIX_QA_SERVICE,
        files.composeFile,
        repoRoot,
        runCommand,
        sleepImpl,
      );
      await waitForHealth(buildVersionsUrl(upstreamBaseUrl), {
        label: "Matrix homeserver",
        composeFile: files.composeFile,
        fetchImpl,
        sleepImpl,
      });
    };

    return {
      ...files,
      baseUrl: recording.baseUrl,
      recording,
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
        const results = await Promise.allSettled([
          recording.stop(),
          withMatrixQaHarnessTimeout(
            "Matrix homeserver cleanup",
            MATRIX_QA_CLEANUP_TIMEOUT_MS,
            runCommand(
              "docker",
              ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
              repoRoot,
            ),
          ),
        ]);
        const failures = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (failures.length > 0) {
          throw new AggregateError(failures, "Matrix QA harness cleanup failed");
        }
      },
      upstreamBaseUrl,
    };
  } catch (error) {
    try {
      await withMatrixQaHarnessTimeout(
        "Matrix homeserver cleanup after startup failure",
        MATRIX_QA_CLEANUP_TIMEOUT_MS,
        runCommand(
          "docker",
          ["compose", "-f", files.composeFile, "down", "--remove-orphans"],
          repoRoot,
        ),
      );
    } catch (cleanupError) {
      const combinedFailure = new AggregateError(
        [error, cleanupError],
        "Matrix QA harness startup and cleanup both failed",
        { cause: cleanupError },
      );
      throw combinedFailure;
    }
    throw error;
  }
}
