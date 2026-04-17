import { runMatrixQaLive } from "./runners/contract/runtime.js";
import type { LiveTransportQaCommandOptions } from "./shared/live-transport-cli.js";
import {
  printLiveTransportQaArtifacts,
  resolveLiveTransportQaRunOptions,
  startLiveTransportQaOutputTee,
} from "./shared/live-transport-cli.runtime.js";

const RUN_NODE_OUTPUT_LOG_ENV = "OPENCLAW_RUN_NODE_OUTPUT_LOG";

async function closeMatrixQaCommandFetchHandles() {
  try {
    const { getGlobalDispatcher } = await import("undici");
    const dispatcher = getGlobalDispatcher() as {
      close?: () => Promise<void> | void;
    };
    await dispatcher.close?.();
  } catch {
    // Best-effort cleanup for short-lived QA commands. The command result and
    // artifacts are already written; stale fetch keep-alive handles should not
    // turn a green run into a failure.
  }
}

function formatMatrixQaOutputTeeError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "unknown error";
}

async function createMatrixQaCommandOutputTee(outputDir: string) {
  const inheritedOutputPath = process.env[RUN_NODE_OUTPUT_LOG_ENV]?.trim();
  if (inheritedOutputPath) {
    return {
      outputPath: inheritedOutputPath,
      async stop() {},
    };
  }

  return await startLiveTransportQaOutputTee({
    fileName: "matrix-qa-output.log",
    outputDir,
  });
}

export async function runQaMatrixCommand(opts: LiveTransportQaCommandOptions) {
  const runOptions = resolveLiveTransportQaRunOptions(opts);
  const credentialSource = runOptions.credentialSource?.toLowerCase();
  if (credentialSource && credentialSource !== "env") {
    throw new Error(
      "Matrix QA currently supports only --credential-source env (disposable local harness).",
    );
  }

  const outputTee = await createMatrixQaCommandOutputTee(runOptions.outputDir);
  let primaryError: unknown;
  let outputTeeError: unknown;
  try {
    process.stdout.write(`Matrix QA output: ${outputTee.outputPath}\n`);
    const result = await runMatrixQaLive(runOptions);
    printLiveTransportQaArtifacts("Matrix QA", {
      report: result.reportPath,
      summary: result.summaryPath,
      "observed events": result.observedEventsPath,
    });
  } catch (error) {
    primaryError = error;
  } finally {
    try {
      await outputTee.stop();
    } catch (error) {
      outputTeeError = error;
    }
    await closeMatrixQaCommandFetchHandles();
  }
  if (primaryError) {
    if (outputTeeError) {
      process.stderr.write(
        `Matrix QA output log error: ${formatMatrixQaOutputTeeError(outputTeeError)}\n`,
      );
    }
    throw primaryError;
  }
  if (outputTeeError) {
    throw outputTeeError;
  }
}
