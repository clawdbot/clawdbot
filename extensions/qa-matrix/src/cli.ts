import type { Command } from "commander";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createLazyCliRuntimeLoader,
  createLiveTransportQaCliRegistration,
  type LiveTransportQaCliRegistration,
  type LiveTransportQaCommandOptions,
} from "./shared/live-transport-cli.js";

type MatrixQaCliRuntime = typeof import("./cli.runtime.js");

const DISABLE_MATRIX_QA_FORCE_EXIT_ENV = "OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT";

const loadMatrixQaCliRuntime = createLazyCliRuntimeLoader<MatrixQaCliRuntime>(
  () => import("./cli.runtime.js"),
);

async function flushProcessStream(stream: NodeJS.WriteStream) {
  if (stream.destroyed || !stream.writable) {
    return;
  }
  await new Promise<void>((resolve) => {
    try {
      stream.write("", () => resolve());
    } catch {
      resolve();
    }
  });
}

async function exitMatrixQaCommand(code: number): Promise<never> {
  // Matrix crypto native handles can outlive the QA run even after every
  // client/gateway/harness has been stopped. This command is single-shot, so
  // artifact completion should terminate deterministically on both pass and fail.
  await Promise.all([flushProcessStream(process.stdout), flushProcessStream(process.stderr)]);
  process.exit(code);
}

async function runQaMatrix(opts: LiveTransportQaCommandOptions) {
  const runtime = await loadMatrixQaCliRuntime();
  if (process.env[DISABLE_MATRIX_QA_FORCE_EXIT_ENV] === "1") {
    await runtime.runQaMatrixCommand(opts);
    return;
  }
  try {
    await runtime.runQaMatrixCommand(opts);
    await exitMatrixQaCommand(0);
  } catch (error) {
    process.stderr.write(`${formatErrorMessage(error)}\n`);
    await exitMatrixQaCommand(1);
  }
}

export const matrixQaCliRegistration: LiveTransportQaCliRegistration =
  createLiveTransportQaCliRegistration({
    commandName: "matrix",
    description: "Run the Docker-backed Matrix live QA lane against a disposable homeserver",
    outputDirHelp: "Matrix QA artifact directory",
    scenarioHelp: "Run only the named Matrix QA scenario (repeatable)",
    sutAccountHelp: "Temporary Matrix account id inside the QA gateway config",
    run: runQaMatrix,
  });

export const qaRunnerCliRegistrations = [matrixQaCliRegistration] as const;

export function registerMatrixQaCli(qa: Command) {
  matrixQaCliRegistration.register(qa);
}
